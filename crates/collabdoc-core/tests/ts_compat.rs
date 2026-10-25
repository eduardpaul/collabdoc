//! The Rust and TypeScript cores read each other's files.
//!
//! `fixtures/from-ts.collabdoc` was written by `src/core` through
//! `fixtures/ts-compat.ts write`. The reverse check needs Bun or Node with
//! `loro-crdt` installed, so it runs only with `COLLABDOC_TS_COMPAT=1`.
//!
//! `fixtures/from-rust.collabdoc` is the other direction for the editor: a
//! document with every block, list, quote and mark the Rust editor makes,
//! which the TS test `editor/rust-parity.test.ts` loads into the real Tiptap
//! schema. `COLLABDOC_WRITE_FIXTURES=1` rewrites it when the editor changes.

use std::path::{Path, PathBuf};
use std::process::Command;

use collabdoc_core::presence::{Presence, User};
use collabdoc_core::schema::mark_bit;
use collabdoc_core::{BlockKind, Document, Editor, ListKind};

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

fn ts_document() -> Document {
    let bytes = std::fs::read(fixtures().join("from-ts.collabdoc")).unwrap();
    Document::from_collabdoc(&bytes, "rust").unwrap()
}

#[test]
fn reads_a_file_written_by_the_typescript_core() {
    let doc = ts_document();
    assert_eq!(doc.title(), "Made by the TypeScript core");
    let blocks = doc.blocks();
    let labels: Vec<String> = blocks.iter().map(|b| b.label()).collect();
    let summary: Vec<_> = blocks
        .iter()
        .zip(&labels)
        .map(|(b, label)| (b.kind, b.list, b.list_depth, label.as_str()))
        .collect();
    assert_eq!(
        summary,
        vec![
            (BlockKind::Heading(1), None, 0, "Compatibility"),
            (
                BlockKind::Paragraph,
                None,
                0,
                "Bold, italic, code and a link."
            ),
            (
                BlockKind::Paragraph,
                Some(ListKind::Bullet),
                1,
                "First item"
            ),
            (
                BlockKind::Paragraph,
                Some(ListKind::Ordered),
                2,
                "Nested one"
            ),
            (
                BlockKind::Paragraph,
                Some(ListKind::Bullet),
                1,
                "Second item"
            ),
            (
                BlockKind::CodeBlock,
                None,
                0,
                "fn main() {\n    println!(\"hi\");\n}"
            ),
            (BlockKind::Atom, None, 0, "[Mermaid diagram: Flow]"),
            (BlockKind::Paragraph, None, 0, "Unicode: café 👍🏽 你好"),
            (BlockKind::Paragraph, None, 0, "ping @ana please\nnext line"),
            (BlockKind::Atom, None, 0, "[Image: A dot]"),
        ]
    );
    let marks: Vec<_> = blocks[1]
        .spans
        .iter()
        .map(|s| (s.start, s.end, s.marks, s.href.as_str()))
        .collect();
    assert_eq!(
        marks,
        vec![
            (0, 4, mark_bit("bold").unwrap(), ""),
            (6, 12, mark_bit("italic").unwrap(), ""),
            (14, 18, mark_bit("code").unwrap(), ""),
            (25, 29, mark_bit("link").unwrap(), "https://loro.dev"),
        ]
    );
    assert!(blocks.iter().all(|b| !b.block_id.is_empty()));
}

/// Opens the TS file, edits it the way a person would, saves.
fn edited_by_rust() -> Document {
    let mut e = Editor::new(ts_document());
    let blocks = e.blocks().to_vec();
    // Type at the end of "Second item", Enter, a new item.
    let end = e.block_start(4) + blocks[4].text.encode_utf16().count();
    e.move_to(end);
    e.insert_text(" (edited)");
    e.newline();
    e.insert_text("Third item");
    // Bold "Unicode" in the last paragraph (now block 8).
    let last = e.block_start(8);
    e.set_selection(last, last + 7);
    e.toggle_mark(mark_bit("bold").unwrap());
    // After the emoji, which is several UTF-16 units.
    let after_emoji = last + "Unicode: café 👍🏽".encode_utf16().count();
    e.move_to(after_emoji);
    e.insert_text("!");
    // Undo/redo stay consistent on a file from elsewhere.
    e.undo();
    e.redo();
    let bytes = e.document().to_collabdoc();
    Document::from_collabdoc(&bytes, "reopen").unwrap()
}

#[test]
fn rust_edits_survive_a_round_trip() {
    let doc = edited_by_rust();
    let texts: Vec<_> = doc.blocks().iter().map(|b| b.text.clone()).collect();
    assert_eq!(texts[4], "Second item (edited)");
    assert_eq!(texts[5], "Third item");
    assert_eq!(doc.blocks()[5].list, Some(ListKind::Bullet));
    assert_eq!(texts[8], "Unicode: café 👍🏽! 你好");
    assert_eq!(doc.blocks()[8].spans[0].marks, mark_bit("bold").unwrap());
}

/// Runs `ts-compat.ts` with `args`; `None` unless `COLLABDOC_TS_COMPAT=1`.
fn run_ts(args: &[&Path]) -> Option<serde_json::Value> {
    if std::env::var("COLLABDOC_TS_COMPAT").as_deref() != Ok("1") {
        eprintln!("skipped: set COLLABDOC_TS_COMPAT=1 (needs bun and loro-crdt)");
        return None;
    }
    let runner = std::env::var("COLLABDOC_TS_RUNNER").unwrap_or_else(|_| "bun".into());
    let output = Command::new(runner)
        .arg(fixtures().join("ts-compat.ts"))
        .args(args)
        .output()
        .expect("bun runs");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    Some(serde_json::from_slice(&output.stdout).unwrap())
}

fn temp(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!("collabdoc-rust-{}-{name}", std::process::id()))
}

#[test]
fn typescript_reads_what_rust_writes() {
    let doc = edited_by_rust();
    let out = temp("doc.collabdoc");
    std::fs::write(&out, doc.to_collabdoc()).unwrap();
    let Some(json) = run_ts(&[Path::new("read"), &out]) else {
        return;
    };
    let ts_blocks = json["blocks"].as_array().unwrap();
    let rust_blocks = doc.blocks();
    assert_eq!(ts_blocks.len(), rust_blocks.len());
    for (ts, rust) in ts_blocks.iter().zip(&rust_blocks) {
        if rust.kind != BlockKind::Atom {
            // `blockPlainText` spells a mention `@handle` and a hard break
            // as nothing.
            let breaks: Vec<_> = rust
                .inlines
                .iter()
                .filter(|n| n.name == "hardBreak")
                .map(|n| n.at)
                .collect();
            let mut at = 0u32;
            let mut plain = String::new();
            for c in rust.text.chars() {
                match rust.inline_at(at as usize) {
                    Some(n) if c == '\u{FFFC}' && !breaks.contains(&at) => {
                        plain.push_str(&n.plain_text())
                    }
                    Some(_) if c == '\u{FFFC}' => {}
                    _ => plain.push(c),
                }
                at += c.len_utf16() as u32;
            }
            assert_eq!(
                ts["plain"].as_str().unwrap(),
                plain,
                "text of {:?}",
                rust.kind
            );
        }
        assert_eq!(ts["type"].as_str().unwrap(), rust.node_name);
    }
    let marks = &ts_blocks[8]["marks"];
    assert_eq!(marks[0]["type"], "bold");
    assert_eq!(
        (marks[0]["start"].as_u64(), marks[0]["end"].as_u64()),
        (Some(0), Some(7))
    );
    std::fs::remove_file(out).ok();
}

#[test]
fn typescript_reads_a_caret_rust_publishes() {
    let mut e = Editor::new(edited_by_rust());
    // After the emoji, which UTF-16 and Unicode count differently.
    let block = 8;
    let local = "Unicode: café 👍🏽!".encode_utf16().count();
    let at = e.block_start(block) + local;
    e.set_selection(e.block_start(block), at);
    let presence = Presence::new(&e);
    let user = User {
        name: "Rust".into(),
        color: "#30a46c".into(),
        actor_id: "rust".into(),
        role: Some("human".into()),
    };
    let doc_file = temp("caret.collabdoc");
    let presence_file = temp("presence.bin");
    std::fs::write(&doc_file, e.document().to_collabdoc()).unwrap();
    std::fs::write(&presence_file, presence.publish(&e, &user)).unwrap();
    let Some(json) = run_ts(&[Path::new("presence"), &doc_file, &presence_file]) else {
        return;
    };
    let caret = &json[0];
    assert_eq!(caret["peer"], presence.peer());
    assert_eq!(caret["user"]["name"], "Rust");
    assert_eq!(caret["user"]["role"], "human");
    let block_id = e.blocks()[block].block_id.as_str();
    assert_eq!(caret["focus"]["blockId"], block_id);
    assert_eq!(caret["focus"]["offset"].as_u64(), Some(local as u64));
    assert_eq!(caret["anchor"]["offset"].as_u64(), Some(0));
    std::fs::remove_file(doc_file).ok();
    std::fs::remove_file(presence_file).ok();
}

/// Everything the Rust editor can make, made the ways a person would:
/// pasted Markdown and HTML, toolbar commands, typing.
fn every_kind() -> Editor {
    let mut e = Editor::new(Document::create("Made by the Rust editor", "rust"));
    e.set_author(collabdoc_core::history::AuthorRecord {
        actor_id: "rust".into(),
        name: "Rust editor".into(),
        color: "#c45c26".into(),
        role: "human".into(),
        handle: None,
    });
    e.paste(
        "# Heading one\n\n## Heading two\n\n### Heading three\n\n#### Heading four\n\n\
         Marks: **bold** *italic* <u>underline</u> ~~strike~~ `code` ==highlight== ^sup^ ~sub~ \
         and [a link](https://loro.dev).\n\n\
         - bullet one\n  1. ordered inside\n- bullet two\n\n\
         * [x] done task\n* [ ] open task\n\n\
         > quoted line\n>\n> - list in a quote\n\n\
         ```rust\nfn main() {}\n```\n\nafter the code",
    );
    let end = e.len();
    e.move_to(end);
    e.newline();
    e.insert_mermaid("flowchart LR\n  A --> B");
    let end = e.len();
    e.move_to(end);
    e.newline();
    e.paste_html("<p>from <b>HTML</b></p><hr><p>after the rule</p>", "");
    // Lists, tasks and quotes made with commands rather than pasted.
    let end = e.len();
    e.move_to(end);
    e.newline();
    e.insert_text("made task\nnested task\nquoted by command");
    let first = e.blocks().len() - 3;
    let start = e.block_start(first);
    let second_end = e.block_start(first + 1) + "nested task".len();
    e.set_selection(start, second_end);
    e.toggle_list(ListKind::Task);
    e.toggle_task(first);
    let nested = e.block_start(first + 1);
    e.move_to(nested);
    e.indent();
    let quoted = e.block_start(first + 2);
    e.move_to(quoted);
    e.toggle_quote();
    // And a find-and-replace.
    let hits = e.find("command", false);
    e.replace_matches(&hits, "Ctrl+Shift+B");
    // Inline nodes: a mention chip and a hard break.
    let end = e.len();
    e.move_to(end);
    e.newline();
    // Out of the quote the line above is in.
    e.toggle_quote();
    e.insert_text("ask ");
    let mut attrs = serde_json::Map::new();
    for (k, v) in [
        ("kind", "agent"),
        ("id", "agent-1"),
        ("handle", "writer"),
        ("label", "Writer"),
    ] {
        attrs.insert(k.into(), v.into());
    }
    e.insert_mention(attrs);
    e.insert_text("now");
    e.hard_break();
    e.insert_text("second line");
    // Figures: an image with its bytes, a caption, width and alignment; an
    // infographic; and a caption on the diagram.
    let png = collabdoc_core::figures::parse_data_uri(PNG_URI).unwrap().1;
    e.insert_image(png, "a dot").unwrap();
    let image = e
        .blocks()
        .iter()
        .position(|b| b.node_name == "imageFigure")
        .unwrap();
    e.set_caption(image, "One pixel");
    e.set_figure_attr(image, "width", &serde_json::json!(50));
    e.set_figure_attr(image, "align", &serde_json::json!("right"));
    e.insert_figure("infographicFigure");
    let diagram = e
        .blocks()
        .iter()
        .position(|b| b.node_name == "mermaidFigure")
        .unwrap();
    e.set_caption(diagram, "Flow");
    e.add_checkpoint("All kinds");
    e
}

/// A 1×1 PNG.
const PNG_URI: &str = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/// What a document says, without ids or keys (which differ per run).
fn summary(doc: &Document) -> Vec<String> {
    doc.blocks()
        .iter()
        .map(|b| {
            format!(
                "{} {:?} {:?}@{} q{} {} {:?} {:?} {:?} {:?} {:?}",
                b.node_name,
                b.kind,
                b.list,
                b.list_depth,
                b.quote_depth,
                b.checked,
                b.text,
                b.spans
                    .iter()
                    .map(|s| (s.start, s.end, s.marks, s.href.clone()))
                    .collect::<Vec<_>>(),
                b.inlines,
                b.attrs,
                b.caption
            )
        })
        .collect()
}

#[test]
fn the_rust_fixture_is_what_the_editor_makes_today() {
    let made = every_kind();
    let path = fixtures().join("from-rust.collabdoc");
    if std::env::var("COLLABDOC_WRITE_FIXTURES").as_deref() == Ok("1") {
        std::fs::write(&path, made.document().to_collabdoc()).unwrap();
    }
    let bytes = std::fs::read(&path)
        .expect("fixtures/from-rust.collabdoc: run with COLLABDOC_WRITE_FIXTURES=1");
    let fixture = Document::from_collabdoc(&bytes, "reader").unwrap();
    assert_eq!(
        summary(&fixture),
        summary(made.document()),
        "the editor changed: COLLABDOC_WRITE_FIXTURES=1 rewrites the fixture"
    );
    // The image's bytes travel in the file.
    assert_eq!(fixture.assets(), made.document().assets());
    assert_eq!(fixture.assets().len(), 1);
}

/// Both cores describe a file's history the same way: the same entries
/// (one per change), summaries, authors and checkpoints.
#[test]
fn both_cores_tell_the_same_history() {
    for name in ["from-ts.collabdoc", "from-rust.collabdoc"] {
        let path = fixtures().join(name);
        let Some(json) = run_ts(&[Path::new("history"), &path]) else {
            return;
        };
        let doc = Document::from_collabdoc(&std::fs::read(&path).unwrap(), "reader").unwrap();
        let rust: Vec<serde_json::Value> = collabdoc_core::history::list_history(doc.loro())
            .iter()
            .map(|e| {
                serde_json::json!({
                    "id": e.id,
                    "summary": e.summary,
                    "message": e.message,
                    "author": e.author.name,
                    "role": e.author.role,
                })
            })
            .collect();
        assert_eq!(json["entries"].as_array().unwrap(), &rust, "{name}");
        let checkpoints: Vec<serde_json::Value> =
            collabdoc_core::history::list_checkpoints(doc.loro())
                .iter()
                .map(|c| {
                    serde_json::json!({
                        "name": c.name,
                        "actorId": c.actor_id,
                        "blocks": collabdoc_core::history::preview_at(doc.loro(), &c.frontiers)
                            .into_iter()
                            .map(|b| b.text)
                            .collect::<Vec<_>>(),
                    })
                })
                .collect();
        assert_eq!(
            json["checkpoints"].as_array().unwrap(),
            &checkpoints,
            "{name}"
        );
    }
}
