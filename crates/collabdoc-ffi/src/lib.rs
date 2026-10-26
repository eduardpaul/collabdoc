//! C ABI over `collabdoc-core`, for front ends that are not Rust (Flutter).
//!
//! The surface is deliberately tiny — open, fork, free, and one JSON command
//! entry point — so the binding on the other side is a handful of lines and
//! all editing rules stay in `collabdoc_core::Editor`. Offsets are UTF-16
//! code units, which is what Dart strings index by.
//!
//! A session is one participant (one Loro peer, one undo stack). Sessions
//! opened from each other share a workspace: the document's hub. The hub's
//! document is what the store autosaves and journals; the store itself (drafts,
//! recents) is one per process, configured from `COLLABDOC_USER_DATA` and
//! `COLLABDOC_DOCUMENTS_DIR` or the platform's folders, and reached without a
//! session through `cd_store`. Everything here must be called from one thread
//! (Dart's UI isolate).

use std::cell::RefCell;
use std::collections::HashMap;
use std::ffi::{CStr, CString, c_char};
use std::path::PathBuf;
use std::rc::Rc;

use collabdoc_core::document::now_ms;
use collabdoc_core::history::{self, AuthorRecord, Frontier, HistoryIndex};
use collabdoc_core::identity::{self, Profile, Whereabouts};
use collabdoc_core::ids::new_actor_id;
use collabdoc_core::model::ListKind;
use collabdoc_core::presence::{Claim, DEFAULT_CLAIM_SECONDS, Presence, User};
use collabdoc_core::schema::mark_bit;
use collabdoc_core::store::{Opened, SaveOutcome, Store, StoreConfig};
use collabdoc_core::sync::Hub;
use collabdoc_core::{BlockKind, Editor, ViewBlock};
use serde_json::{Value, json};

struct Shared {
    hub: Hub,
    /// The hub document's history, grown as it changes (built on first use).
    history: Option<HistoryIndex>,
    /// What opening found: replayed edits, a damaged asset section.
    recovered_edits: bool,
    warnings: Vec<String>,
}

thread_local! {
    static STORE: RefCell<Option<Store>> = const { RefCell::new(None) };
    /// The user's profile, read from the store's folder on first use.
    static PROFILE: RefCell<Option<Profile>> = const { RefCell::new(None) };
}

/// The user's profile (created, unset up, on the first launch).
fn profile() -> Profile {
    PROFILE.with(|cell| {
        cell.borrow_mut()
            .get_or_insert_with(|| Profile::load(&with_store(|s| s.config().user_data.clone())))
            .clone()
    })
}

/// The process's store, created on first use.
fn with_store<R>(f: impl FnOnce(&mut Store) -> R) -> R {
    STORE.with(|cell| {
        let mut slot = cell.borrow_mut();
        let store = slot.get_or_insert_with(|| Store::open(store_config(None)));
        f(store)
    })
}

/// The platform's folders, unless the environment or `overrides` name others.
fn store_config(overrides: Option<&Value>) -> StoreConfig {
    let mut config = StoreConfig::for_user();
    let pick = |key: &str, env: &str| {
        overrides
            .and_then(|o| o[key].as_str())
            .map(str::to_owned)
            .or_else(|| std::env::var(env).ok())
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
    };
    if let Some(dir) = pick("userData", "COLLABDOC_USER_DATA") {
        config.user_data = dir;
    }
    if let Some(dir) = pick("documentsDir", "COLLABDOC_DOCUMENTS_DIR") {
        config.documents_dir = dir;
    }
    if let Some(ms) = overrides.and_then(|o| o["idleMs"].as_i64()) {
        config.idle_ms = ms;
    }
    config
}

pub struct Session {
    editor: Editor,
    shared: Rc<RefCell<Shared>>,
    /// What the UI was last sent, so `view` only sends what changed.
    sent_order: Vec<String>,
    sent: HashMap<String, ViewBlock>,
    presence: Presence,
    user: User,
    /// The `@handle` this participant prefers (the profile's, for the user).
    handle: Option<String>,
    /// A past version, for viewing: edits are ignored and nothing is saved.
    read_only: bool,
}

impl Session {
    /// `{"new": true}`, `{"path": …}` (a `.collabdoc`, or Markdown to
    /// import) or `{"draft": docId}` (recover a draft).
    fn open(spec: &Value) -> Result<Self, String> {
        // The user writes as their profile's id in every document.
        let me = profile();
        let actor = me.user_id.clone();
        let now = now_ms();
        let opened = if let Some(path) = spec["path"].as_str().filter(|p| !p.is_empty()) {
            let path = PathBuf::from(path);
            if path.exists() {
                with_store(|s| s.open_path(&path, &actor, now))?
            } else {
                // A new document that is to be saved there.
                let title = path.file_stem().map(|s| s.to_string_lossy().into_owned());
                let title = title.as_deref().unwrap_or("Untitled");
                let document =
                    with_store(|s| s.create(title, &actor, now)).map_err(|e| e.to_string())?;
                with_store(|s| s.save_to(document.loro(), &path, now))
                    .map_err(|e| e.to_string())?;
                Opened {
                    document,
                    recovered_edits: false,
                    warnings: vec![],
                }
            }
        } else if let Some(id) = spec["draft"].as_str() {
            with_store(|s| s.recover(id, &actor, now))?
        } else {
            let document =
                with_store(|s| s.create("Untitled", &actor, now)).map_err(|e| e.to_string())?;
            Opened {
                document,
                recovered_edits: false,
                warnings: vec![],
            }
        };
        let shared = Shared {
            hub: Hub::new(&opened.document),
            history: None,
            recovered_edits: opened.recovered_edits,
            warnings: opened.warnings,
        };
        let mut session = Self::with(Editor::new(opened.document), Rc::new(RefCell::new(shared)));
        session.user.name = me.name;
        session.user.color = me.color;
        session.handle = Some(me.handle);
        session.register_author();
        Ok(session)
    }

    fn fork(&self) -> Self {
        let doc = self.editor.document().fork(&new_actor_id());
        Self::with(Editor::new(doc), self.shared.clone())
    }

    fn with(editor: Editor, shared: Rc<RefCell<Shared>>) -> Self {
        let user = User {
            name: "You".into(),
            color: "#3b82f6".into(),
            actor_id: editor.document().actor().to_owned(),
            role: Some("human".into()),
        };
        let mut session = Self {
            presence: Presence::new(&editor),
            user,
            editor,
            shared,
            sent_order: Vec::new(),
            sent: HashMap::new(),
            read_only: false,
            handle: None,
        };
        session.register_author();
        session
    }

    /// This participant in the document's `authors` map (written before
    /// their first edit), so history attributes their changes.
    fn register_author(&mut self) {
        let record = AuthorRecord {
            actor_id: self.user.actor_id.clone(),
            name: self.user.name.clone(),
            color: self.user.color.clone(),
            role: self.user.role.clone().unwrap_or_else(|| "human".into()),
            handle: self.handle.clone(),
        };
        self.editor.set_author(record);
    }

    /// Everyone addressable in the document (its authors, online or not,
    /// and us) and the "In this session" rows.
    fn people(&self) -> Value {
        let _ = self.presence.apply(&self.shared.borrow().hub.presence());
        let actors = self.presence.actors(&self.editor, None);
        let mut online: std::collections::HashSet<String> =
            actors.iter().map(|a| a.actor_id.clone()).collect();
        online.insert(self.user.actor_id.clone());
        let authors: Vec<AuthorRecord> = {
            let shared = self.shared.borrow();
            let mut authors: Vec<AuthorRecord> = history::read_authors(shared.hub.loro())
                .into_values()
                .collect();
            // Peers in a fixed order, so equal ids merge the same way.
            authors.sort_by(|a, b| a.actor_id.cmp(&b.actor_id).then(a.name.cmp(&b.name)));
            authors
        };
        // Peers that published who they are but have not written yet.
        let present: Vec<AuthorRecord> = actors
            .iter()
            .filter(|a| a.peer_id != self.presence.peer())
            .filter_map(|a| {
                Some(AuthorRecord {
                    actor_id: a.actor_id.clone(),
                    name: a.name.clone()?,
                    color: a.color.clone().unwrap_or_default(),
                    role: a.role.clone().unwrap_or_else(|| "human".into()),
                    handle: None,
                })
            })
            .collect();
        let known: Vec<AuthorRecord> = authors.into_iter().chain(present).collect();
        let me = AuthorRecord {
            actor_id: self.user.actor_id.clone(),
            name: self.user.name.clone(),
            color: self.user.color.clone(),
            role: self.user.role.clone().unwrap_or_else(|| "human".into()),
            handle: self.handle.clone(),
        };
        let registry = identity::participant_registry(&me, &known, &[], &online);
        let whereabouts: Vec<Whereabouts> = actors
            .iter()
            .map(|a| Whereabouts {
                actor_id: a.actor_id.clone(),
                // Only a caret someone else sees counts as typing; ours is
                // where we are, so it shows too (as in the TS list).
                block_id: a.cursor.as_ref().map(|c| c.block_id.clone()),
            })
            .collect();
        let blocks = self.editor.blocks();
        let label = |id: &str| match blocks.iter().position(|b| b.block_id == id) {
            Some(i) => format!("¶{}", i + 1),
            None => "the document".to_owned(),
        };
        let rows = identity::session_rows(
            &registry.people,
            &self.user.actor_id,
            &whereabouts,
            &Default::default(),
            label,
        );
        json!({
            "ok": true,
            "people": registry.people,
            "localHandle": registry.local_handle,
            "handleChanged": registry.handle_changed,
            "rows": rows,
        })
    }

    /// The document as it was at `frontiers`, read-only (View this version).
    fn open_version(&self, frontiers: &[Frontier]) -> Result<Self, String> {
        let shared = self.shared.borrow();
        let fork = history::fork_at(shared.hub.loro(), frontiers)
            .ok_or("This version is not in the document.")?;
        let bytes = fork
            .export(loro::ExportMode::Snapshot)
            .map_err(|e| e.to_string())?;
        let document = collabdoc_core::Document::from_snapshot(&bytes, &new_actor_id())
            .map_err(|e| e.to_string())?
            .with_assets(self.editor.document().assets().to_vec());
        let version = Shared {
            hub: Hub::new(&document),
            history: None,
            recovered_edits: false,
            warnings: vec![],
        };
        let mut session = Self::with(Editor::new(document), Rc::new(RefCell::new(version)));
        session.read_only = true;
        Ok(session)
    }

    /// The hub's history index, brought up to date.
    fn history<R>(&self, f: impl FnOnce(&mut HistoryIndex, &loro::LoroDoc) -> R) -> R {
        let mut shared = self.shared.borrow_mut();
        let Shared { hub, history, .. } = &mut *shared;
        let index = history.get_or_insert_with(HistoryIndex::default);
        index.refresh(hub.loro());
        f(index, hub.loro())
    }

    /// Blocks and selection. Only blocks that changed since the last call
    /// are included (`changed`), and the block order only when it changed
    /// (`order`), so a keystroke in a long document sends one block.
    fn view(&mut self) -> Value {
        let e = &self.editor;
        let order: Vec<String> = e.blocks().iter().map(|b| b.key.clone()).collect();
        let changed: Vec<&ViewBlock> = e
            .blocks()
            .iter()
            .filter(|b| self.sent.get(&b.key) != Some(*b))
            .collect();
        let blocks: Vec<Value> = changed
            .iter()
            .map(|b| {
                let (kind, level) = match b.kind {
                    BlockKind::Paragraph => ("paragraph", 0),
                    BlockKind::Heading(l) => ("heading", l),
                    BlockKind::CodeBlock => ("code", 0),
                    BlockKind::Atom => ("atom", 0),
                };
                let list = b.list.map(|l| match l {
                    ListKind::Bullet => "bullet",
                    ListKind::Ordered => "ordered",
                    ListKind::Task => "task",
                });
                let spans: Vec<Value> = b
                    .spans
                    .iter()
                    .map(|s| json!([s.start, s.end, s.marks, s.href]))
                    .collect();
                let inlines: Vec<Value> = b
                    .inlines
                    .iter()
                    .map(|n| json!({ "at": n.at, "name": n.name, "attrs": n.attrs }))
                    .collect();
                let mut block = json!({
                    "key": b.key, "blockId": b.block_id, "kind": kind, "level": level, "list": list,
                    "listDepth": b.list_depth, "quoteDepth": b.quote_depth, "checked": b.checked,
                    "editable": b.editable, "text": b.text, "spans": spans, "inlines": inlines,
                });
                if b.kind == BlockKind::Atom {
                    block["nodeName"] = json!(b.node_name);
                    block["attrs"] = Value::Object(b.attrs.clone());
                    block["caption"] = json!(b.caption);
                }
                block
            })
            .collect();
        let (kind, level) = match e.kind_at_cursor() {
            BlockKind::Heading(l) => ("heading", l),
            BlockKind::CodeBlock => ("code", 0),
            BlockKind::Atom => ("atom", 0),
            BlockKind::Paragraph => ("paragraph", 0),
        };
        let shared = self.shared.borrow();
        let persist = with_store(|s| s.state(shared.hub.loro()));
        let order_changed = order != self.sent_order;
        let mut sent: HashMap<String, ViewBlock> = HashMap::with_capacity(order.len());
        for b in e.blocks() {
            sent.insert(b.key.clone(), b.clone());
        }
        self.sent = sent;
        let order_json = if order_changed {
            Some(order.clone())
        } else {
            None
        };
        self.sent_order = order;
        json!({
            "order": order_json,
            "changed": blocks,
            "anchor": e.anchor(),
            "head": e.head(),
            "marks": e.marks_at_cursor(),
            "kind": kind,
            "level": level,
            "canUndo": e.document().can_undo(),
            "canRedo": e.document().can_redo(),
            "title": e.document().title(),
            "persist": persist,
        })
    }

    /// The images other participants added, known to this one too.
    fn adopt_store_assets(&mut self) {
        let id = self.editor.document().doc_id();
        let assets = with_store(|s| s.assets_of(&id).to_vec());
        self.editor.adopt_assets(assets);
    }

    /// Runs one command. Every reply has `ok`; edits also say `changed`.
    fn call(&mut self, cmd: &Value) -> Value {
        // A viewed version answers reading and moving around; anything
        // else (typing, saving, presence) does nothing.
        const READS: &[&str] = &[
            "select",
            "selectAll",
            "left",
            "right",
            "wordLeft",
            "wordRight",
            "home",
            "end",
            "copy",
            "copyMarkdown",
            "find",
            "linkAt",
            "textIn",
            "looksLikeMermaid",
            "actor",
            "setUser",
            "resetView",
            "carets",
            "people",
            "actors",
            "myClaim",
        ];
        if self.read_only && !READS.contains(&cmd["op"].as_str().unwrap_or("")) {
            return json!({ "ok": true, "changed": false });
        }
        let n = |key: &str| cmd[key].as_u64().unwrap_or(0) as usize;
        let s = |key: &str| cmd[key].as_str().unwrap_or("");
        let extend = cmd["extend"].as_bool().unwrap_or(false);
        let e = &mut self.editor;
        let changed = match s("op") {
            "insert" => e.insert_text(s("text")),
            "paste" => e.paste(s("text")),
            "pasteHtml" => e.paste_html(s("html"), s("text")),
            "insertMermaid" => e.insert_mermaid(s("source")),
            "insertFigure" => e.insert_figure(s("name")),
            // An image from a file (`path`) or the clipboard (`base64`).
            "insertImage" => {
                let bytes = if let Some(path) = cmd["path"].as_str() {
                    match std::fs::read(path) {
                        Ok(bytes) => bytes,
                        Err(err) => return json!({ "ok": false, "error": err.to_string() }),
                    }
                } else {
                    use base64::Engine;
                    match base64::engine::general_purpose::STANDARD.decode(s("base64")) {
                        Ok(bytes) => bytes,
                        Err(err) => return json!({ "ok": false, "error": err.to_string() }),
                    }
                };
                match e.insert_image(bytes, s("alt")) {
                    Ok(changed) => changed,
                    Err(err) => return json!({ "ok": false, "error": err.to_string() }),
                }
            }
            "setCaption" => e.set_caption(n("block"), s("text")),
            "restore" => e.restore_version(&frontiers_arg(&cmd["frontiers"])),
            "setFigureAttr" => e.set_figure_attr(n("block"), s("key"), &cmd["value"]),
            "looksLikeMermaid" => {
                let yes = collabdoc_core::markdown::looks_like_mermaid(s("text"));
                return json!({ "ok": true, "mermaid": yes });
            }
            "replace" => e.replace(n("start")..n("end"), s("text")),
            "newline" => e.newline(),
            "hardBreak" => e.hard_break(),
            "insertMention" => match cmd["attrs"].as_object() {
                Some(attrs) => e.insert_mention(attrs.clone()),
                None => return json!({ "ok": false, "error": "attrs must be an object" }),
            },
            "backspace" => e.backspace(),
            "delete" => e.delete_forward(),
            "undo" => e.undo(),
            "redo" => e.redo(),
            "toggleMark" => match mark_bit(s("mark")) {
                Some(bit) => e.toggle_mark(bit),
                None => return json!({ "ok": false, "error": "unknown mark" }),
            },
            "setKind" => {
                let kind = match s("kind") {
                    "heading" => BlockKind::Heading(n("level").clamp(1, 4) as u8),
                    "code" => BlockKind::CodeBlock,
                    _ => BlockKind::Paragraph,
                };
                e.set_kind(kind)
            }
            "setLink" => e.set_link(s("href")),
            "linkAt" => {
                let link = e.link_at(n("offset")).map(
                    |(range, href)| json!({ "start": range.start, "end": range.end, "href": href }),
                );
                return json!({ "ok": true, "link": link });
            }
            "toggleList" => {
                let kind = match s("kind") {
                    "ordered" => ListKind::Ordered,
                    "task" => ListKind::Task,
                    _ => ListKind::Bullet,
                };
                e.toggle_list(kind)
            }
            "indent" => e.indent(),
            "outdent" => e.outdent(),
            "toggleQuote" => e.toggle_quote(),
            "toggleTask" => e.toggle_task(n("block")),
            "select" => {
                e.set_selection(n("anchor"), n("head"));
                false
            }
            "selectAll" => {
                e.select_all();
                false
            }
            "left" => {
                e.move_left(extend);
                false
            }
            "right" => {
                e.move_right(extend);
                false
            }
            "wordLeft" => {
                e.move_word_left(extend);
                false
            }
            "wordRight" => {
                e.move_word_right(extend);
                false
            }
            "deleteWordBack" => e.delete_word_backward(),
            "deleteWordForward" => e.delete_word_forward(),
            "home" => {
                e.move_home(extend);
                false
            }
            "end" => {
                e.move_end(extend);
                false
            }
            "resetView" => {
                // The UI lost its copy (hot restart): the next view is complete.
                self.sent.clear();
                self.sent_order.clear();
                return json!({ "ok": true });
            }
            "find" => {
                let matches: Vec<Value> = e
                    .find(s("query"), cmd["caseSensitive"].as_bool().unwrap_or(false))
                    .into_iter()
                    .map(|r| json!([r.start, r.end]))
                    .collect();
                return json!({ "ok": true, "matches": matches });
            }
            "replaceMatches" => {
                let ranges: Vec<std::ops::Range<usize>> = cmd["ranges"]
                    .as_array()
                    .map(|a| {
                        a.iter()
                            .filter_map(|r| Some(r[0].as_u64()? as usize..r[1].as_u64()? as usize))
                            .collect()
                    })
                    .unwrap_or_default();
                e.replace_matches(&ranges, s("text"))
            }
            // The selection as Markdown text and as HTML, for the clipboard.
            "copy" => {
                self.adopt_store_assets();
                let e = &mut self.editor;
                return json!({
                    "ok": true,
                    "text": e.selection_markdown(),
                    "html": e.selection_html(),
                });
            }
            "copyMarkdown" => return json!({ "ok": true, "text": e.selection_markdown() }),
            // This participant's Loro actor (a mention's `id`).
            "actor" => return json!({ "ok": true, "actor": e.document().actor() }),
            "setUser" => {
                self.user.name = s("name").to_owned();
                if let Some(color) = cmd["color"].as_str() {
                    self.user.color = color.to_owned();
                }
                if let Some(handle) = cmd["handle"].as_str() {
                    self.handle = Some(handle.to_owned()).filter(|h| identity::is_valid_handle(h));
                }
                if !self.read_only {
                    self.register_author();
                }
                return json!({ "ok": true });
            }
            // History of the document (everyone's changes, oldest first) and
            // its checkpoints (newest first).
            "history" => {
                let entries = self.history(|index, _| json!(index.list()));
                let shared = self.shared.borrow();
                let checkpoints = history::list_checkpoints(shared.hub.loro());
                return json!({
                    "ok": true,
                    "entries": entries,
                    "checkpoints": checkpoints,
                    "actorId": self.user.actor_id,
                });
            }
            "historyDiff" => {
                let id = s("id").to_owned();
                return match self.history(|index, doc| index.diff(doc, &id)) {
                    Some(hunks) => json!({ "ok": true, "hunks": hunks }),
                    None => json!({ "ok": false, "error": "no such entry" }),
                };
            }
            // What restoring `frontiers` would change, from the live document.
            "versionDiff" => {
                let frontiers = frontiers_arg(&cmd["frontiers"]);
                let shared = self.shared.borrow();
                let hunks = history::diff_against_live(shared.hub.loro(), &frontiers);
                return json!({ "ok": true, "hunks": hunks });
            }
            // The last author of each block, for the attribution gutter.
            "blockAuthors" => {
                let authors = self.history(|index, _| json!(index.last_authors()));
                return json!({ "ok": true, "authors": authors });
            }
            "addCheckpoint" => {
                let checkpoint = self.editor.add_checkpoint(s("name"));
                return json!({ "ok": true, "changed": true, "checkpoint": checkpoint });
            }
            "presence" => {
                // Our caret and name, to everyone through the hub; `gapMs`
                // is how long to wait before the next (AC-07.8).
                let update = self.presence.publish(&self.editor, &self.user);
                return match self.shared.borrow().hub.push_presence(&update) {
                    Ok(()) => json!({ "ok": true, "gapMs": self.presence.gap_ms() }),
                    Err(err) => json!({ "ok": false, "error": err.to_string() }),
                };
            }
            // Work on blocks for `seconds` (default 30, at most 120):
            // `blockIds`, or else the blocks the selection touches. Sent with
            // the next `presence`.
            "claim" => {
                let ids: Vec<String> = match cmd["blockIds"].as_array() {
                    Some(ids) => ids
                        .iter()
                        .filter_map(|id| id.as_str().map(str::to_owned))
                        .collect(),
                    None => {
                        let range = e.selection();
                        let (first, _) = e.locate(range.start);
                        let (last, _) = e.locate(range.end);
                        e.blocks()[first..=last]
                            .iter()
                            .map(|b| b.block_id.clone())
                            .filter(|id| !id.is_empty())
                            .collect()
                    }
                };
                let seconds = cmd["seconds"].as_f64().unwrap_or(DEFAULT_CLAIM_SECONDS);
                let claim = (!ids.is_empty()).then(|| Claim::for_seconds(ids, seconds));
                self.presence.set_claim(claim.clone());
                return json!({ "ok": true, "claim": claim });
            }
            "unclaim" => {
                self.presence.set_claim(None);
                return json!({ "ok": true });
            }
            // Ours, while it lasts.
            "myClaim" => return json!({ "ok": true, "claim": self.presence.claim() }),
            // Everyone, as agents' `get_presence` reports them.
            "actors" => {
                if let Err(err) = self.presence.apply(&self.shared.borrow().hub.presence()) {
                    return json!({ "ok": false, "error": err });
                }
                let near = cmd["nearBlockId"].as_str();
                return json!({ "ok": true, "actors": self.presence.actors(&self.editor, near) });
            }
            "people" => return self.people(),
            "carets" => {
                if let Err(err) = self.presence.apply(&self.shared.borrow().hub.presence()) {
                    return json!({ "ok": false, "error": err });
                }
                let carets: Vec<Value> = self
                    .presence
                    .carets(&self.editor)
                    .into_iter()
                    .map(|c| {
                        let (name, color) = c
                            .user
                            .map(|u| (Some(u.name), Some(u.color)))
                            .unwrap_or_default();
                        json!({
                            "peer": c.peer, "name": name, "color": color,
                            "anchor": c.anchor, "head": c.head,
                            // A string: a u64 does not fit a Dart int.
                            "moved": c.moved.to_string(),
                            "claim": c.claim,
                        })
                    })
                    .collect();
                return json!({ "ok": true, "carets": carets });
            }
            "textIn" => return json!({ "ok": true, "text": e.text_in(n("start")..n("end")) }),
            "push" => {
                let new_assets = self.editor.take_new_assets();
                let shared = self.shared.borrow();
                // The hub has the edit: journal it, start the autosave clock.
                let pushed = shared
                    .hub
                    .push(self.editor.document())
                    .map_err(|e| e.to_string());
                // New image bytes are on disk before the journal points at them.
                let journaled = pushed.and_then(|()| {
                    with_store(|s| {
                        s.put_assets(shared.hub.loro(), new_assets, now_ms())?;
                        s.changed(shared.hub.loro(), now_ms())
                    })
                    .map_err(|e| e.to_string())
                });
                return match journaled {
                    Ok(()) => json!({ "ok": true }),
                    Err(err) => json!({ "ok": false, "error": err }),
                };
            }
            "pull" => {
                let shared = self.shared.clone();
                let shared = shared.borrow();
                return match self.editor.remote_change(|doc| shared.hub.pull(doc)) {
                    Ok(changed) => json!({ "ok": true, "changed": changed }),
                    Err(err) => json!({ "ok": false, "error": err.to_string() }),
                };
            }
            // Every few hundred ms: journal to disk, autosave when due.
            "tick" => {
                let shared = self.shared.borrow();
                let doc = shared.hub.loro();
                return match with_store(|s| s.tick(doc, now_ms())) {
                    Ok(saved) => json!({
                        "ok": true,
                        "saved": saved,
                        "persist": with_store(|s| s.state(doc)),
                    }),
                    Err(err) => json!({ "ok": false, "error": err.to_string() }),
                };
            }
            // Ctrl+S: written now, or `needsSaveAs` for a draft.
            "save" => {
                let shared = self.shared.borrow();
                let doc = shared.hub.loro();
                return match with_store(|s| s.save(doc, now_ms())) {
                    Ok(SaveOutcome::Saved(path)) => {
                        json!({ "ok": true, "path": path.display().to_string() })
                    }
                    Ok(SaveOutcome::NeedsSaveAs) => json!({
                        "ok": false,
                        "needsSaveAs": true,
                        "suggested": with_store(|s| s.suggested_path(doc)).display().to_string(),
                    }),
                    Err(err) => json!({ "ok": false, "error": err.to_string() }),
                };
            }
            "suggestedPath" => {
                let shared = self.shared.borrow();
                let path = with_store(|s| s.suggested_path(shared.hub.loro()));
                return json!({ "ok": true, "path": path.display().to_string() });
            }
            // Save As: the document lives there from now on. An untitled
            // document takes the file's name as its title.
            "saveAs" => {
                let path = PathBuf::from(s("path"));
                if path.as_os_str().is_empty() {
                    return json!({ "ok": false, "error": "no path" });
                }
                if e.document().title() == "Untitled"
                    && let Some(stem) = path.file_stem().map(|s| s.to_string_lossy().into_owned())
                {
                    e.set_title(&stem);
                }
                let shared = self.shared.borrow();
                let saved = shared
                    .hub
                    .push(self.editor.document())
                    .map_err(|e| e.to_string())
                    .and_then(|()| {
                        with_store(|s| s.save_to(shared.hub.loro(), &path, now_ms()))
                            .map_err(|e| e.to_string())
                    });
                return match saved {
                    Ok(()) => json!({ "ok": true, "path": path.display().to_string() }),
                    Err(err) => json!({ "ok": false, "error": err }),
                };
            }
            "exportMarkdown" => {
                let path = PathBuf::from(s("path"));
                self.adopt_store_assets();
                return match Store::export_markdown(self.editor.document(), &path) {
                    Ok(()) => json!({ "ok": true, "path": path.display().to_string() }),
                    Err(err) => json!({ "ok": false, "error": err.to_string() }),
                };
            }
            // Whether leaving needs asking (a draft with something in it).
            "hasContent" => {
                let any = e
                    .blocks()
                    .iter()
                    .any(|b| !b.editable || !b.text.trim().is_empty());
                return json!({ "ok": true, "hasContent": any });
            }
            "openInfo" => {
                let shared = self.shared.borrow();
                return json!({
                    "ok": true,
                    "recoveredEdits": shared.recovered_edits,
                    "warnings": shared.warnings,
                });
            }
            // Leaving the document: unsaved edits are written, an untouched
            // draft is not kept. With `discard`, a draft is deleted instead.
            "close" => {
                let shared = self.shared.borrow();
                let doc = shared.hub.loro();
                let id = collabdoc_core::document::meta_string(doc, "docId");
                let done = if cmd["discard"].as_bool() == Some(true) {
                    with_store(|s| s.discard_draft(&id))
                } else {
                    with_store(|s| s.release(doc, now_ms()))
                };
                return match done {
                    Ok(()) => json!({ "ok": true }),
                    Err(err) => json!({ "ok": false, "error": err.to_string() }),
                };
            }
            other => return json!({ "ok": false, "error": format!("unknown op {other:?}") }),
        };
        json!({ "ok": true, "changed": changed })
    }
}

/// Hands `bytes` to C: free with [`cd_bytes_free`].
fn bytes_to_c(bytes: Vec<u8>, len: *mut usize) -> *mut u8 {
    let mut boxed = bytes.into_boxed_slice();
    if !len.is_null() {
        unsafe { *len = boxed.len() };
    }
    let ptr = boxed.as_mut_ptr();
    std::mem::forget(boxed);
    ptr
}

fn set_error(error: *mut *mut c_char, message: &str) {
    if !error.is_null() {
        let message = CString::new(message.replace('\0', " ")).expect("no NUL");
        unsafe { *error = message.into_raw() };
    }
}

/// The bytes of image `hash` in the session's document (as stored: PNG,
/// JPEG, GIF, WebP or SVG), or null when it does not have them.
///
/// # Safety
/// `session` is from `cd_open*`/`cd_fork`; `hash` is a NUL-terminated string;
/// `len` is writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn cd_asset(
    session: *mut Session,
    hash: *const c_char,
    len: *mut usize,
) -> *mut u8 {
    let session = unsafe { &*session };
    let hash = unsafe { CStr::from_ptr(hash) }.to_string_lossy();
    let doc = session.editor.document();
    let bytes = doc
        .asset(&hash)
        .map(|a| a.bytes.clone())
        .or_else(|| with_store(|s| s.asset(&doc.doc_id(), &hash).map(|a| a.bytes.clone())));
    match bytes {
        Some(bytes) => bytes_to_c(bytes, len),
        None => std::ptr::null_mut(),
    }
}

/// Mermaid `source` drawn as a PNG at `scale` device pixels per unit. Null
/// with `*error` set when it cannot be drawn. Safe to call from any thread.
///
/// # Safety
/// `source` is a NUL-terminated UTF-8 string; `len` is writable; `error` is
/// null or writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn cd_render_mermaid(
    source: *const c_char,
    scale: f32,
    len: *mut usize,
    error: *mut *mut c_char,
) -> *mut u8 {
    let source = unsafe { CStr::from_ptr(source) }.to_string_lossy();
    match collabdoc_core::render::mermaid_png(&source, scale) {
        Ok(png) => bytes_to_c(png.bytes, len),
        Err(err) => {
            set_error(error, &err);
            std::ptr::null_mut()
        }
    }
}

/// An SVG image drawn as a PNG at `scale`. Safe to call from any thread.
///
/// # Safety
/// `svg` points at `svg_len` readable bytes; `len` is writable; `error` is
/// null or writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn cd_render_svg(
    svg: *const u8,
    svg_len: usize,
    scale: f32,
    len: *mut usize,
    error: *mut *mut c_char,
) -> *mut u8 {
    let svg = unsafe { std::slice::from_raw_parts(svg, svg_len) };
    match collabdoc_core::render::svg_png(svg, scale, None) {
        Ok(png) => bytes_to_c(png.bytes, len),
        Err(err) => {
            set_error(error, &err);
            std::ptr::null_mut()
        }
    }
}

/// Frees bytes from `cd_asset` and `cd_render_*`.
///
/// # Safety
/// `ptr` and `len` are exactly what one of those returned, freed once.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn cd_bytes_free(ptr: *mut u8, len: usize) {
    if !ptr.is_null() {
        drop(unsafe { Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr, len)) });
    }
}

fn to_c(value: Value) -> *mut c_char {
    // JSON never contains a NUL byte (it is escaped as \u0000).
    CString::new(value.to_string())
        .expect("JSON has no NUL")
        .into_raw()
}

/// Opens `path` (or a new document when it does not exist yet, or when null).
/// Returns null and sets `*error` (free with `cd_string_free`) on failure.
///
/// # Safety
/// `path` is null or a NUL-terminated UTF-8 string; `error` is null or writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn cd_open(path: *const c_char, error: *mut *mut c_char) -> *mut Session {
    let path = (!path.is_null())
        .then(|| {
            unsafe { CStr::from_ptr(path) }
                .to_string_lossy()
                .into_owned()
        })
        .filter(|p| !p.is_empty());
    let spec = match path {
        Some(p) => json!({ "path": p }),
        None => json!({ "new": true }),
    };
    open_spec(&spec, error)
}

/// Opens per a JSON spec: `{"new": true}`, `{"path": …}` or `{"draft": docId}`.
///
/// # Safety
/// `spec` is a NUL-terminated UTF-8 string; `error` is null or writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn cd_open_with(
    spec: *const c_char,
    error: *mut *mut c_char,
) -> *mut Session {
    let spec = unsafe { CStr::from_ptr(spec) }.to_string_lossy();
    match serde_json::from_str::<Value>(&spec) {
        Ok(spec) => open_spec(&spec, error),
        Err(err) => {
            if !error.is_null() {
                unsafe { *error = to_c(Value::String(err.to_string())) };
            }
            std::ptr::null_mut()
        }
    }
}

fn open_spec(spec: &Value, error: *mut *mut c_char) -> *mut Session {
    match Session::open(spec) {
        Ok(session) => Box::into_raw(Box::new(session)),
        Err(message) => {
            if !error.is_null() {
                unsafe { *error = to_c(Value::String(message)) };
            }
            std::ptr::null_mut()
        }
    }
}

/// Store calls that need no open document (the start screen):
/// `configure {userData, documentsDir}`, `listing`, `removeRecent {docId}`,
/// `discardDraft {docId}`, `exists {path}`, `profile`,
/// `saveProfile {name, handle, color}`, `handleFromName {name}`.
///
/// # Safety
/// `command` is a NUL-terminated UTF-8 string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn cd_store(command: *const c_char) -> *mut c_char {
    let command = unsafe { CStr::from_ptr(command) }.to_string_lossy();
    let reply = match serde_json::from_str::<Value>(&command) {
        Ok(cmd) => store_call(&cmd),
        Err(err) => json!({ "ok": false, "error": err.to_string() }),
    };
    to_c(reply)
}

fn store_call(cmd: &Value) -> Value {
    let id = cmd["docId"].as_str().unwrap_or("");
    let done = |r: std::io::Result<()>| match r {
        Ok(()) => json!({ "ok": true }),
        Err(err) => json!({ "ok": false, "error": err.to_string() }),
    };
    match cmd["op"].as_str().unwrap_or("") {
        "configure" => {
            let config = store_config(Some(cmd));
            STORE.with(|cell| *cell.borrow_mut() = Some(Store::open(config)));
            PROFILE.with(|cell| cell.take());
            json!({ "ok": true })
        }
        // The user's profile: `setupComplete` false only on the first launch.
        "profile" => json!({ "ok": true, "profile": profile() }),
        // `{name, handle, color}`: an invalid handle is refused, not fixed.
        "saveProfile" => {
            let handle = cmd["handle"].as_str().unwrap_or("");
            if !handle.is_empty() && !identity::is_valid_handle(handle) {
                return json!({
                    "ok": false,
                    "error": "A handle is 2–20 of a–z, 0–9, _ and -.",
                });
            }
            let mut next = serde_json::to_value(profile()).expect("a profile serializes");
            for key in ["name", "handle", "color"] {
                if let Some(value) = cmd[key].as_str().filter(|v| !v.is_empty()) {
                    next[key] = value.into();
                }
            }
            let user_data = with_store(|s| s.config().user_data.clone());
            match Profile::sanitize(&next).save(&user_data) {
                Ok(saved) => {
                    PROFILE.with(|cell| *cell.borrow_mut() = Some(saved.clone()));
                    json!({ "ok": true, "profile": saved })
                }
                Err(err) => json!({ "ok": false, "error": err.to_string() }),
            }
        }
        "handleFromName" => {
            json!({ "ok": true, "handle": identity::handle_from_name(cmd["name"].as_str().unwrap_or("")) })
        }
        "listing" => json!({ "ok": true, "listing": with_store(|s| s.listing()) }),
        "removeRecent" => done(with_store(|s| s.remove_recent(id))),
        "discardDraft" => done(with_store(|s| s.discard_draft(id))),
        "documentsDir" => {
            let dir = with_store(|s| s.config().documents_dir.clone());
            json!({ "ok": true, "path": dir.display().to_string() })
        }
        other => json!({ "ok": false, "error": format!("unknown op {other:?}") }),
    }
}

/// Frontiers as the TS app writes them: `[{peer: "123", counter: 4}]`.
fn frontiers_arg(value: &Value) -> Vec<Frontier> {
    value
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|f| serde_json::from_value(f.clone()).ok())
                .collect()
        })
        .unwrap_or_default()
}

/// The document at a version (`frontiers` JSON, as history entries carry
/// them), as a read-only session: View this version. Null and `*error` when
/// the document does not have that version.
///
/// # Safety
/// `session` comes from `cd_open*`/`cd_fork`; `frontiers` is a NUL-terminated
/// UTF-8 string; `error` is null or writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn cd_open_version(
    session: *const Session,
    frontiers: *const c_char,
    error: *mut *mut c_char,
) -> *mut Session {
    let session = unsafe { &*session };
    let raw = unsafe { CStr::from_ptr(frontiers) }.to_string_lossy();
    let parsed = serde_json::from_str::<Value>(&raw).unwrap_or(Value::Null);
    match session.open_version(&frontiers_arg(&parsed)) {
        Ok(version) => Box::into_raw(Box::new(version)),
        Err(err) => {
            set_error(error, &err);
            std::ptr::null_mut()
        }
    }
}

/// A new participant on the same document, synced through the shared hub.
///
/// # Safety
/// `session` comes from `cd_open`/`cd_fork` and is not freed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn cd_fork(session: *const Session) -> *mut Session {
    let session = unsafe { &*session };
    Box::into_raw(Box::new(session.fork()))
}

/// # Safety
/// `session` comes from `cd_open`/`cd_fork`; it is not used afterwards.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn cd_free(session: *mut Session) {
    if !session.is_null() {
        drop(unsafe { Box::from_raw(session) });
    }
}

/// Runs a JSON command (`{"op": "insert", "text": "a"}` …) and returns JSON.
///
/// # Safety
/// `session` is live; `command` is a NUL-terminated UTF-8 string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn cd_call(session: *mut Session, command: *const c_char) -> *mut c_char {
    let session = unsafe { &mut *session };
    let command = unsafe { CStr::from_ptr(command) }.to_string_lossy();
    let reply = match serde_json::from_str::<Value>(&command) {
        Ok(cmd) => session.call(&cmd),
        Err(err) => json!({ "ok": false, "error": err.to_string() }),
    };
    to_c(reply)
}

/// The blocks and selection as JSON.
///
/// # Safety
/// `session` is live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn cd_view(session: *mut Session) -> *mut c_char {
    to_c(unsafe { &mut *session }.view())
}

/// # Safety
/// `s` comes from this library and is not used afterwards.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn cd_string_free(s: *mut c_char) {
    if !s.is_null() {
        drop(unsafe { CString::from_raw(s) });
    }
}

impl Drop for Session {
    /// A closed pane's caret goes away at once rather than timing out.
    fn drop(&mut self) {
        let _ = self
            .shared
            .borrow()
            .hub
            .push_presence(&self.presence.leave());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// This test thread's store, in a folder of its own.
    fn scratch_store() -> PathBuf {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static N: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "collabdoc-ffi-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        store_call(&json!({
            "op": "configure",
            "userData": dir.join("user"),
            "documentsDir": dir.join("docs"),
            "idleMs": 20,
        }));
        dir
    }

    fn fresh() -> Session {
        scratch_store();
        Session::open(&json!({ "new": true })).unwrap()
    }

    fn call(s: &mut Session, cmd: Value) -> Value {
        s.call(&cmd)
    }

    /// Every block, in order (a view after a reset sends them all).
    fn all_blocks(s: &mut Session) -> Vec<Value> {
        call(s, json!({"op": "resetView"}));
        s.view()["changed"].as_array().unwrap().clone()
    }

    #[test]
    fn commands_edit_and_participants_sync() {
        let mut me = fresh();
        let mut peer = me.fork();
        assert_eq!(
            call(&mut me, json!({"op": "insert", "text": "Hello"}))["changed"],
            true
        );
        call(&mut me, json!({"op": "newline"}));
        call(&mut me, json!({"op": "insert", "text": "world"}));
        call(&mut me, json!({"op": "select", "anchor": 0, "head": 5}));
        call(&mut me, json!({"op": "toggleMark", "mark": "bold"}));
        call(&mut me, json!({"op": "push"}));
        assert_eq!(call(&mut peer, json!({"op": "pull"}))["changed"], true);
        let blocks = all_blocks(&mut peer);
        assert_eq!(blocks[0]["text"], "Hello");
        assert_eq!(blocks[0]["spans"][0], json!([0, 5, 1, ""]));
        assert_eq!(blocks[1]["text"], "world");
    }

    #[test]
    fn the_c_entry_points_round_trip_json() {
        scratch_store();
        unsafe {
            let session = cd_open(std::ptr::null(), std::ptr::null_mut());
            let cmd = CString::new(r#"{"op":"insert","text":"é👍"}"#).unwrap();
            let reply = cd_call(session, cmd.as_ptr());
            let reply_json: Value =
                serde_json::from_str(CStr::from_ptr(reply).to_str().unwrap()).unwrap();
            assert_eq!(reply_json, json!({ "ok": true, "changed": true }));
            cd_string_free(reply);
            let view = cd_view(session);
            let value: Value =
                serde_json::from_str(CStr::from_ptr(view).to_str().unwrap()).unwrap();
            assert_eq!(value["head"], 3, "UTF-16 offsets, as Dart counts");
            cd_string_free(view);
            let fork = cd_fork(session);
            cd_free(fork);
            cd_free(session);
        }
    }

    #[test]
    fn list_commands() {
        let mut s = fresh();
        call(&mut s, json!({"op": "insert", "text": "one\ntwo"}));
        call(&mut s, json!({"op": "selectAll"}));
        assert_eq!(
            call(&mut s, json!({"op": "toggleList", "kind": "task"}))["changed"],
            true
        );
        assert_eq!(
            call(&mut s, json!({"op": "toggleTask", "block": 1}))["changed"],
            true
        );
        call(&mut s, json!({"op": "select", "anchor": 4, "head": 4}));
        assert_eq!(call(&mut s, json!({"op": "indent"}))["changed"], true);
        let blocks = all_blocks(&mut s);
        assert_eq!(blocks[1]["list"], "task");
        assert_eq!(blocks[1]["listDepth"], 2);
        assert_eq!(blocks[1]["checked"], true);
    }

    #[test]
    fn views_send_only_what_changed() {
        let mut s = fresh();
        call(&mut s, json!({"op": "insert", "text": "one\ntwo\nthree"}));
        let first = s.view();
        assert_eq!(first["order"].as_array().unwrap().len(), 3);
        assert_eq!(first["changed"].as_array().unwrap().len(), 3);

        // Typing in one block: that block only, and no order.
        call(&mut s, json!({"op": "select", "anchor": 1, "head": 1}));
        call(&mut s, json!({"op": "insert", "text": "x"}));
        let typed = s.view();
        assert!(typed["order"].is_null());
        assert_eq!(typed["changed"].as_array().unwrap().len(), 1);
        assert_eq!(typed["changed"][0]["text"], "oxne");

        // Nothing changed: nothing sent.
        assert_eq!(s.view()["changed"].as_array().unwrap().len(), 0);

        // Enter: the new block plus the split one, and the new order.
        call(&mut s, json!({"op": "newline"}));
        let split = s.view();
        assert_eq!(split["order"].as_array().unwrap().len(), 4);
        assert_eq!(split["changed"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn link_commands() {
        let mut s = fresh();
        call(&mut s, json!({"op": "insert", "text": "see docs"}));
        call(&mut s, json!({"op": "select", "anchor": 4, "head": 8}));
        assert_eq!(
            call(&mut s, json!({"op": "setLink", "href": "https://loro.dev"}))["changed"],
            true
        );
        let found = call(&mut s, json!({"op": "linkAt", "offset": 5}));
        assert_eq!(
            found["link"],
            json!({"start": 4, "end": 8, "href": "https://loro.dev"})
        );
        assert!(call(&mut s, json!({"op": "linkAt", "offset": 1}))["link"].is_null());
    }

    #[test]
    fn unknown_commands_are_errors_not_crashes() {
        let mut s = fresh();
        assert_eq!(call(&mut s, json!({"op": "fly"}))["ok"], false);
        assert_eq!(
            call(&mut s, json!({"op": "toggleMark", "mark": "blink"}))["ok"],
            false
        );
    }

    #[test]
    fn markdown_goes_through_the_clipboard_ops() {
        let mut s = fresh();
        call(
            &mut s,
            json!({"op": "paste", "text": "# Title\n\n- one\n- two"}),
        );
        call(&mut s, json!({"op": "selectAll"}));
        let copied = call(&mut s, json!({"op": "copyMarkdown"}));
        assert_eq!(copied["text"], "# Title\n\n- one\n- two");
    }

    #[test]
    fn carets_go_through_the_hub() {
        let mut me = fresh();
        let mut peer = me.fork();
        call(&mut me, json!({"op": "insert", "text": "hello"}));
        call(&mut me, json!({"op": "push"}));
        call(&mut peer, json!({"op": "pull"}));
        call(
            &mut me,
            json!({"op": "setUser", "name": "Ana", "color": "#ff0000"}),
        );
        call(&mut me, json!({"op": "select", "anchor": 1, "head": 4}));
        call(&mut me, json!({"op": "presence"}));
        call(&mut peer, json!({"op": "presence"}));
        let carets = call(&mut peer, json!({"op": "carets"}))["carets"].clone();
        assert_eq!(carets.as_array().unwrap().len(), 1);
        assert_eq!(carets[0]["name"], "Ana");
        assert_eq!(carets[0]["color"], "#ff0000");
        assert_eq!(
            (carets[0]["anchor"].clone(), carets[0]["head"].clone()),
            (json!(1), json!(4))
        );
        assert_eq!(
            call(&mut me, json!({"op": "carets"}))["carets"][0]["name"],
            "You"
        );

        // Closing a session takes its caret away.
        drop(me);
        assert!(
            call(&mut peer, json!({"op": "carets"}))["carets"]
                .as_array()
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn the_profile_is_who_the_user_is_in_every_document() {
        scratch_store();
        let first = store_call(&json!({"op": "profile"}))["profile"].clone();
        assert_eq!(first["setupComplete"], false, "the first launch asks");
        let refused = store_call(&json!({"op": "saveProfile", "handle": "No Spaces"}));
        assert_eq!(refused["ok"], false);
        let saved = store_call(&json!({
            "op": "saveProfile", "name": "Ana Lopez", "handle": "ana", "color": "#1f8a70"
        }));
        assert_eq!(saved["profile"]["setupComplete"], true, "{saved}");
        assert_eq!(saved["profile"]["userId"], first["userId"]);
        assert_eq!(
            store_call(&json!({"op": "handleFromName", "name": "Bo Li"}))["handle"],
            "bo-li"
        );

        // A document opened now is written by Ana, under her id and handle.
        let mut me = Session::open(&json!({ "new": true })).unwrap();
        assert_eq!(
            call(&mut me, json!({"op": "actor"}))["actor"],
            first["userId"]
        );
        call(&mut me, json!({"op": "insert", "text": "hi"}));
        call(&mut me, json!({"op": "push"}));
        let entries = call(&mut me, json!({"op": "history"}))["entries"].clone();
        let author = &entries.as_array().unwrap().last().unwrap()["author"];
        assert_eq!(
            (author["name"].clone(), author["actorId"].clone()),
            (json!("Ana Lopez"), first["userId"].clone())
        );
        let people = call(&mut me, json!({"op": "people"}));
        assert_eq!(people["localHandle"], "ana");
        assert_eq!(people["rows"][0]["kind"], "you");
        assert_eq!(people["rows"][0]["color"], "#1f8a70");
    }

    #[test]
    fn people_claims_and_actors_go_through_the_hub() {
        scratch_store();
        let mut me = Session::open(&json!({ "new": true })).unwrap();
        call(&mut me, json!({"op": "insert", "text": "one\ntwo"}));
        call(&mut me, json!({"op": "push"}));
        let mut peer = me.fork();
        call(
            &mut peer,
            json!({"op": "setUser", "name": "Bo", "color": "#e5484d"}),
        );
        call(&mut peer, json!({"op": "select", "anchor": 5, "head": 5}));
        let claim = call(&mut peer, json!({"op": "claim"}))["claim"].clone();
        let second = claim["blockIds"][0].as_str().unwrap().to_owned();
        let sent = call(&mut peer, json!({"op": "presence"}));
        assert!(sent["gapMs"].as_i64().unwrap() >= 50, "{sent}");
        call(&mut me, json!({"op": "select", "anchor": 0, "head": 0}));
        call(&mut me, json!({"op": "presence"}));

        let carets = call(&mut me, json!({"op": "carets"}))["carets"].clone();
        assert_eq!(carets[0]["claim"]["blockIds"], json!([second]));
        let people = call(&mut me, json!({"op": "people"}));
        let rows = people["rows"].as_array().unwrap();
        assert_eq!(rows.len(), 2, "{people}");
        let bo = rows.iter().find(|r| r["name"] == "Bo").unwrap();
        assert_eq!(
            (bo["kind"].clone(), bo["status"].clone()),
            (json!("peer"), json!("typing in ¶2"))
        );
        assert_eq!(bo["handle"], "bo");
        let actors = call(&mut me, json!({"op": "actors", "nearBlockId": second}));
        assert_eq!(actors["actors"].as_array().unwrap().len(), 1, "{actors}");

        call(&mut peer, json!({"op": "unclaim"}));
        call(&mut peer, json!({"op": "presence"}));
        let carets = call(&mut me, json!({"op": "carets"}))["carets"].clone();
        assert!(carets[0]["claim"].is_null());
        // Gone, Bo is no longer in the session, but a writer stays known.
        call(&mut peer, json!({"op": "insert", "text": "!"}));
        call(&mut peer, json!({"op": "push"}));
        drop(peer);
        let people = call(&mut me, json!({"op": "people"}));
        assert_eq!(people["rows"].as_array().unwrap().len(), 1);
        let bo = people["people"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["name"] == "Bo");
        assert_eq!(bo.unwrap()["online"], false);
    }

    #[test]
    fn drafts_autosave_save_as_and_reopen() {
        let dir = scratch_store();
        let mut s = Session::open(&json!({ "new": true })).unwrap();
        assert_eq!(s.view()["persist"]["isDraft"], true);
        call(&mut s, json!({"op": "insert", "text": "Kept"}));
        call(&mut s, json!({"op": "push"}));
        assert_eq!(s.view()["persist"]["dirty"], true);
        std::thread::sleep(std::time::Duration::from_millis(40));
        let tick = call(&mut s, json!({"op": "tick"}));
        assert_eq!(tick["saved"], true, "{tick}");
        assert_eq!(tick["persist"]["dirty"], false);
        let listing = store_call(&json!({"op": "listing"}))["listing"].clone();
        assert_eq!(listing["recents"][0]["path"], Value::Null, "a draft");
        assert_eq!(listing["recents"][0]["preview"], "Kept");

        let save = call(&mut s, json!({"op": "save"}));
        assert_eq!(save["needsSaveAs"], true);
        assert!(
            save["suggested"]
                .as_str()
                .unwrap()
                .ends_with("Untitled.collabdoc")
        );
        let file = dir.join("Report.collabdoc");
        let saved = call(&mut s, json!({"op": "saveAs", "path": file}));
        assert_eq!(saved["ok"], true, "{saved}");
        assert_eq!(
            s.view()["title"],
            "Report",
            "an untitled document takes the name"
        );
        assert_eq!(call(&mut s, json!({"op": "close"}))["ok"], true);
        drop(s);

        let mut again = Session::open(&json!({ "path": file })).unwrap();
        let blocks = all_blocks(&mut again);
        assert_eq!(blocks[0]["text"], "Kept");
        assert_eq!(again.view()["persist"]["path"], file.display().to_string());
        let md = dir.join("report.md");
        call(&mut again, json!({"op": "exportMarkdown", "path": md}));
        assert_eq!(std::fs::read_to_string(md).unwrap(), "# Report\n\nKept\n");
    }

    #[test]
    fn a_crash_leaves_a_draft_to_recover() {
        let dir = scratch_store();
        let mut s = Session::open(&json!({ "new": true })).unwrap();
        call(
            &mut s,
            json!({"op": "insert", "text": "typed just before the crash"}),
        );
        call(&mut s, json!({"op": "push"}));
        let id = s.view()["persist"]["docId"].as_str().unwrap().to_owned();
        std::mem::forget(s); // killed: nothing closed or saved
        // The next run of the app: a new store over the same folders.
        store_call(&json!({
            "op": "configure",
            "userData": dir.join("user"),
            "documentsDir": dir.join("docs"),
        }));

        let listing = store_call(&json!({"op": "listing"}))["listing"].clone();
        assert_eq!(listing["recoveries"][0]["docId"], id);
        let mut recovered = Session::open(&json!({ "draft": id })).unwrap();
        assert_eq!(
            call(&mut recovered, json!({"op": "openInfo"}))["recoveredEdits"],
            true
        );
        assert_eq!(
            all_blocks(&mut recovered)[0]["text"],
            "typed just before the crash"
        );
        // Discarded on request: gone from the recents and the disk.
        call(&mut recovered, json!({"op": "close", "discard": true}));
        let listing = store_call(&json!({"op": "listing"}))["listing"].clone();
        assert!(listing["recents"].as_array().unwrap().is_empty());
        assert!(listing["recoveries"].as_array().unwrap().is_empty());
    }

    const PNG_B64: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

    #[test]
    fn images_go_to_disk_and_back_through_the_bridge() {
        let mut me = fresh();
        let r = call(
            &mut me,
            json!({"op": "insertImage", "base64": PNG_B64, "alt": "dot"}),
        );
        assert_eq!(r["changed"], true, "{r}");
        assert_eq!(call(&mut me, json!({"op": "push"}))["ok"], true);
        let blocks = all_blocks(&mut me);
        let figure = blocks.iter().find(|b| b["kind"] == "atom").unwrap();
        assert_eq!(figure["nodeName"], "imageFigure");
        assert_eq!(figure["attrs"]["alt"], "dot");
        let src = figure["attrs"]["src"].as_str().unwrap().to_owned();
        let hash = src.strip_prefix("asset:").unwrap();

        // A second participant reads the bytes through the store.
        let other = Box::into_raw(Box::new(me.fork()));
        let c_hash = CString::new(hash).unwrap();
        let mut len = 0usize;
        let ptr = unsafe { cd_asset(other, c_hash.as_ptr(), &mut len) };
        assert!(!ptr.is_null());
        let bytes = unsafe { std::slice::from_raw_parts(ptr, len) }.to_vec();
        assert!(bytes.starts_with(b"\x89PNG"));
        unsafe { cd_bytes_free(ptr, len) };
        drop(unsafe { Box::from_raw(other) });

        // The draft on disk already holds them (written before the journal).
        let doc = me.shared.borrow().hub.loro().clone();
        let id = collabdoc_core::document::meta_string(&doc, "docId");
        assert!(with_store(|s| s.asset(&id, hash).is_some()));

        // Not an image: refused with the reason.
        let bad = call(&mut me, json!({"op": "insertImage", "base64": "aGVsbG8="}));
        assert_eq!(bad["ok"], false);
        assert!(
            bad["error"].as_str().unwrap().contains("not an image"),
            "{bad}"
        );
    }

    #[test]
    fn figures_are_edited_and_drawn_natively() {
        let mut me = fresh();
        assert_eq!(
            call(
                &mut me,
                json!({"op": "insertFigure", "name": "mermaidFigure"})
            )["changed"],
            true
        );
        let blocks = all_blocks(&mut me);
        let index = blocks.iter().position(|b| b["kind"] == "atom").unwrap();
        let r = call(
            &mut me,
            json!({"op": "setCaption", "block": index, "text": "Flow"}),
        );
        assert_eq!(r["changed"], true);
        let r = call(
            &mut me,
            json!({"op": "setFigureAttr", "block": index, "key": "align", "value": "right"}),
        );
        assert_eq!(r["changed"], true);
        let blocks = all_blocks(&mut me);
        assert_eq!(blocks[index]["caption"], "Flow");
        assert_eq!(blocks[index]["attrs"]["align"], "right");

        let source = CString::new(blocks[index]["attrs"]["source"].as_str().unwrap()).unwrap();
        let (mut len, mut err) = (0usize, std::ptr::null_mut());
        let ptr = unsafe { cd_render_mermaid(source.as_ptr(), 1.5, &mut len, &mut err) };
        assert!(!ptr.is_null() && err.is_null());
        assert!(unsafe { std::slice::from_raw_parts(ptr, len) }.starts_with(b"\x89PNG"));
        unsafe { cd_bytes_free(ptr, len) };

        let bad = CString::new("").unwrap();
        let ptr = unsafe { cd_render_mermaid(bad.as_ptr(), 1.0, &mut len, &mut err) };
        assert!(ptr.is_null() && !err.is_null());
        unsafe { cd_string_free(err) };
    }

    #[test]
    fn history_versions_and_restore_through_the_bridge() {
        let mut me = fresh();
        call(
            &mut me,
            json!({"op": "setUser", "name": "Ana", "color": "#ff0000"}),
        );
        call(&mut me, json!({"op": "insert", "text": "first draft"}));
        call(&mut me, json!({"op": "push"}));
        let cp = call(&mut me, json!({"op": "addCheckpoint", "name": "Draft 1"}));
        assert_eq!(cp["checkpoint"]["name"], "Draft 1");
        call(&mut me, json!({"op": "push"}));
        call(&mut me, json!({"op": "selectAll"}));
        call(&mut me, json!({"op": "insert", "text": "rewritten"}));
        call(&mut me, json!({"op": "push"}));

        let h = call(&mut me, json!({"op": "history"}));
        let entries = h["entries"].as_array().unwrap();
        let typed = entries
            .iter()
            .find(|e| e["details"].to_string().contains("first draft"))
            .unwrap();
        assert_eq!(typed["author"]["name"], "Ana");
        assert_eq!(typed["author"]["color"], "#ff0000");
        assert_eq!(h["checkpoints"][0]["name"], "Draft 1");
        assert_eq!(h["actorId"], me.editor.document().actor());
        let diff = call(&mut me, json!({"op": "historyDiff", "id": typed["id"]}));
        assert!(diff["hunks"].to_string().contains("first draft"));
        let authors = call(&mut me, json!({"op": "blockAuthors"}));
        let block_id = all_blocks(&mut me)[0]["blockId"]
            .as_str()
            .unwrap()
            .to_owned();
        assert_eq!(authors["authors"][&block_id]["name"], "Ana");

        // View the checkpoint: read-only, at its text.
        let frontiers = h["checkpoints"][0]["frontiers"].to_string();
        let c = CString::new(frontiers.clone()).unwrap();
        let mut err = std::ptr::null_mut();
        let version = unsafe { cd_open_version(&me, c.as_ptr(), &mut err) };
        assert!(!version.is_null());
        let version = unsafe { &mut *version };
        assert_eq!(all_blocks(version)[0]["text"], "first draft");
        let typed = call(version, json!({"op": "insert", "text": "nope"}));
        assert_eq!(typed["changed"], false);
        assert_eq!(all_blocks(version)[0]["text"], "first draft");
        assert_eq!(call(version, json!({"op": "copyMarkdown"}))["ok"], true);
        unsafe { cd_free(version) };

        // Restore it: one change, undoable.
        let r = call(
            &mut me,
            json!({"op": "restore", "frontiers": h["checkpoints"][0]["frontiers"]}),
        );
        assert_eq!(r["changed"], true);
        assert_eq!(all_blocks(&mut me)[0]["text"], "first draft");
        call(&mut me, json!({"op": "push"}));
        let after = call(&mut me, json!({"op": "history"}));
        assert!(after["entries"].to_string().contains("Restore version"));
        call(&mut me, json!({"op": "undo"}));
        assert_eq!(all_blocks(&mut me)[0]["text"], "rewritten");

        // A version the document does not have.
        let bad = CString::new(r#"[{"peer":"1","counter":999}]"#).unwrap();
        let none = unsafe { cd_open_version(&me, bad.as_ptr(), &mut err) };
        assert!(none.is_null() && !err.is_null());
        unsafe { cd_string_free(err) };
    }
}
