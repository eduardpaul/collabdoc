//! The Rust and TypeScript cores read each other's files.
//!
//! `fixtures/from-ts.collabdoc` was written by `src/core` through
//! `fixtures/ts-compat.ts write`. The reverse check needs Bun or Node with
//! `loro-crdt` installed, so it runs only with `COLLABDOC_TS_COMPAT=1`.

use std::path::{Path, PathBuf};
use std::process::Command;

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
    let summary: Vec<_> = blocks
        .iter()
        .map(|b| (b.kind, b.list, b.list_depth, b.text.as_str()))
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

#[test]
fn typescript_reads_what_rust_writes() {
    if std::env::var("COLLABDOC_TS_COMPAT").as_deref() != Ok("1") {
        eprintln!("skipped: set COLLABDOC_TS_COMPAT=1 (needs bun and loro-crdt)");
        return;
    }
    let doc = edited_by_rust();
    let out = std::env::temp_dir().join(format!("collabdoc-rust-{}.collabdoc", std::process::id()));
    std::fs::write(&out, doc.to_collabdoc()).unwrap();
    let runner = std::env::var("COLLABDOC_TS_RUNNER").unwrap_or_else(|_| "bun".into());
    let output = Command::new(runner)
        .arg(fixtures().join("ts-compat.ts"))
        .arg("read")
        .arg(&out)
        .output()
        .expect("bun runs");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let json: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    let ts_blocks = json["blocks"].as_array().unwrap();
    let rust_blocks = doc.blocks();
    assert_eq!(ts_blocks.len(), rust_blocks.len());
    for (ts, rust) in ts_blocks.iter().zip(&rust_blocks) {
        if rust.kind != BlockKind::Atom {
            assert_eq!(
                ts["text"].as_str().unwrap(),
                rust.text,
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
