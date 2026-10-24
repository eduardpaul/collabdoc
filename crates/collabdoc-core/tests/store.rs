//! Keeping documents on disk: ports of the TS persistence tests
//! (`atomic`, `autosave`, `recents`, `store`) plus the journal that bounds
//! what a crash can lose.

use std::fs;
use std::path::{Path, PathBuf};

use collabdoc_core::file;
use collabdoc_core::store::*;
use collabdoc_core::{Document, Editor};

/// A fresh folder for one test, removed when the guard drops.
struct Scratch(PathBuf);

impl Scratch {
    fn new(name: &str) -> Self {
        let dir =
            std::env::temp_dir().join(format!("collabdoc-store-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        Scratch(dir)
    }

    fn config(&self) -> StoreConfig {
        StoreConfig::new(self.0.join("user"), self.0.join("docs"))
    }

    fn path(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

const T0: i64 = 1_760_000_000_000;

fn texts(document: &Document) -> Vec<String> {
    document.blocks().iter().map(|b| b.text.clone()).collect()
}

fn type_into(document: Document, text: &str) -> Document {
    let mut e = Editor::new(document);
    let end = e.len();
    e.move_to(end);
    e.insert_text(text);
    e.into_document()
}

// ── atomic (AC-04.4) ──

#[test]
fn an_interrupted_write_leaves_the_previous_file() {
    let s = Scratch::new("atomic");
    let file = s.path("note.collabdoc");
    fs::write(&file, "version-one").unwrap();
    let err = atomic_write_with(&file, b"version-two", true).unwrap_err();
    assert!(err.to_string().contains("simulated failure"));
    assert_eq!(fs::read_to_string(&file).unwrap(), "version-one");
    assert_eq!(
        fs::read_to_string(s.path("note.collabdoc.tmp")).unwrap(),
        "version-two"
    );

    atomic_write(&file, b"version-two").unwrap();
    assert_eq!(fs::read_to_string(&file).unwrap(), "version-two");
}

// ── autosave (AC-04.3) ──

#[test]
fn autosave_waits_two_seconds_after_the_last_edit() {
    let mut a = Autosave::new(2000, 30_000);
    assert!(!a.due(T0));
    a.touch(T0);
    assert!(!a.due(T0 + 1999));
    a.touch(T0 + 1999);
    assert!(!a.due(T0 + 3998));
    assert!(a.due(T0 + 3999));
}

#[test]
fn autosave_writes_at_thirty_seconds_even_while_typing() {
    let mut a = Autosave::new(2000, 30_000);
    a.touch(T0);
    for i in 1..30 {
        a.touch(T0 + i * 1000);
        assert!(!a.due(T0 + i * 1000));
    }
    assert!(a.due(T0 + 30_000));
}

// ── recents (AC-04.8) ──

#[test]
fn recents_keep_the_newest_fifty_each_under_a_kilobyte() {
    let mut recents = vec![];
    for i in 0..60 {
        recents = upsert_recent(
            &recents,
            &RecentRecord {
                doc_id: format!("doc-{i}"),
                title: format!("Title {i}"),
                path: Some(format!("/tmp/doc-{i}.collabdoc")),
                updated_at: iso8601(T0 + i * 1000),
                preview: "x".repeat(120),
            },
        );
    }
    assert_eq!(recents.len(), RECENTS_LIMIT);
    assert_eq!(recents[0].doc_id, "doc-59");
    assert_eq!(recents[49].doc_id, "doc-10");
    assert!(
        recents
            .iter()
            .all(|r| serde_json::to_string(r).unwrap().len() <= RECENTS_ENTRY_MAX_BYTES)
    );
}

#[test]
fn an_oversized_entry_is_cut_to_a_kilobyte() {
    let capped = cap_recent(&RecentRecord {
        doc_id: "d".into(),
        title: "T".into(),
        path: Some(format!("/very/{}file.collabdoc", "long/".repeat(80))),
        updated_at: "2026-01-01T00:00:00.000Z".into(),
        preview: "p".repeat(500),
    });
    assert!(serde_json::to_string(&capped).unwrap().len() <= RECENTS_ENTRY_MAX_BYTES);
}

#[test]
fn recents_read_the_ts_apps_file() {
    let s = Scratch::new("recents-ts");
    let file = s.path("recents.json");
    // As `saveRecentsFile` writes it.
    fs::write(
        &file,
        r#"{
  "recents": [
    { "docId": "a", "title": "Plan", "path": "/x/Plan.collabdoc", "updatedAt": "2026-10-24T10:00:00.000Z", "preview": "first words" },
    { "docId": "b", "title": "Draft", "path": null, "updatedAt": "2026-10-24T11:00:00.000Z", "preview": "" },
    { "nonsense": true }
  ]
}"#,
    )
    .unwrap();
    let recents = load_recents(&file);
    assert_eq!(recents.len(), 2);
    assert_eq!(recents[1].path, None);
    save_recents(&file, &recents).unwrap();
    assert_eq!(load_recents(&file), recents);
    assert!(fs::read_to_string(&file).unwrap().contains("\"updatedAt\""));
}

#[test]
fn times_read_and_write_as_iso_8601() {
    assert_eq!(iso8601(0), "1970-01-01T00:00:00.000Z");
    assert_eq!(iso8601(1_761_300_736_123), "2025-10-24T10:12:16.123Z");
    for ms in [0, 951_782_400_000, T0, T0 + 86_399_999, 4_102_444_800_000] {
        assert_eq!(parse_iso8601(&iso8601(ms)), Some(ms));
    }
    assert_eq!(parse_iso8601("yesterday"), None);
}

// ── store ──

#[test]
fn a_saved_file_reopens_with_its_history() {
    let s = Scratch::new("history");
    let mut store = Store::open(s.config());
    let document = store.create("Plan", "ana", T0).unwrap();
    let document = type_into(document, "Persisted history");
    store.changed(document.loro(), T0 + 10).unwrap();
    let file = s.path("docs/Plan.collabdoc");
    store.save_to(document.loro(), &file, T0 + 20).unwrap();
    assert!(!store.state(document.loro()).unwrap().dirty);

    let bytes = fs::read(&file).unwrap();
    assert!(bytes.starts_with(b"CLBDOC01"));
    let header = file::read_header(&bytes).unwrap();
    assert_eq!(
        (header.doc_id.as_str(), header.title.as_str()),
        (document.doc_id().as_str(), "Plan")
    );

    let mut other = Store::open(s.config());
    let opened = other.open_collabdoc(&file, "bo", T0 + 30).unwrap();
    assert_eq!(texts(&opened.document), texts(&document));
    let ids = |d: &Document| {
        d.blocks()
            .iter()
            .map(|b| b.block_id.clone())
            .collect::<Vec<_>>()
    };
    assert_eq!(ids(&opened.document), ids(&document));
    assert_eq!(
        opened.document.loro().len_changes(),
        document.loro().len_changes(),
        "every change, with its author and time"
    );
    assert!(!opened.recovered_edits);
}

#[test]
fn a_draft_is_autosaved_and_recovered_after_a_crash() {
    let s = Scratch::new("draft");
    let mut store = Store::open(s.config());
    let document = store.create("Untitled", "ana", T0).unwrap();
    let id = document.doc_id();
    let document = type_into(document, "Recover me");
    store.changed(document.loro(), T0 + 100).unwrap();
    assert!(!store.tick(document.loro(), T0 + 1000).unwrap(), "not yet");
    assert!(
        store.tick(document.loro(), T0 + 2100).unwrap(),
        "2 s after the edit"
    );
    let draft = draft_path(&s.config().user_data, &id);
    let decoded = file::decode(&fs::read(&draft).unwrap()).unwrap();
    let saved = Document::from_snapshot(&decoded.snapshot, "x").unwrap();
    assert_eq!(texts(&saved), ["Recover me"]);
    drop(store); // a crash: nothing released

    let mut again = Store::open(s.config());
    let listing = again.listing();
    assert!(
        listing
            .recents
            .iter()
            .any(|r| r.record.doc_id == id && r.record.path.is_none())
    );
    let recovered = again.recover(&id, "ana", T0 + 5000).unwrap();
    assert_eq!(recovered.document.title(), "Untitled");
    assert_eq!(texts(&recovered.document), ["Recover me"]);
}

#[test]
fn a_crash_before_autosave_loses_nothing() {
    // AC-04.3 and spec 23's Phase 2: the journal holds every edit.
    let s = Scratch::new("journal");
    let mut store = Store::open(s.config());
    let mut document = store.create("Untitled", "ana", T0).unwrap();
    let id = document.doc_id();
    for (i, word) in ["one ", "two ", "three"].iter().enumerate() {
        document = type_into(document, word);
        store.changed(document.loro(), T0 + 300 * i as i64).unwrap();
    }
    drop(store); // killed 0.6 s after the first edit: no autosave yet

    let mut again = Store::open(s.config());
    let offers = again.listing().recoveries;
    assert_eq!(offers.len(), 1, "offered: newer than any recents entry");
    assert_eq!(offers[0].doc_id, id);
    assert_eq!(offers[0].preview, "one two three");
    let recovered = again.recover(&id, "ana", T0 + 10_000).unwrap();
    assert!(recovered.recovered_edits);
    assert_eq!(texts(&recovered.document), ["one two three"]);
    assert!(
        again.state(recovered.document.loro()).unwrap().dirty,
        "and written soon"
    );
    assert!(again.tick(recovered.document.loro(), T0 + 12_000).unwrap());
    // Undo does not take the recovered text away.
    let mut e = Editor::new(recovered.document);
    assert!(!e.undo());
}

#[test]
fn edits_after_a_files_last_save_come_back_when_it_is_opened() {
    let s = Scratch::new("journal-file");
    let file = s.path("notes.collabdoc");
    let mut store = Store::open(s.config());
    let document = type_into(store.create("Notes", "ana", T0).unwrap(), "saved");
    store.save_to(document.loro(), &file, T0 + 10).unwrap();
    let mut e = Editor::new(document);
    let end = e.len();
    e.move_to(end);
    e.newline();
    e.insert_text("typed after the save");
    store.changed(e.document().loro(), T0 + 500).unwrap();
    drop(store); // crash

    let before = fs::read(&file).unwrap();
    let mut again = Store::open(s.config());
    let opened = again.open_collabdoc(&file, "ana", T0 + 5000).unwrap();
    assert!(opened.recovered_edits);
    assert_eq!(texts(&opened.document), ["saved", "typed after the save"]);
    assert_eq!(
        fs::read(&file).unwrap(),
        before,
        "the file waits for autosave"
    );
    assert!(again.tick(opened.document.loro(), T0 + 8000).unwrap());
    let reread = file::decode(&fs::read(&file).unwrap()).unwrap();
    let reread = Document::from_snapshot(&reread.snapshot, "x").unwrap();
    assert_eq!(texts(&reread), ["saved", "typed after the save"]);
}

#[test]
fn a_copy_of_the_file_does_not_get_the_originals_edits() {
    let s = Scratch::new("journal-copy");
    let file = s.path("a.collabdoc");
    let copy = s.path("b.collabdoc");
    let mut store = Store::open(s.config());
    let document = type_into(store.create("A", "ana", T0).unwrap(), "base");
    store.save_to(document.loro(), &file, T0 + 10).unwrap();
    fs::copy(&file, &copy).unwrap();
    let document = type_into(document, " more");
    store.changed(document.loro(), T0 + 500).unwrap();
    drop(store);

    let mut again = Store::open(s.config());
    let opened = again.open_collabdoc(&copy, "ana", T0 + 5000).unwrap();
    assert!(!opened.recovered_edits);
    assert_eq!(texts(&opened.document), ["base"]);
}

#[test]
fn a_torn_journal_tail_is_ignored() {
    let s = Scratch::new("journal-torn");
    let mut store = Store::open(s.config());
    let document = store.create("Untitled", "ana", T0).unwrap();
    let id = document.doc_id();
    let document = type_into(document, "kept");
    store.changed(document.loro(), T0 + 10).unwrap();
    drop(store);
    // The crash cut the next frame short.
    let journal = journal_path(&s.config().user_data, &id);
    let mut bytes = fs::read(&journal).unwrap();
    bytes.extend_from_slice(&[40, 0, 0, 0, 1, 2, 3]);
    fs::write(&journal, bytes).unwrap();

    let mut again = Store::open(s.config());
    let recovered = again.recover(&id, "ana", T0 + 5000).unwrap();
    assert_eq!(texts(&recovered.document), ["kept"]);
}

#[test]
fn a_newer_schema_is_refused_and_the_file_left_alone() {
    // AC-04.10
    let s = Scratch::new("schema");
    let file = s.path("future.collabdoc");
    // A file from a newer CollabDoc: its header says schema 4.
    let current = file::encode("future", "Future", T0, b"nope", &[]);
    let mut header = file::read_header(&current).unwrap();
    header.schema_version = 4;
    let json = serde_json::to_vec(&header).unwrap();
    let mut bytes = b"CLBDOC01".to_vec();
    bytes.extend_from_slice(&(json.len() as u32).to_le_bytes());
    bytes.extend_from_slice(&json);
    bytes.extend_from_slice(b"nope");
    fs::write(&file, &bytes).unwrap();
    let before = fs::metadata(&file).unwrap().modified().unwrap();
    let mut store = Store::open(s.config());
    let err = store.open_collabdoc(&file, "ana", T0).err().unwrap();
    assert!(err.contains("schema version"), "{err}");
    assert_eq!(fs::read(&file).unwrap(), bytes);
    assert_eq!(fs::metadata(&file).unwrap().modified().unwrap(), before);
}

#[test]
fn a_truncated_asset_section_opens_with_a_warning() {
    // AC-04.13 (the rest waits for image figures, Phase 3)
    let s = Scratch::new("assets");
    let file = s.path("figs.collabdoc");
    let document = Document::create("Figs", "ana");
    let snapshot = document.loro().export(loro::ExportMode::Snapshot).unwrap();
    let assets = [file::Asset {
        hash: "a".repeat(64),
        mime: "image/png".into(),
        bytes: vec![1, 2, 3],
    }];
    let bytes = file::encode(&document.doc_id(), "Figs", T0, &snapshot, &assets);
    fs::write(&file, &bytes[..bytes.len() - 1]).unwrap();
    let mut store = Store::open(s.config());
    let opened = store.open_collabdoc(&file, "ana", T0).unwrap();
    assert_eq!(opened.warnings, ["truncated-assets"]);
}

#[test]
fn markdown_imports_into_a_draft_and_the_source_is_never_written() {
    // AC-04.7
    let s = Scratch::new("markdown");
    let md = s.path("notes.md");
    let original = "# Notes\n\nHello from **markdown**\n\n- one\n- two\n";
    fs::write(&md, original).unwrap();
    let mut store = Store::open(s.config());
    let opened = store.open_path(&md, "ana", T0).unwrap();
    let document = opened.document;
    assert_eq!(document.title(), "Notes");
    assert_eq!(texts(&document), ["Hello from markdown", "one", "two"]);
    assert!(store.state(document.loro()).unwrap().is_draft);
    assert_eq!(
        store.suggested_path(document.loro()),
        s.path("notes.collabdoc")
    );
    // The import is the starting point, not an undoable edit.
    let mut e = Editor::new(document);
    assert!(!e.undo());
    let document = e.into_document();

    store
        .save_to(document.loro(), &s.path("notes.collabdoc"), T0 + 10)
        .unwrap();
    assert_eq!(fs::read_to_string(&md).unwrap(), original);
    assert!(
        fs::read(s.path("notes.collabdoc"))
            .unwrap()
            .starts_with(b"CLBDOC01")
    );

    // Without a heading the file name is the title; plain text stays text.
    let txt = s.path("todo list.txt");
    fs::write(&txt, "buy milk\ncall Bo").unwrap();
    let opened = store.open_path(&txt, "ana", T0 + 20).unwrap();
    assert_eq!(opened.document.title(), "todo list");
    assert_eq!(texts(&opened.document), ["buy milk", "call Bo"]);
}

#[test]
fn markdown_export_puts_the_title_first() {
    let s = Scratch::new("export");
    let mut e = Editor::new(Document::create("Plan", "ana"));
    e.paste("Intro with **bold**.\n\n- one\n- two");
    let out = s.path("plan.md");
    Store::export_markdown(e.document(), &out).unwrap();
    assert_eq!(
        fs::read_to_string(&out).unwrap(),
        "# Plan\n\nIntro with **bold**.\n\n- one\n- two\n"
    );
}

#[test]
fn saving_a_draft_asks_for_a_place_then_drops_the_draft() {
    let s = Scratch::new("save-as");
    let mut store = Store::open(s.config());
    let document = type_into(store.create("Report", "ana", T0).unwrap(), "x");
    store.changed(document.loro(), T0).unwrap();
    assert!(matches!(
        store.save(document.loro(), T0).unwrap(),
        SaveOutcome::NeedsSaveAs
    ));
    assert_eq!(
        store.suggested_path(document.loro()),
        s.path("docs/Report.collabdoc")
    );
    let file = s.path("docs/Report.collabdoc");
    store.save_to(document.loro(), &file, T0 + 1).unwrap();
    assert!(!draft_path(&s.config().user_data, &document.doc_id()).exists());
    let state = store.state(document.loro()).unwrap();
    assert!(!state.is_draft && !state.dirty);
    assert!(
        matches!(store.save(document.loro(), T0 + 2).unwrap(), SaveOutcome::Saved(p) if p == file)
    );
    let listing = store.listing();
    assert_eq!(
        listing.recents[0].record.path.as_deref(),
        Some(file.to_str().unwrap())
    );
    assert_eq!(listing.recents[0].record.preview, "x");
}

#[test]
fn an_untouched_draft_leaves_no_trace_and_released_files_no_journal() {
    let s = Scratch::new("release");
    let mut store = Store::open(s.config());
    let empty = store.create("Untitled", "ana", T0).unwrap();
    store.release(empty.loro(), T0 + 1).unwrap();
    assert!(!draft_path(&s.config().user_data, &empty.doc_id()).exists());
    assert!(store.listing().recents.is_empty());

    let file = s.path("kept.collabdoc");
    let document = type_into(store.create("Kept", "ana", T0).unwrap(), "words");
    store.save_to(document.loro(), &file, T0 + 2).unwrap();
    let document = type_into(document, " and more");
    store.changed(document.loro(), T0 + 3).unwrap();
    store.release(document.loro(), T0 + 4).unwrap();
    assert!(!journal_path(&s.config().user_data, &document.doc_id()).exists());
    let mut again = Store::open(s.config());
    let opened = again.open_collabdoc(&file, "ana", T0 + 5).unwrap();
    assert_eq!(
        texts(&opened.document),
        ["words and more"],
        "written on release"
    );
}

#[test]
fn moved_files_are_marked_and_discarded_drafts_are_gone() {
    // AC-04.9, AC-04.11
    let s = Scratch::new("missing");
    let mut store = Store::open(s.config());
    let document = type_into(store.create("Gone", "ana", T0).unwrap(), "x");
    let file = s.path("gone.collabdoc");
    store.save_to(document.loro(), &file, T0).unwrap();
    store.release(document.loro(), T0).unwrap();
    fs::remove_file(&file).unwrap();
    let listing = store.listing();
    assert!(listing.recents[0].missing);
    store.remove_recent(&document.doc_id()).unwrap();
    assert!(store.listing().recents.is_empty());

    let draft = type_into(store.create("Scrap", "ana", T0).unwrap(), "scrap");
    store.changed(draft.loro(), T0).unwrap();
    store.tick(draft.loro(), T0 + 3000).unwrap();
    store.discard_draft(&draft.doc_id()).unwrap();
    assert!(!draft_path(&s.config().user_data, &draft.doc_id()).exists());
    assert!(store.listing().recents.is_empty());
}

#[test]
fn a_draft_is_offered_only_when_newer_than_its_recents_entry() {
    let s = Scratch::new("offers");
    let mut store = Store::open(s.config());
    let document = type_into(store.create("Untitled", "ana", T0).unwrap(), "typed");
    store.changed(document.loro(), T0).unwrap();
    // The autosave wrote the draft and stamped the recents entry "now":
    // closing normally leaves nothing to recover.
    let now = collabdoc_core::document::now_ms();
    store.tick(document.loro(), now).unwrap();
    store.release(document.loro(), now).unwrap();
    assert!(Store::open(s.config()).listing().recoveries.is_empty());
    // An entry older than the draft (a crash after a later write): offered.
    let mut recents = load_recents(&recents_path(&s.config().user_data));
    recents[0].updated_at = iso8601(now - 60_000);
    save_recents(&recents_path(&s.config().user_data), &recents).unwrap();
    let offers = Store::open(s.config()).listing().recoveries;
    assert_eq!(offers.len(), 1);
    assert_eq!(offers[0].preview, "typed");
}

#[test]
fn file_names_follow_the_ts_rules() {
    assert_eq!(safe_file_name("a/b: c"), "ab c");
    assert_eq!(safe_file_name("  \u{7}  "), "Untitled");
    assert_eq!(
        default_collabdoc_path(Path::new("/d"), "Q3 <plan>?"),
        Path::new("/d/Q3 plan.collabdoc")
    );
    assert_eq!(
        twin_collabdoc_path(Path::new("/x/notes.MD")),
        Path::new("/x/notes.collabdoc")
    );
}
