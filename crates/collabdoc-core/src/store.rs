//! Keeping documents on disk, for every front end: the port of
//! `src/main/persist` (drafts, autosave, recents, recovery, Markdown in and
//! out) plus an update journal.
//!
//! - **Drafts.** A new document lives in `<user data>/drafts/<docId>.collabdoc`
//!   until it is saved somewhere, so it is never only in memory.
//! - **Autosave.** 2 s after the last edit, and never more than 30 s after the
//!   first unsaved one, the whole document is written atomically (temporary
//!   file, fsync, rename).
//! - **Journal.** Every change is also appended to
//!   `<user data>/journal/<docId>.updates` as Loro update bytes, and the
//!   journal is emptied by each full save. A killed process loses nothing (the
//!   appends are in the OS already); the journal is fsynced at least every
//!   second, so even a machine crash loses at most about a second. Opening the
//!   file or recovering the draft replays what the journal holds beyond it.
//! - **Recents** are `<user data>/recents.json`, the same shape as the TS app's.
//!
//! The store works on the authoritative Loro doc (the hub's), and takes the
//! time as an argument so tests can drive it.

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use loro::{ExportMode, LoroDoc, LoroValue, VersionVector};
use serde::{Deserialize, Serialize};

use crate::document::{Document, meta_string};
use crate::file::{self, Asset};
use crate::markdown;
use crate::tree;

pub const AUTOSAVE_IDLE_MS: i64 = 2_000;
pub const AUTOSAVE_MAX_MS: i64 = 30_000;
/// The journal reaches the disk at least this often while edits come in.
pub const JOURNAL_SYNC_MS: i64 = 1_000;
pub const RECENTS_LIMIT: usize = 50;
pub const RECENTS_ENTRY_MAX_BYTES: usize = 1024;
pub const PREVIEW_CHARS: usize = 120;

// ── Paths ───────────────────────────────────────────────────────────────

pub fn drafts_dir(user_data: &Path) -> PathBuf {
    user_data.join("drafts")
}

pub fn draft_path(user_data: &Path, doc_id: &str) -> PathBuf {
    drafts_dir(user_data).join(format!("{doc_id}.collabdoc"))
}

pub fn journal_path(user_data: &Path, doc_id: &str) -> PathBuf {
    user_data.join("journal").join(format!("{doc_id}.updates"))
}

pub fn recents_path(user_data: &Path) -> PathBuf {
    user_data.join("recents.json")
}

/// `<documents>/<title>.collabdoc`, the first Save As suggestion.
pub fn default_collabdoc_path(documents_dir: &Path, title: &str) -> PathBuf {
    documents_dir.join(format!("{}.collabdoc", safe_file_name(title)))
}

/// `notes.md` → `notes.collabdoc`: where an imported file is saved.
pub fn twin_collabdoc_path(markdown: &Path) -> PathBuf {
    match markdown.extension().and_then(|e| e.to_str()) {
        Some(ext) if ["md", "markdown", "txt"].contains(&ext.to_ascii_lowercase().as_str()) => {
            markdown.with_extension("collabdoc")
        }
        _ => {
            let mut name = markdown.as_os_str().to_owned();
            name.push(".collabdoc");
            PathBuf::from(name)
        }
    }
}

/// A title as a file name: control characters and `<>:"/\|?*` dropped.
pub fn safe_file_name(title: &str) -> String {
    let kept: String = title
        .chars()
        .filter(|c| (*c as u32) >= 32 && !"<>:\"/\\|?*".contains(*c))
        .collect();
    let kept = kept.trim();
    if kept.is_empty() {
        "Untitled".into()
    } else {
        kept.into()
    }
}

/// Where drafts, the journal and recents live: the platform's data folder.
pub fn default_user_data() -> PathBuf {
    let var = |k| {
        std::env::var_os(k)
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
    };
    let home = var("HOME")
        .or_else(|| var("USERPROFILE"))
        .unwrap_or_else(|| ".".into());
    if cfg!(windows) {
        var("APPDATA").unwrap_or(home).join("CollabDoc")
    } else if cfg!(target_os = "macos") {
        home.join("Library/Application Support/CollabDoc")
    } else {
        var("XDG_DATA_HOME")
            .unwrap_or_else(|| home.join(".local/share"))
            .join("collabdoc")
    }
}

/// `~/Documents/CollabDoc`, where Save As starts.
pub fn default_documents_dir() -> PathBuf {
    let var = |k| {
        std::env::var_os(k)
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
    };
    var("XDG_DOCUMENTS_DIR")
        .or_else(|| {
            var("HOME")
                .or_else(|| var("USERPROFILE"))
                .map(|h| h.join("Documents"))
        })
        .unwrap_or_else(|| ".".into())
        .join("CollabDoc")
}

// ── Atomic writes ───────────────────────────────────────────────────────

/// Writes `bytes` to `path` as write temporary → fsync → rename, so a crash
/// leaves either the old file or the new one, never half of one.
pub fn atomic_write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    atomic_write_with(path, bytes, false)
}

/// [`atomic_write`]; `fail_before_rename` stops after the fsync (tests).
pub fn atomic_write_with(path: &Path, bytes: &[u8], fail_before_rename: bool) -> io::Result<()> {
    let dir = path.parent().filter(|d| !d.as_os_str().is_empty());
    if let Some(dir) = dir {
        fs::create_dir_all(dir)?;
    }
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    {
        let mut file = File::create(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    if fail_before_rename {
        return Err(io::Error::other("simulated failure before rename"));
    }
    if let Err(error) = fs::rename(&tmp, path) {
        // Windows cannot rename over an existing file: step it aside first.
        let mut bak = path.as_os_str().to_owned();
        bak.push(".bak");
        let bak = PathBuf::from(bak);
        if fs::rename(path, &bak).is_err() {
            return Err(error);
        }
        fs::rename(&tmp, path)?;
        let _ = fs::remove_file(&bak);
    }
    #[cfg(unix)]
    if let Some(dir) = dir {
        // The rename itself reaches the disk.
        let _ = File::open(dir).and_then(|d| d.sync_all());
    }
    Ok(())
}

// ── Autosave timing ─────────────────────────────────────────────────────

/// When to write: `idle` after the last edit, never more than `max` after the
/// first unsaved one (`AutosaveScheduler`, without its timers: the front end
/// asks [`Autosave::due`]).
#[derive(Debug, Clone, Copy)]
pub struct Autosave {
    idle: i64,
    max: i64,
    first: Option<i64>,
    last: Option<i64>,
}

impl Autosave {
    pub fn new(idle_ms: i64, max_ms: i64) -> Self {
        Self {
            idle: idle_ms,
            max: max_ms,
            first: None,
            last: None,
        }
    }

    pub fn touch(&mut self, now: i64) {
        self.first.get_or_insert(now);
        self.last = Some(now);
    }

    /// When the next write is due, if anything is waiting.
    pub fn due_at(&self) -> Option<i64> {
        Some((self.last? + self.idle).min(self.first? + self.max))
    }

    pub fn due(&self, now: i64) -> bool {
        self.due_at().is_some_and(|at| now >= at)
    }

    pub fn clear(&mut self) {
        self.first = None;
        self.last = None;
    }
}

// ── Recents ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentRecord {
    pub doc_id: String,
    pub title: String,
    /// `None` for a draft (never saved anywhere).
    pub path: Option<String>,
    /// ISO 8601, as the TS app writes it.
    pub updated_at: String,
    #[serde(default)]
    pub preview: String,
}

#[derive(Serialize, Deserialize)]
struct RecentsFile {
    recents: Vec<serde_json::Value>,
}

fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// The first `n` UTF-16 units of `s` (JS `slice(0, n)`), never half a pair.
fn js_head(s: &str, n: usize) -> String {
    let mut used = 0;
    s.chars()
        .take_while(|c| {
            used += c.len_utf16();
            used <= n
        })
        .collect()
}

/// The last `n` UTF-16 units of `s`.
fn js_tail(s: &str, n: usize) -> String {
    let mut used = 0;
    let mut out: Vec<char> = s
        .chars()
        .rev()
        .take_while(|c| {
            used += c.len_utf16();
            used <= n
        })
        .collect();
    out.reverse();
    out.into_iter().collect()
}

fn json_len(entry: &RecentRecord) -> usize {
    js_len(&serde_json::to_string(entry).expect("recent serialises"))
}

/// Keeps an entry under 1 KB: title and preview cut, then the path's start.
pub fn cap_recent(entry: &RecentRecord) -> RecentRecord {
    let mut next = RecentRecord {
        doc_id: entry.doc_id.clone(),
        title: js_head(&entry.title, 200),
        path: entry.path.clone(),
        updated_at: entry.updated_at.clone(),
        preview: js_head(&entry.preview, PREVIEW_CHARS),
    };
    while json_len(&next) > RECENTS_ENTRY_MAX_BYTES && !next.preview.is_empty() {
        let keep = js_len(&next.preview).saturating_sub(16);
        next.preview = js_head(&next.preview, keep);
    }
    let len = json_len(&next);
    if len > RECENTS_ENTRY_MAX_BYTES
        && let Some(path) = &next.path
        && js_len(path) > 80
    {
        let keep = (RECENTS_ENTRY_MAX_BYTES + js_len(path)).saturating_sub(len + 1);
        next.path = Some(format!("…{}", js_tail(path, keep)));
    }
    next
}

/// `entry` first, replacing older entries for its document or its path; the
/// newest 50.
pub fn upsert_recent(recents: &[RecentRecord], entry: &RecentRecord) -> Vec<RecentRecord> {
    let capped = cap_recent(entry);
    let mut out: Vec<RecentRecord> = recents
        .iter()
        .filter(|r| r.doc_id != capped.doc_id && (capped.path.is_none() || r.path != capped.path))
        .cloned()
        .collect();
    out.push(capped);
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    out.truncate(RECENTS_LIMIT);
    out
}

/// The recents in `path`; a missing or damaged file is an empty list.
pub fn load_recents(path: &Path) -> Vec<RecentRecord> {
    let Ok(raw) = fs::read(path) else {
        return vec![];
    };
    let Ok(file) = serde_json::from_slice::<RecentsFile>(&raw) else {
        return vec![];
    };
    file.recents
        .into_iter()
        .filter_map(|v| serde_json::from_value::<RecentRecord>(v).ok())
        .map(|r| cap_recent(&r))
        .collect()
}

pub fn save_recents(path: &Path, recents: &[RecentRecord]) -> io::Result<()> {
    let list: Vec<serde_json::Value> = recents
        .iter()
        .take(RECENTS_LIMIT)
        .map(|r| serde_json::to_value(cap_recent(r)).expect("recent serialises"))
        .collect();
    let json = serde_json::to_string_pretty(&RecentsFile { recents: list })?;
    atomic_write(path, json.as_bytes())
}

// ── Time ────────────────────────────────────────────────────────────────

/// Milliseconds since the epoch as `2026-10-24T18:12:16.123Z` (JS `toISOString`).
pub fn iso8601(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    let rest = ms.rem_euclid(86_400_000);
    // Days to civil date (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rest / 3_600_000,
        rest / 60_000 % 60,
        rest / 1000 % 60,
        rest % 1000
    )
}

/// The inverse of [`iso8601`] (UTC `Z` times only, as recents hold).
pub fn parse_iso8601(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 20 || b[4] != b'-' || b[10] != b'T' || !s.ends_with('Z') {
        return None;
    }
    let num = |r: std::ops::Range<usize>| s.get(r)?.parse::<i64>().ok();
    let (year, month, day) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (hour, minute, second) = (num(11..13)?, num(14..16)?, num(17..19)?);
    let millis = if b[19] == b'.' {
        num(20..23).unwrap_or(0)
    } else {
        0
    };
    // Civil date to days (the inverse of the algorithm above).
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = if month > 2 { month - 3 } else { month + 9 };
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(((days * 24 + hour) * 60 + minute) * 60_000 + second * 1000 + millis)
}

// ── Journal ─────────────────────────────────────────────────────────────

/// Each frame: length (u32 LE), FNV-1a hash of the bytes (u64 LE), bytes.
/// Frame 0 says which file the updates belong to (JSON `{"path": …}`).
fn frame(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(12 + bytes.len());
    out.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
    out.extend_from_slice(&fnv1a(bytes).to_le_bytes());
    out.extend_from_slice(bytes);
    out
}

fn fnv1a(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325, |h, b| {
        (h ^ u64::from(*b)).wrapping_mul(0x0100_0000_01b3)
    })
}

/// The frames of a journal file, stopping at a torn or damaged one (the
/// moment a crash cut a write short).
pub fn read_journal(path: &Path) -> Vec<Vec<u8>> {
    let Ok(bytes) = fs::read(path) else {
        return vec![];
    };
    let mut frames = vec![];
    let mut at = 0;
    while at + 12 <= bytes.len() {
        let len = u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap()) as usize;
        let hash = u64::from_le_bytes(bytes[at + 4..at + 12].try_into().unwrap());
        let Some(body) = bytes.get(at + 12..at + 12 + len) else {
            break;
        };
        if fnv1a(body) != hash {
            break;
        }
        frames.push(body.to_vec());
        at += 12 + len;
    }
    frames
}

#[derive(Serialize, Deserialize)]
struct JournalHead {
    path: Option<String>,
}

/// The updates a journal holds for the file at `path` (`None`: the draft).
fn journal_updates(user_data: &Path, doc_id: &str, path: Option<&Path>) -> Vec<Vec<u8>> {
    let mut frames = read_journal(&journal_path(user_data, doc_id)).into_iter();
    let Some(head) = frames.next() else {
        return vec![];
    };
    let Ok(head) = serde_json::from_slice::<JournalHead>(&head) else {
        return vec![];
    };
    // A copy of the file elsewhere shares the docId, not the edits.
    if head.path.as_deref() != path.map(path_string).as_deref() {
        return vec![];
    }
    frames.collect()
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

// ── The store ───────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct StoreConfig {
    pub user_data: PathBuf,
    pub documents_dir: PathBuf,
    pub idle_ms: i64,
    pub max_ms: i64,
}

impl StoreConfig {
    pub fn new(user_data: PathBuf, documents_dir: PathBuf) -> Self {
        Self {
            user_data,
            documents_dir,
            idle_ms: AUTOSAVE_IDLE_MS,
            max_ms: AUTOSAVE_MAX_MS,
        }
    }

    /// The platform's folders.
    pub fn for_user() -> Self {
        Self::new(default_user_data(), default_documents_dir())
    }
}

/// What the UI shows about an open document.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistState {
    pub doc_id: String,
    pub title: String,
    /// `None` for a draft.
    pub path: Option<String>,
    pub is_draft: bool,
    pub dirty: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentListing {
    #[serde(flatten)]
    pub record: RecentRecord,
    /// The file is gone (moved or deleted).
    pub missing: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryOffer {
    pub doc_id: String,
    pub title: String,
    pub updated_at: String,
    pub preview: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Listing {
    pub recents: Vec<RecentListing>,
    pub recoveries: Vec<RecoveryOffer>,
}

pub enum SaveOutcome {
    Saved(PathBuf),
    /// A draft: the user picks a place first ([`Store::save_to`]).
    NeedsSaveAs,
}

/// A document read from disk, with what the journal added and what the file
/// lacked.
pub struct Opened {
    pub document: Document,
    /// Edits made after the file's last save, replayed from the journal.
    pub recovered_edits: bool,
    pub warnings: Vec<String>,
}

struct Tracked {
    /// `None` while a draft.
    path: Option<PathBuf>,
    saved: VersionVector,
    journaled: VersionVector,
    journal: Option<File>,
    /// When the journal last got bytes the disk may not have yet.
    unsynced_since: Option<i64>,
    autosave: Autosave,
    /// Where Save As starts (the twin of an imported Markdown file).
    suggested: Option<PathBuf>,
    assets: Vec<Asset>,
}

pub struct Store {
    config: StoreConfig,
    recents: Vec<RecentRecord>,
    tracked: HashMap<String, Tracked>,
}

impl Store {
    pub fn open(config: StoreConfig) -> Self {
        let recents = load_recents(&recents_path(&config.user_data));
        Self {
            config,
            recents,
            tracked: HashMap::new(),
        }
    }

    pub fn config(&self) -> &StoreConfig {
        &self.config
    }

    /// A new, untitled document. Its draft file exists at once, so nothing is
    /// only in memory; it joins the recents once it has content.
    pub fn create(&mut self, title: &str, actor: &str, now: i64) -> io::Result<Document> {
        let document = Document::create(title, actor);
        let draft = draft_path(&self.config.user_data, &document.doc_id());
        atomic_write(&draft, &encode(document.loro(), &[], now))?;
        self.track(document.loro(), None, vec![])?;
        Ok(document)
    }

    /// Opens a `.collabdoc`, or imports Markdown (`.md`, `.markdown`, `.txt`).
    pub fn open_path(&mut self, path: &Path, actor: &str, now: i64) -> Result<Opened, String> {
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if ["md", "markdown", "txt"].contains(&ext.as_str()) {
            return self.import_markdown(path, actor, now);
        }
        self.open_collabdoc(path, actor, now)
    }

    pub fn open_collabdoc(&mut self, path: &Path, actor: &str, now: i64) -> Result<Opened, String> {
        let bytes =
            fs::read(path).map_err(|e| format!("Could not read {}: {e}", path.display()))?;
        let opened = self.load(&bytes, Some(path), actor)?;
        self.track(
            opened.document.loro(),
            Some(path.to_owned()),
            opened.document.assets().to_vec(),
        )
        .map_err(|e| e.to_string())?;
        if opened.recovered_edits {
            self.mark_unsaved(opened.document.loro(), now);
        }
        self.touch_recent(opened.document.loro(), Some(path), now)
            .map_err(|e| e.to_string())?;
        Ok(opened)
    }

    /// A draft left by a crash (or reopened from the recents).
    pub fn recover(&mut self, doc_id: &str, actor: &str, now: i64) -> Result<Opened, String> {
        let draft = draft_path(&self.config.user_data, doc_id);
        let bytes = fs::read(&draft).map_err(|e| format!("Could not read the draft: {e}"))?;
        let opened = self.load(&bytes, None, actor)?;
        self.track(
            opened.document.loro(),
            None,
            opened.document.assets().to_vec(),
        )
        .map_err(|e| e.to_string())?;
        if opened.recovered_edits {
            self.mark_unsaved(opened.document.loro(), now);
        }
        Ok(opened)
    }

    /// A new draft from a Markdown file: the first `# ` line is the title, the
    /// rest the body; Save As suggests `notes.collabdoc` next to `notes.md`,
    /// and the Markdown file is never written.
    pub fn import_markdown(
        &mut self,
        path: &Path,
        actor: &str,
        now: i64,
    ) -> Result<Opened, String> {
        let raw = fs::read_to_string(path)
            .map_err(|e| format!("Could not read {}: {e}", path.display()))?;
        let fallback = path
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "Untitled".into());
        let (title, body) = split_title(&raw, &fallback);
        let mut editor = crate::editing::Editor::new(Document::create(&title, actor));
        if !body.trim().is_empty() {
            if markdown::looks_like_markdown(&body) {
                editor.paste(&body);
            } else {
                editor.insert_text(body.trim_end_matches('\n'));
            }
        }
        let mut document = editor.into_document();
        // Images an export wrote beside the file (`assets/<hash>.<ext>`).
        if let Some(dir) = path.parent() {
            for hash in referenced_assets(document.loro()) {
                if document.asset(&hash).is_none()
                    && let Some(bytes) = asset_file(&dir.join("assets"), &hash)
                {
                    let _ = document.put_asset(bytes);
                }
            }
        }
        document.take_new_assets();
        // The import is where the document starts, not an edit to undo.
        document.clear_history();
        let draft = draft_path(&self.config.user_data, &document.doc_id());
        let assets = document.assets().to_vec();
        atomic_write(&draft, &encode(document.loro(), &assets, now)).map_err(|e| e.to_string())?;
        self.track(document.loro(), None, assets)
            .map_err(|e| e.to_string())?;
        if let Some(t) = self.tracked.get_mut(&document.doc_id()) {
            t.suggested = Some(twin_collabdoc_path(path));
        }
        self.touch_recent(document.loro(), None, now)
            .map_err(|e| e.to_string())?;
        Ok(Opened {
            document,
            recovered_edits: false,
            warnings: vec![],
        })
    }

    /// After every change to `doc`: the change goes to the journal at once,
    /// and the autosave clock starts.
    pub fn changed(&mut self, doc: &LoroDoc, now: i64) -> io::Result<()> {
        let id = meta_string(doc, "docId");
        let Some(t) = self.tracked.get_mut(&id) else {
            return Ok(());
        };
        let version = doc.oplog_vv();
        if version != t.journaled {
            let updates = doc
                .export(ExportMode::updates(&t.journaled))
                .map_err(|e| io::Error::other(e.to_string()))?;
            if let Some(journal) = &mut t.journal {
                journal.write_all(&frame(&updates))?;
                t.unsynced_since.get_or_insert(now);
            }
            t.journaled = version.clone();
        }
        if version != t.saved {
            t.autosave.touch(now);
        }
        Self::sync_if_due(t, now)
    }

    /// Call every few hundred milliseconds: syncs the journal and writes the
    /// document when autosave is due. Returns whether it wrote.
    pub fn tick(&mut self, doc: &LoroDoc, now: i64) -> io::Result<bool> {
        let id = meta_string(doc, "docId");
        let Some(t) = self.tracked.get_mut(&id) else {
            return Ok(false);
        };
        Self::sync_if_due(t, now)?;
        if !t.autosave.due(now) {
            return Ok(false);
        }
        self.write(doc, now)?;
        Ok(true)
    }

    /// When [`Store::tick`] next has work, if any.
    pub fn next_tick(&self, doc_id: &str) -> Option<i64> {
        let t = self.tracked.get(doc_id)?;
        let sync = t.unsynced_since.map(|at| at + JOURNAL_SYNC_MS);
        match (t.autosave.due_at(), sync) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        }
    }

    /// Ctrl+S: writes now, or asks for a place if it is a draft.
    pub fn save(&mut self, doc: &LoroDoc, now: i64) -> io::Result<SaveOutcome> {
        let id = meta_string(doc, "docId");
        match self.tracked.get(&id).and_then(|t| t.path.clone()) {
            Some(path) => {
                self.write(doc, now)?;
                Ok(SaveOutcome::Saved(path))
            }
            None => Ok(SaveOutcome::NeedsSaveAs),
        }
    }

    /// Save As: the document lives at `path` from now on; a draft it was
    /// is deleted.
    pub fn save_to(&mut self, doc: &LoroDoc, path: &Path, now: i64) -> io::Result<()> {
        let id = meta_string(doc, "docId");
        let Some(t) = self.tracked.get_mut(&id) else {
            return Err(io::Error::other("the document is not open"));
        };
        let was_draft = t.path.is_none();
        t.path = Some(path.to_owned());
        t.suggested = None;
        self.write(doc, now)?;
        if was_draft {
            let _ = fs::remove_file(draft_path(&self.config.user_data, &id));
        }
        Ok(())
    }

    /// Where Save As starts for `doc`.
    pub fn suggested_path(&self, doc: &LoroDoc) -> PathBuf {
        let id = meta_string(doc, "docId");
        let t = self.tracked.get(&id);
        t.and_then(|t| t.suggested.clone().or_else(|| t.path.clone()))
            .unwrap_or_else(|| {
                default_collabdoc_path(&self.config.documents_dir, &meta_string(doc, "title"))
            })
    }

    pub fn state(&self, doc: &LoroDoc) -> Option<PersistState> {
        let id = meta_string(doc, "docId");
        let t = self.tracked.get(&id)?;
        Some(PersistState {
            title: meta_string(doc, "title"),
            path: t.path.as_deref().map(path_string),
            is_draft: t.path.is_none(),
            dirty: doc.oplog_vv() != t.saved,
            doc_id: id,
        })
    }

    /// Closing a document: what is unsaved is written, and a draft nobody
    /// typed into is not kept.
    pub fn release(&mut self, doc: &LoroDoc, now: i64) -> io::Result<()> {
        let id = meta_string(doc, "docId");
        let Some(t) = self.tracked.get(&id) else {
            return Ok(());
        };
        let is_draft = t.path.is_none();
        if is_draft && document_is_empty(doc) && !self.recents.iter().any(|r| r.doc_id == id) {
            self.tracked.remove(&id);
            let _ = fs::remove_file(draft_path(&self.config.user_data, &id));
            let _ = fs::remove_file(journal_path(&self.config.user_data, &id));
            return Ok(());
        }
        if doc.oplog_vv() != t.saved {
            self.write(doc, now)?;
        }
        self.tracked.remove(&id);
        // Saved: nothing in the journal is newer than the file.
        let _ = fs::remove_file(journal_path(&self.config.user_data, &id));
        Ok(())
    }

    /// "Don't save" on a draft: it is gone, from disk and the recents.
    pub fn discard_draft(&mut self, doc_id: &str) -> io::Result<()> {
        self.tracked.remove(doc_id);
        let _ = fs::remove_file(draft_path(&self.config.user_data, doc_id));
        let _ = fs::remove_file(journal_path(&self.config.user_data, doc_id));
        self.remove_recent(doc_id)
    }

    pub fn remove_recent(&mut self, doc_id: &str) -> io::Result<()> {
        self.recents.retain(|r| r.doc_id != doc_id);
        self.persist_recents()
    }

    /// The start screen: recents (newest first, missing files marked) and
    /// drafts a crash left behind.
    pub fn listing(&self) -> Listing {
        let mut recents: Vec<RecentListing> = self
            .recents
            .iter()
            .map(|r| RecentListing {
                missing: r.path.as_ref().is_some_and(|p| !Path::new(p).exists()),
                record: r.clone(),
            })
            .collect();
        recents.sort_by(|a, b| b.record.updated_at.cmp(&a.record.updated_at));
        Listing {
            recents,
            recoveries: self.recoveries(),
        }
    }

    /// Markdown for `document`, with the title as its first heading (as the
    /// TS app's `serializeDocument`).
    /// Image bytes added to `doc` (an insert, a paste): kept with it, and
    /// written to its file or draft at once, so no image is ever only in
    /// memory while the journal already points at it.
    pub fn put_assets(&mut self, doc: &LoroDoc, assets: Vec<Asset>, now: i64) -> io::Result<()> {
        let id = meta_string(doc, "docId");
        let Some(t) = self.tracked.get_mut(&id) else {
            return Ok(());
        };
        let mut added = false;
        for asset in assets {
            if !t.assets.iter().any(|a| a.hash == asset.hash) {
                t.assets.push(asset);
                added = true;
            }
        }
        if added {
            self.write(doc, now)?;
        }
        Ok(())
    }

    /// The bytes of image `hash` in the open document `doc_id`.
    pub fn asset(&self, doc_id: &str, hash: &str) -> Option<&Asset> {
        self.tracked
            .get(doc_id)?
            .assets
            .iter()
            .find(|a| a.hash == hash)
    }

    /// Every asset the open document `doc_id` has.
    pub fn assets_of(&self, doc_id: &str) -> &[Asset] {
        self.tracked
            .get(doc_id)
            .map_or(&[], |t| t.assets.as_slice())
    }

    /// The document as one Markdown file: images inline as `data:` URIs.
    pub fn markdown_of(document: &Document) -> String {
        let body = markdown::render_with(&document.blocks(), document.assets(), true);
        let first = body.lines().next().unwrap_or("");
        if first.starts_with("# ") {
            return format!("{}\n", body.trim_end());
        }
        let title = document.title();
        let title = if title.trim().is_empty() {
            "Untitled"
        } else {
            title.trim()
        };
        format!("# {title}\n\n{body}").trim_end().to_owned() + "\n"
    }

    pub fn export_markdown(document: &Document, path: &Path) -> io::Result<()> {
        atomic_write(path, Self::markdown_of(document).as_bytes())
    }

    // ── Inside ──

    fn load(&self, bytes: &[u8], path: Option<&Path>, actor: &str) -> Result<Opened, String> {
        let decoded = file::decode(bytes).map_err(|e| e.to_string())?;
        let mut document =
            Document::from_snapshot(&decoded.snapshot, actor).map_err(|e| e.to_string())?;
        let mut assets = decoded.assets;
        let mut warnings = vec![];
        if !decoded.missing.is_empty() {
            warnings.push("truncated-assets".to_owned());
        }
        let id = document.doc_id();
        let mut recovered_edits = false;
        for update in journal_updates(&self.config.user_data, &id, path) {
            match document.import(&update) {
                Ok(changed) => recovered_edits |= changed,
                Err(_) => break,
            }
        }
        // Edits from the journal are not undo steps of this session.
        document.clear_history();
        assets.retain(|a| !a.bytes.is_empty());
        let document = document.with_assets(assets);
        Ok(Opened {
            document,
            recovered_edits,
            warnings,
        })
    }

    /// Starts tracking `doc` as saved at its current version, with a fresh
    /// journal (or the journal it was recovered from, extended).
    fn track(
        &mut self,
        doc: &LoroDoc,
        path: Option<PathBuf>,
        assets: Vec<Asset>,
    ) -> io::Result<()> {
        let id = meta_string(doc, "docId");
        let version = doc.oplog_vv();
        let journal_file = journal_path(&self.config.user_data, &id);
        let keep = !journal_updates(&self.config.user_data, &id, path.as_deref()).is_empty();
        let journal = open_journal(&journal_file, path.as_deref(), keep)?;
        self.tracked.insert(
            id,
            Tracked {
                path,
                saved: version.clone(),
                journaled: version,
                journal: Some(journal),
                unsynced_since: None,
                autosave: Autosave::new(self.config.idle_ms, self.config.max_ms),
                suggested: None,
                assets,
            },
        );
        Ok(())
    }

    /// Edits the journal replayed are unsaved: the file is behind.
    fn mark_unsaved(&mut self, doc: &LoroDoc, now: i64) {
        let id = meta_string(doc, "docId");
        if let Some(t) = self.tracked.get_mut(&id) {
            // Saved = what the file holds; the replayed edits are on top.
            t.saved = VersionVector::new();
            t.autosave.touch(now);
        }
    }

    fn sync_if_due(t: &mut Tracked, now: i64) -> io::Result<()> {
        if let (Some(since), Some(journal)) = (t.unsynced_since, &t.journal)
            && now - since >= JOURNAL_SYNC_MS
        {
            journal.sync_data()?;
            t.unsynced_since = None;
        }
        Ok(())
    }

    /// Writes the whole document to its file (or its draft), empties the
    /// journal and updates the recents.
    fn write(&mut self, doc: &LoroDoc, now: i64) -> io::Result<()> {
        let id = meta_string(doc, "docId");
        let Some(t) = self.tracked.get_mut(&id) else {
            return Ok(());
        };
        let target = t
            .path
            .clone()
            .unwrap_or_else(|| draft_path(&self.config.user_data, &id));
        let referenced = referenced_assets(doc);
        let assets: Vec<Asset> = t
            .assets
            .iter()
            .filter(|a| referenced.contains(&a.hash))
            .cloned()
            .collect();
        atomic_write(&target, &encode(doc, &assets, now))?;
        let version = doc.oplog_vv();
        t.saved = version.clone();
        t.journaled = version;
        t.autosave.clear();
        t.unsynced_since = None;
        let journal = open_journal(
            &journal_path(&self.config.user_data, &id),
            t.path.as_deref(),
            false,
        )?;
        t.journal = Some(journal);
        let path = t.path.clone();
        if path.is_some() || !document_is_empty(doc) {
            self.touch_recent(doc, path.as_deref(), now)?;
        }
        Ok(())
    }

    fn touch_recent(&mut self, doc: &LoroDoc, path: Option<&Path>, now: i64) -> io::Result<()> {
        let entry = RecentRecord {
            doc_id: meta_string(doc, "docId"),
            title: meta_string(doc, "title"),
            path: path.map(path_string),
            updated_at: iso8601(now),
            preview: preview(doc),
        };
        self.recents = upsert_recent(&self.recents, &entry);
        self.persist_recents()
    }

    fn persist_recents(&self) -> io::Result<()> {
        save_recents(&recents_path(&self.config.user_data), &self.recents)
    }

    /// Drafts newer than their recents entry (or with none), not open now.
    fn recoveries(&self) -> Vec<RecoveryOffer> {
        let Ok(entries) = fs::read_dir(drafts_dir(&self.config.user_data)) else {
            return vec![];
        };
        let mut offers = vec![];
        for entry in entries.flatten() {
            let file = entry.path();
            if file.extension().and_then(|e| e.to_str()) != Some("collabdoc") {
                continue;
            }
            let Ok(bytes) = fs::read(&file) else {
                continue;
            };
            let Ok(header) = file::read_header(&bytes) else {
                continue;
            };
            if self.tracked.contains_key(&header.doc_id) {
                continue;
            }
            let modified = |p: &Path| {
                fs::metadata(p)
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map_or(0, |d| d.as_millis() as i64)
            };
            let journal = journal_path(&self.config.user_data, &header.doc_id);
            let journal_frames = journal_updates(&self.config.user_data, &header.doc_id, None);
            let changed_at = modified(&file).max(if journal_frames.is_empty() {
                0
            } else {
                modified(&journal)
            });
            let recent = self.recents.iter().find(|r| r.doc_id == header.doc_id);
            let recent_at = recent.and_then(|r| parse_iso8601(&r.updated_at));
            if recent_at.is_some_and(|at| changed_at <= at + 500) {
                continue;
            }
            // What it says, journal included; a draft nobody typed in is no loss.
            let Ok(opened) = self.load(&bytes, None, "recovery") else {
                continue;
            };
            let text = preview(opened.document.loro());
            if text.is_empty() {
                continue;
            }
            offers.push(RecoveryOffer {
                doc_id: header.doc_id,
                title: if header.title.is_empty() {
                    "Untitled".into()
                } else {
                    opened.document.title()
                },
                updated_at: iso8601(changed_at),
                preview: text,
            });
        }
        offers.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        offers
    }
}

fn open_journal(path: &Path, file_path: Option<&Path>, keep: bool) -> io::Result<File> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    if keep {
        return OpenOptions::new().append(true).open(path);
    }
    let head = serde_json::to_vec(&JournalHead {
        path: file_path.map(path_string),
    })?;
    // Written and closed, then reopened for appending.
    OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(path)?
        .write_all(&frame(&head))?;
    OpenOptions::new().append(true).open(path)
}

fn encode(doc: &LoroDoc, assets: &[Asset], now: i64) -> Vec<u8> {
    doc.commit();
    let snapshot = doc.export(ExportMode::Snapshot).expect("snapshot export");
    file::encode(
        &meta_string(doc, "docId"),
        &meta_string(doc, "title"),
        now,
        &snapshot,
        assets,
    )
}

/// The first words of the document, for the recents (`documentPreview`).
pub fn preview(doc: &LoroDoc) -> String {
    let text: Vec<String> = tree::flatten(doc)
        .into_iter()
        .filter(|(_, v)| v.editable)
        .map(|(_, v)| v.plain_text().trim().to_owned())
        .filter(|t| !t.is_empty())
        .collect();
    let joined = text.join(" ");
    let collapsed: String = joined.split_whitespace().collect::<Vec<_>>().join(" ");
    js_head(&collapsed, PREVIEW_CHARS)
}

fn document_is_empty(doc: &LoroDoc) -> bool {
    tree::flatten(doc)
        .iter()
        .all(|(_, v)| v.editable && v.text.trim().is_empty())
}

/// The bytes of `<dir>/<hash>.<ext>`, if such a file is there.
fn asset_file(dir: &Path, hash: &str) -> Option<Vec<u8>> {
    fs::read_dir(dir).ok()?.flatten().find_map(|entry| {
        let path = entry.path();
        let stem = path.file_stem()?.to_str()?;
        stem.eq_ignore_ascii_case(hash)
            .then(|| fs::read(&path).ok())
            .flatten()
    })
}

/// `asset:<hash>` sources of image figures.
fn referenced_assets(doc: &LoroDoc) -> Vec<String> {
    tree::flatten(doc)
        .into_iter()
        .filter(|(_, v)| v.node_name == "imageFigure")
        .filter_map(|(l, _)| match tree::attrs(&l.node).get("src") {
            Some(loro::ValueOrContainer::Value(LoroValue::String(s))) => {
                s.strip_prefix("asset:").map(str::to_owned)
            }
            _ => None,
        })
        .collect()
}

/// `# Title` on the first line → (title, the rest); else the fallback title
/// and everything (`parseDocument`).
fn split_title(raw: &str, fallback: &str) -> (String, String) {
    let mut lines = raw.splitn(2, '\n');
    let first = lines.next().unwrap_or("").trim_end_matches('\r');
    if let Some(title) = first
        .strip_prefix('#')
        .filter(|r| r.starts_with([' ', '\t']))
    {
        let title = title.trim();
        let rest = lines.next().unwrap_or("");
        let rest = rest
            .strip_prefix("\r\n")
            .or_else(|| rest.strip_prefix('\n'))
            .unwrap_or(rest);
        return (
            if title.is_empty() {
                fallback.to_owned()
            } else {
                title.to_owned()
            },
            rest.to_owned(),
        );
    }
    (fallback.to_owned(), raw.to_owned())
}
