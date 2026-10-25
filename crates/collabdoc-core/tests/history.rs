//! History and attribution (spec 05): ports of `history.test.ts` and
//! `history-index.test.ts`, with participants as editors synced through a
//! hub (the TS tests drive agents through tool calls, which come with the
//! MCP server), plus restore (AC-05.7).

use collabdoc_core::history::{self, AuthorRecord, HistoryEntry, HistoryIndex};
use collabdoc_core::schema::mark_bit;
use collabdoc_core::sync::Hub;
use collabdoc_core::{Document, Editor, ListKind};
use loro::{LoroDoc, LoroValue};

fn record(actor: &str, name: &str, role: &str) -> AuthorRecord {
    AuthorRecord {
        actor_id: actor.into(),
        name: name.into(),
        color: "#336699".into(),
        role: role.into(),
        handle: None,
    }
}

/// A participant on `base`'s document, identified in the authors map.
fn join(base: &Document, actor: &str, name: &str, role: &str) -> Editor {
    let mut e = Editor::new(base.fork(actor));
    e.set_author(record(actor, name, role));
    e
}

fn sync(hub: &Hub, editors: &mut [&mut Editor]) {
    for e in editors.iter() {
        hub.push(e.document()).unwrap();
    }
    for e in editors.iter_mut() {
        e.remote_change(|d| hub.pull(d)).unwrap();
    }
}

/// Types `text` as a new last paragraph.
fn add_paragraph(e: &mut Editor, text: &str) {
    let end = e.len();
    e.move_to(end);
    e.newline();
    e.insert_text(text);
}

fn by_detail<'a>(entries: &'a [HistoryEntry], needle: &str) -> Option<&'a HistoryEntry> {
    entries
        .iter()
        .find(|e| e.details.iter().any(|d| d.contains(needle)))
}

fn texts(e: &Editor) -> Vec<String> {
    e.blocks().iter().map(|b| b.label()).collect()
}

#[test]
fn every_change_is_attributed_to_its_author() {
    let base = Document::create("Notes", "base");
    let hub = Hub::new(&base);
    let mut ana = join(&base, "ana", "Ana", "human");
    let mut nova = join(&base, "nova", "Nova", "agent");
    add_paragraph(&mut ana, "Ana wrote this");
    sync(&hub, &mut [&mut ana, &mut nova]);
    add_paragraph(&mut nova, "Nova wrote this");
    sync(&hub, &mut [&mut ana, &mut nova]);
    let i = ana
        .blocks()
        .iter()
        .position(|b| b.text == "Ana wrote this")
        .unwrap();
    let start = ana.block_start(i) + "Ana wrote ".len();
    ana.replace(start..start + 4, "here");
    ana.set_title("Renamed");
    sync(&hub, &mut [&mut ana, &mut nova]);

    let history = history::list_history(hub.loro());
    let ana_entry = by_detail(&history, "Ana wrote this").unwrap();
    assert_eq!(
        (
            ana_entry.author.name.as_str(),
            ana_entry.author.actor_id.as_str()
        ),
        ("Ana", "ana")
    );
    assert_eq!(ana_entry.author.role.as_deref(), Some("human"));
    let nova_entry = by_detail(&history, "Nova wrote this").unwrap();
    assert_eq!(nova_entry.author.role.as_deref(), Some("agent"));
    let here = by_detail(&history, "inserted “here”").unwrap();
    assert_eq!(here.author.name, "Ana");
    assert_eq!(here.summary, "+4 −4  deleted 4 characters");
    let title = by_detail(&history, "set the title to “Renamed”").unwrap();
    assert_eq!(title.message, "rename to “Renamed”");
    assert!(history.iter().all(|e| e.timestamp > 0));
    assert!(history.iter().all(|e| e.frontiers.len() == 1));
    // The authors' registration commits carry no details and no message.
    assert!(
        history
            .iter()
            .all(|e| !e.details.is_empty() || !e.message.is_empty())
    );
    // The records sync with the document and survive a reload.
    let reopened =
        Document::from_snapshot(&hub.loro().export(loro::ExportMode::Snapshot).unwrap(), "x")
            .unwrap();
    let authors = history::read_authors(reopened.loro());
    assert!(
        authors
            .values()
            .any(|a| a.name == "Ana" && a.role == "human")
    );
    assert!(
        authors
            .values()
            .any(|a| a.name == "Nova" && a.role == "agent")
    );
}

#[test]
fn an_unidentified_peer_is_unknown_not_guessed_human() {
    let mut ana = Editor::new(Document::create("t", "ana"));
    ana.set_author(record("ana", "Ana", "human"));
    ana.insert_text("seed");
    let anon = LoroDoc::new();
    anon.import(
        &ana.document()
            .loro()
            .export(loro::ExportMode::Snapshot)
            .unwrap(),
    )
    .unwrap();
    let text = collabdoc_core::tree::flatten(&anon)
        .first()
        .map(|(l, _)| collabdoc_core::tree::ensure_text(&l.node))
        .unwrap();
    text.insert(text.len_unicode(), " anon").unwrap();
    anon.commit_with(loro::CommitOptions::new().commit_msg("anonymous edit"));
    let peer = anon.peer_id().to_string();
    let entry = history::list_history(&anon)
        .into_iter()
        .find(|e| e.peer == peer)
        .unwrap();
    assert_eq!(entry.author.name, format!("Unknown peer {}", &peer[..6]));
    assert_eq!(entry.author.role, None);
    assert_eq!(entry.details, ["inserted “anon”"]);
    assert_eq!(history::author_for_peer(&anon, &peer).role, None);
}

#[test]
fn deletions_marks_and_figures_are_described_and_versions_previewed() {
    let mut nova = Editor::new(Document::create("t", "nova"));
    nova.set_author(record("nova", "Nova", "agent"));
    nova.insert_text("first");
    let first_end = nova.len();
    nova.insert_figure("mermaidFigure");
    let png = collabdoc_core::figures::parse_data_uri(
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    )
    .unwrap()
    .1;
    nova.insert_image(png, "").unwrap();
    nova.insert_figure("infographicFigure");
    nova.set_selection(0, first_end);
    nova.toggle_mark(mark_bit("bold").unwrap());
    nova.set_selection(0, first_end);
    nova.insert_text("");
    // Delete the diagram: select it and Backspace.
    let fig = nova
        .blocks()
        .iter()
        .position(|b| b.node_name == "mermaidFigure")
        .unwrap();
    let at = nova.block_start(fig);
    nova.set_selection(at, at + 1);
    nova.backspace();

    let history = history::list_history(nova.document().loro());
    let details: Vec<&str> = history
        .iter()
        .flat_map(|e| e.details.iter().map(String::as_str))
        .collect();
    for want in [
        "added a Mermaid diagram",
        "added an image",
        "added an Infographic",
        "applied bold",
        "deleted 5 characters",
        "removed 1 block",
    ] {
        assert!(details.contains(&want), "{want} in {details:?}");
    }

    let insert = by_detail(&history, "inserted “first”").unwrap();
    let before = history::preview_at(nova.document().loro(), &insert.parent_frontiers);
    let after = history::preview_at(nova.document().loro(), &insert.frontiers);
    assert_eq!(
        before.iter().map(|b| b.text.as_str()).collect::<Vec<_>>(),
        [""]
    );
    assert_eq!(
        after.iter().map(|b| b.text.as_str()).collect::<Vec<_>>(),
        ["first"]
    );
    assert!(history::preview_at(nova.document().loro(), &[]).is_empty());
    let missing = [history::Frontier {
        peer: 1,
        counter: 99,
    }];
    assert!(history::preview_at(nova.document().loro(), &missing).is_empty());
    let live = history::live_preview(nova.document().loro());
    assert_eq!(
        live.iter().map(|b| b.kind.as_str()).collect::<Vec<_>>(),
        ["paragraph", "imageFigure", "infographicFigure"]
    );
    assert!(live[2].text.starts_with("infographic "));
    assert_eq!(history::format_stat(0, 0), "");
    assert_eq!(history::format_stat(3, 0), "+3");
}

#[test]
fn read_authors_skips_malformed_entries() {
    let doc = LoroDoc::new();
    history::write_author(&doc, &record("x", "X", "human"));
    let authors = doc.get_map(history::AUTHORS_KEY);
    authors.insert("junk", 42).unwrap();
    let partial: std::collections::HashMap<String, LoroValue> =
        [("actorId".to_string(), LoroValue::from("p"))].into();
    authors.insert("partial", partial).unwrap();
    let minimal: std::collections::HashMap<String, LoroValue> =
        [("name".to_string(), LoroValue::from("Min"))].into();
    authors.insert("minimal", minimal).unwrap();
    let read = history::read_authors(&doc);
    let mut keys: Vec<_> = read.keys().cloned().collect();
    keys.sort();
    let mut want = vec![doc.peer_id().to_string(), "minimal".to_string()];
    want.sort();
    assert_eq!(keys, want);
    assert_eq!(
        read["minimal"],
        AuthorRecord {
            actor_id: "minimal".into(),
            name: "Min".into(),
            color: "#8a7d6d".into(),
            role: "human".into(),
            handle: None,
        }
    );
}

#[test]
fn the_author_is_written_before_the_first_edit_not_on_open() {
    let mut e = Editor::new(Document::create("t", "ana"));
    let before = e.document().loro().oplog_vv();
    e.set_author(record("ana", "Ana", "human"));
    assert_eq!(
        e.document().loro().oplog_vv(),
        before,
        "opening stays clean"
    );
    e.insert_text("hi");
    let authors = history::read_authors(e.document().loro());
    assert_eq!(authors.len(), 1);
    // A rename rewrites the record.
    e.set_author(record("ana", "Ana B", "human"));
    let authors = history::read_authors(e.document().loro());
    assert_eq!(authors.values().next().unwrap().name, "Ana B");
    // Neither registration is undone by Ctrl+Z.
    e.undo();
    assert_eq!(history::read_authors(e.document().loro()).len(), 1);
}

// ── The index (AC-05.10) ──

#[test]
fn the_index_appends_without_rewriting() {
    let mut ana = Editor::new(Document::create("t", "ana"));
    ana.set_author(record("ana", "Ana", "human"));
    ana.insert_text("one");
    let mut index = HistoryIndex::new(ana.document().loro());
    let first: Vec<String> = index.list().iter().map(|e| e.id.clone()).collect();
    assert!(!first.is_empty());
    // A commit of its own (quick typing would merge into the last change).
    ana.set_title("Two");
    add_paragraph(&mut ana, "two");
    assert!(index.refresh(ana.document().loro()));
    let second: Vec<String> = index.list().iter().map(|e| e.id.clone()).collect();
    assert!(second.len() > first.len());
    assert_eq!(second[..first.len()], first[..]);
    assert!(!index.refresh(ana.document().loro()), "nothing new");
}

#[test]
fn the_index_covers_every_peer_not_only_the_heads() {
    let base = Document::create("t", "base");
    let hub = Hub::new(&base);
    let mut ana = join(&base, "ana", "Ana", "human");
    let mut nova = join(&base, "nova", "Nova", "agent");
    add_paragraph(&mut ana, "one");
    sync(&hub, &mut [&mut ana, &mut nova]);
    add_paragraph(&mut nova, "two");
    sync(&hub, &mut [&mut ana, &mut nova]);
    // Nova's last change is now an ancestor of Ana's: not a frontier.
    add_paragraph(&mut ana, "three");
    sync(&hub, &mut [&mut ana, &mut nova]);
    let index = HistoryIndex::new(hub.loro());
    let mut indexed: Vec<_> = index.list().iter().map(|e| e.id.clone()).collect();
    let mut all: Vec<_> = history::list_history(hub.loro())
        .into_iter()
        .map(|e| e.id)
        .collect();
    indexed.sort();
    all.sort();
    assert_eq!(indexed, all);
    assert!(index.list().iter().any(|e| e.author.actor_id == "nova"));
}

#[test]
fn the_index_knows_each_blocks_last_author() {
    let base = Document::create("t", "base");
    let hub = Hub::new(&base);
    let mut ana = join(&base, "ana", "Ana", "human");
    let mut nova = join(&base, "nova", "Nova", "agent");
    add_paragraph(&mut ana, "start");
    sync(&hub, &mut [&mut ana, &mut nova]);
    let block = nova
        .blocks()
        .iter()
        .find(|b| b.text == "start")
        .unwrap()
        .block_id
        .clone();
    let i = nova
        .blocks()
        .iter()
        .position(|b| b.text == "start")
        .unwrap();
    let at = nova.block_start(i);
    nova.replace(at..at + 5, "nova");
    sync(&hub, &mut [&mut ana, &mut nova]);
    let index = HistoryIndex::new(hub.loro());
    assert_eq!(index.last_author(&block).unwrap().name, "Nova");
}

#[test]
fn the_index_appends_1000_commits_onto_10000_quickly() {
    let doc = LoroDoc::new();
    doc.set_change_merge_interval(0);
    let text = doc.get_text("bench");
    let t0 = 1_700_000_000_000i64;
    for i in 0..10_000 {
        text.insert(text.len_unicode(), "a").unwrap();
        doc.commit_with(
            loro::CommitOptions::new()
                .origin("actor:ana")
                .commit_msg(&format!("n{i}"))
                .timestamp(t0 + i * 2_000),
        );
    }
    let mut index = HistoryIndex::new(&doc);
    let before = index.list().len();
    assert!(before >= 10_000);
    let start = std::time::Instant::now();
    for i in 0..1_000 {
        text.insert(text.len_unicode(), "b").unwrap();
        doc.commit_with(
            loro::CommitOptions::new()
                .origin("actor:ana")
                .commit_msg(&format!("m{i}"))
                .timestamp(t0 + 40_000_000 + i * 2_000),
        );
        index.refresh(&doc);
    }
    let elapsed = start.elapsed();
    assert!(index.list().len() >= before + 1_000);
    // The bar is for an optimised build; a debug build gets more room.
    let limit = if cfg!(debug_assertions) { 10 } else { 1 };
    assert!(elapsed.as_secs_f64() < limit as f64, "{elapsed:?}");
    eprintln!("1 000 commits onto 10 000: {elapsed:?}");
}

#[test]
fn author_counts_add_up_to_the_total_and_filters_select() {
    let base = Document::create("t", "base");
    let hub = Hub::new(&base);
    let mut ana = join(&base, "ana", "Ana", "human");
    let mut nova = join(&base, "nova", "Nova", "agent");
    add_paragraph(&mut ana, "Ana");
    add_paragraph(&mut nova, "Nova");
    sync(&hub, &mut [&mut ana, &mut nova]);
    let history = history::list_history(hub.loro());
    let counts = history::author_counts(&history);
    assert_eq!(counts.values().sum::<usize>(), history.len());
    let only_ana = history::filter_history(&history, Some("ana"), "");
    assert!(only_ana.iter().all(|e| e.author.actor_id == "ana"));
    assert_eq!(only_ana.len(), counts["ana"]);
    let found = history::filter_history(&history, None, "nova");
    assert!(!found.is_empty() && found.iter().all(|e| e.author.name == "Nova"));
}

// ── Diffs (AC-05.4) ──

#[test]
fn a_change_diffs_word_by_word() {
    let mut ana = Editor::new(Document::create("t", "ana"));
    ana.set_author(record("ana", "Ana", "human"));
    ana.insert_text("hello world");
    ana.set_title("cut"); // a commit boundary
    ana.replace(6..11, "there");
    let mut index = HistoryIndex::new(ana.document().loro());
    let entry = by_detail(index.list(), "inserted “there”")
        .unwrap()
        .id
        .clone();
    let hunks = index.diff(ana.document().loro(), &entry).unwrap();
    let change = hunks.iter().find(|h| h.kind == "change").unwrap();
    assert!(
        change
            .parts
            .iter()
            .any(|p| p.kind == "remove" && p.text.contains("world"))
    );
    assert!(
        change
            .parts
            .iter()
            .any(|p| p.kind == "add" && p.text.contains("there"))
    );
}

#[test]
fn a_merged_change_is_diffed_again_once_it_grew() {
    let mut ana = Editor::new(Document::create("t", "ana"));
    ana.set_author(record("ana", "Ana", "human"));
    ana.insert_text("start alpha");
    let mut index = HistoryIndex::new(ana.document().loro());
    let entry = by_detail(index.list(), "alpha").unwrap().clone();
    let before = index.diff(ana.document().loro(), &entry.id).unwrap();
    // More typing in the same block within a second merges into the change.
    let end = ana.len();
    ana.move_to(end);
    ana.insert_text(" beta");
    index.refresh(ana.document().loro());
    let grown = index.get(&entry.id).unwrap().clone();
    assert!(grown.length > entry.length);
    let after = index.diff(ana.document().loro(), &grown.id).unwrap();
    assert_ne!(after, before);
    assert!(serde_json::to_string(&after).unwrap().contains("beta"));
}

#[test]
fn diff_words_is_fast_on_a_pasted_wall_of_text() {
    let words: Vec<String> = (0..20_000).map(|i| format!("w{i}")).collect();
    let other: Vec<String> = (0..20_000).map(|i| format!("x{i}")).collect();
    let start = std::time::Instant::now();
    let parts = history::diff_words(
        &format!("same {} tail", words.join(" ")),
        &format!("same {} tail", other.join(" ")),
    );
    assert!(start.elapsed().as_millis() < 500);
    assert_eq!((parts[0].kind, parts[0].text.as_str()), ("same", "same "));
    assert!(parts.iter().any(|p| p.kind == "remove"));
    assert!(parts.iter().any(|p| p.kind == "add"));
    let last = parts.last().unwrap();
    assert_eq!((last.kind, last.text.as_str()), ("same", " tail"));
}

#[test]
fn diff_words_keeps_unchanged_words_and_blocks_mark_added_ids() {
    let parts = history::diff_words("the cat sat", "the dog sat");
    assert!(
        parts
            .iter()
            .any(|p| p.kind == "same" && p.text.contains("the"))
    );
    assert!(
        parts
            .iter()
            .any(|p| p.kind == "remove" && p.text.contains("cat"))
    );
    assert!(
        parts
            .iter()
            .any(|p| p.kind == "add" && p.text.contains("dog"))
    );
    let block = |text: &str, id: &str| history::HistoryBlock {
        kind: "paragraph".into(),
        text: text.into(),
        block_id: Some(id.into()),
    };
    let hunks = history::diff_blocks(
        &[block("keep", "a")],
        &[block("keep", "a"), block("new", "b")],
    );
    assert!(
        hunks
            .iter()
            .any(|h| h.kind == "add" && h.block_id.as_deref() == Some("b"))
    );
}

// ── Checkpoints (AC-05.5) ──

#[test]
fn a_checkpoint_survives_a_snapshot_round_trip() {
    let mut ana = Editor::new(Document::create("t", "ana"));
    ana.set_author(record("ana", "Ana", "human"));
    ana.insert_text("pinned");
    let marked = ana.add_checkpoint("Draft 1");
    assert_eq!(marked.name, "Draft 1");
    assert_eq!(marked.actor_id, "ana");
    assert!(marked.id.starts_with("cp_"));
    let listed = history::list_checkpoints(ana.document().loro());
    assert_eq!(listed.len(), 1);
    assert!(!listed[0].frontiers.is_empty());
    let again = Document::from_collabdoc(&ana.document().to_collabdoc(), "x").unwrap();
    let listed = history::list_checkpoints(again.loro());
    assert_eq!(listed[0].name, "Draft 1");
    assert_eq!(
        history::preview_at(again.loro(), &listed[0].frontiers)[0].text,
        "pinned"
    );
    // A blank name is "Checkpoint"; checkpoints are not undone.
    ana.add_checkpoint("  ");
    assert_eq!(
        history::list_checkpoints(ana.document().loro())[0].name,
        "Checkpoint"
    );
    ana.undo();
    assert_eq!(history::list_checkpoints(ana.document().loro()).len(), 2);
}

// ── Restore (AC-05.7) ──

#[test]
fn restore_is_one_undoable_commit_that_reads_like_the_version() {
    let base = Document::create("t", "base");
    let hub = Hub::new(&base);
    let mut ana = join(&base, "ana", "Ana", "human");
    let mut nova = join(&base, "nova", "Nova", "agent");
    ana.insert_text("Intro");
    add_paragraph(&mut ana, "keep me");
    add_paragraph(&mut ana, "item one");
    ana.toggle_list(ListKind::Bullet);
    sync(&hub, &mut [&mut ana, &mut nova]);
    let version = history::from_frontiers(&nova.document().loro().oplog_frontiers());
    let wanted = texts(&nova);

    // Then: Nova rewrites, deletes, adds a diagram and a new list item.
    let i = nova
        .blocks()
        .iter()
        .position(|b| b.text == "keep me")
        .unwrap();
    let at = nova.block_start(i);
    nova.replace(at..at + 4, "changed");
    nova.set_selection(0, 5);
    nova.backspace();
    let end = nova.len();
    nova.move_to(end);
    nova.newline();
    nova.insert_text("item two");
    nova.insert_figure("mermaidFigure");
    sync(&hub, &mut [&mut ana, &mut nova]);
    let ids_before = history::list_history(hub.loro()).len();

    assert!(ana.restore_version(&version));
    assert_eq!(texts(&ana), wanted);
    assert_eq!(ana.blocks()[2].list, Some(ListKind::Bullet));
    // Blocks the version has keep their ids.
    let kept: Vec<_> = ana.blocks().iter().map(|b| b.block_id.clone()).collect();
    let at_version: Vec<_> = history::preview_at(ana.document().loro(), &version)
        .into_iter()
        .filter_map(|b| b.block_id)
        .collect();
    assert_eq!(kept[0], at_version[0]);

    sync(&hub, &mut [&mut ana, &mut nova]);
    let all = history::list_history(hub.loro());
    assert_eq!(all.len(), ids_before + 1, "exactly one new entry");
    let restore = all.iter().find(|e| e.message == "Restore version").unwrap();
    assert_eq!(restore.author.name, "Ana");
    assert!(
        by_detail(&all, "inserted “item two”").is_some(),
        "later history stays"
    );
    assert_eq!(texts(&nova), wanted);

    // Undo takes the restore back.
    assert!(ana.undo());
    assert!(texts(&ana).contains(&"changed me".to_string()));
    // Restoring the version the document already reads like does nothing.
    assert!(ana.redo());
    assert!(!ana.restore_version(&version));
}

#[test]
fn restore_brings_back_figures_marks_and_inline_nodes() {
    let mut e = Editor::new(Document::create("t", "ana"));
    e.set_author(record("ana", "Ana", "human"));
    e.insert_text("bold ");
    e.set_selection(0, 4);
    e.toggle_mark(mark_bit("bold").unwrap());
    let end = e.len();
    e.move_to(end);
    let mut attrs = serde_json::Map::new();
    attrs.insert("kind".into(), "person".into());
    attrs.insert("id".into(), "p1".into());
    attrs.insert("handle".into(), "bo".into());
    attrs.insert("label".into(), "Bo".into());
    e.insert_mention(attrs);
    e.hard_break();
    e.insert_text("next");
    e.insert_figure("mermaidFigure");
    let fig = e
        .blocks()
        .iter()
        .position(|b| b.kind == collabdoc_core::BlockKind::Atom)
        .unwrap();
    e.set_caption(fig, "Flow");
    let version = history::from_frontiers(&e.document().loro().oplog_frontiers());
    let wanted = e.blocks().to_vec();

    e.select_all();
    e.insert_text("gone");
    assert_eq!(texts(&e), ["gone"]);
    assert!(e.restore_version(&version));
    let got = e.blocks();
    assert_eq!(got.len(), wanted.len());
    for (g, w) in got.iter().zip(&wanted) {
        assert_eq!(
            (
                &g.node_name,
                &g.text,
                &g.spans,
                &g.inlines,
                &g.attrs,
                &g.caption
            ),
            (
                &w.node_name,
                &w.text,
                &w.spans,
                &w.inlines,
                &w.attrs,
                &w.caption
            )
        );
    }
}

#[test]
fn a_diff_in_a_2000_block_document_is_quick() {
    let mut e = Editor::new(Document::create("t", "ana"));
    e.set_author(record("ana", "Ana", "human"));
    let text: String = (0..2000)
        .map(|i| format!("Paragraph number {i} with a few words in it."))
        .collect::<Vec<_>>()
        .join("\n\n");
    e.paste(&text);
    e.set_title("cut");
    let at = e.block_start(1000);
    e.replace(at..at + 9, "Section");
    let mut index = HistoryIndex::new(e.document().loro());
    let id = by_detail(index.list(), "inserted “Section”")
        .unwrap()
        .id
        .clone();
    let start = std::time::Instant::now();
    let hunks = index.diff(e.document().loro(), &id).unwrap();
    let elapsed = start.elapsed();
    assert_eq!(hunks.iter().filter(|h| h.kind == "change").count(), 1);
    assert_eq!(
        hunks.len(),
        3,
        "the change and a block of context each side"
    );
    // AC-05.4's bar is for an optimised build.
    let limit = if cfg!(debug_assertions) { 3000 } else { 300 };
    assert!(elapsed.as_millis() < limit, "{elapsed:?}");
    eprintln!("diff of a 2000-block document: {elapsed:?}");
}
