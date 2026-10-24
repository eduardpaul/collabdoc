//! Markdown on the clipboard: copy writes it, paste reads it back.

use collabdoc_core::markdown::{looks_like_markdown, parse};
use collabdoc_core::schema::mark_bit;
use collabdoc_core::{BlockKind, Document, Editor, ListKind, Span};

fn editor() -> Editor {
    Editor::new(Document::create("t", "me"))
}

/// `(kind, list, depth, text)` per block.
fn shape(e: &Editor) -> Vec<(BlockKind, Option<ListKind>, u8, String)> {
    e.blocks()
        .iter()
        .map(|b| (b.kind, b.list, b.list_depth, b.text.clone()))
        .collect()
}

fn bit(name: &str) -> u32 {
    mark_bit(name).unwrap()
}

/// A document with one of everything the clipboard carries.
fn rich() -> Editor {
    let mut e = editor();
    e.insert_text("Plan");
    e.set_kind(BlockKind::Heading(2));
    e.newline();
    e.insert_text("Bold, a link and code.");
    e.set_selection(5, 9);
    e.toggle_mark(bit("bold"));
    e.set_selection(13, 17);
    e.set_link("https://loro.dev");
    e.set_selection(22, 26);
    e.toggle_mark(bit("code"));
    let end = e.len();
    e.move_to(end);
    e.newline();
    e.insert_text("one\nnested\ntwo");
    let one = e.block_start(2);
    e.set_selection(one, e.len());
    e.toggle_list(ListKind::Bullet);
    let nested = e.block_start(3);
    e.move_to(nested);
    e.indent();
    let end = e.len();
    e.move_to(end);
    e.newline();
    e.newline();
    e.insert_text("done");
    e.toggle_list(ListKind::Task);
    let last = e.blocks().len() - 1;
    e.toggle_task(last);
    e
}

const RICH_MD: &str = "## Plan\n\n\
**Bold**, a [link](https://loro.dev) and `code`.\n\n\
- one\n  - nested\n- two\n\
* [x] done";

#[test]
fn detects_markdown_like_the_ts_clipboard() {
    for yes in [
        "# Title",
        "- item",
        "* item",
        "1. first",
        "```\ncode\n```",
        "![alt](x.png)",
        "> quote",
        "- [ ] task",
        "text\n## later",
    ] {
        assert!(looks_like_markdown(yes), "{yes:?}");
    }
    for no in ["", "   ", "plain words", "#hashtag", "1.5 percent", "-dash"] {
        assert!(!looks_like_markdown(no), "{no:?}");
    }
}

#[test]
fn copy_writes_markdown() {
    let mut e = rich();
    assert_eq!(e.blocks()[1].spans.len(), 3, "bold, link, code");
    e.select_all();
    assert_eq!(e.selection_markdown(), RICH_MD);
}

#[test]
fn a_partial_selection_copies_just_that_text() {
    let mut e = rich();
    let start = e.block_start(1);
    e.set_selection(start + 2, start + 9);
    assert_eq!(e.selection_markdown(), "**ld**, a [l](https://loro.dev)");
}

#[test]
fn copy_then_paste_round_trips() {
    let mut source = rich();
    source.select_all();
    let md = source.selection_markdown();

    let mut target = editor();
    assert!(target.paste(&md));
    assert_eq!(shape(&target), shape(&source));
    assert_eq!(target.blocks()[1].spans, source.blocks()[1].spans);
    assert!(target.blocks().last().unwrap().checked);
}

#[test]
fn pasted_blocks_go_between_the_halves_of_the_line() {
    let mut e = editor();
    e.insert_text("abcdef");
    e.move_to(3);
    assert!(e.paste("- one\n- two"));
    assert_eq!(
        shape(&e),
        [
            (BlockKind::Paragraph, None, 0, "abc".into()),
            (
                BlockKind::Paragraph,
                Some(ListKind::Bullet),
                1,
                "one".into()
            ),
            (
                BlockKind::Paragraph,
                Some(ListKind::Bullet),
                1,
                "two".into()
            ),
            (BlockKind::Paragraph, None, 0, "def".into()),
        ]
    );
    assert_eq!(
        e.head(),
        e.block_start(2) + 3,
        "caret at the end of the pasted text"
    );
    // One undo takes the whole paste back.
    assert!(e.undo());
    assert_eq!(
        shape(&e),
        [(BlockKind::Paragraph, None, 0, "abcdef".into())]
    );
}

#[test]
fn pasting_into_an_empty_line_replaces_it() {
    let mut e = editor();
    assert!(e.paste("# Title\n\nBody with **bold**."));
    assert_eq!(
        shape(&e),
        [
            (BlockKind::Heading(1), None, 0, "Title".into()),
            (BlockKind::Paragraph, None, 0, "Body with bold.".into()),
        ]
    );
    assert_eq!(
        e.blocks()[1].spans,
        vec![Span {
            start: 10,
            end: 14,
            marks: bit("bold"),
            href: String::new()
        }]
    );
}

#[test]
fn plain_text_is_typed_as_is() {
    let mut e = editor();
    e.paste("just words\nand a second line");
    assert_eq!(
        shape(&e),
        [
            (BlockKind::Paragraph, None, 0, "just words".into()),
            (BlockKind::Paragraph, None, 0, "and a second line".into()),
        ]
    );
}

#[test]
fn fences_become_code_blocks_and_mermaid_figures() {
    let nodes = parse("```rust\nfn main() {}\n```\n\n```mermaid\ngraph TD; A-->B\n```");
    assert_eq!(nodes[0].name, "codeBlock");
    assert_eq!(nodes[1].name, "mermaidFigure");
    let mut e = editor();
    e.paste("```rust\nfn main() {}\n```\n\n```mermaid\ngraph TD; A-->B\n```");
    assert_eq!(e.blocks()[0].kind, BlockKind::CodeBlock);
    assert_eq!(e.blocks()[0].text, "fn main() {}");
    assert_eq!(e.blocks()[1].kind, BlockKind::Atom);
    assert_eq!(e.blocks()[1].node_name, "mermaidFigure");
}

#[test]
fn every_pasted_block_has_an_id() {
    let mut e = editor();
    e.paste("# A\n\n- b\n  - c\n\n> d\n\n---");
    assert!(
        e.blocks().iter().all(|b| b.block_id.starts_with("b_")),
        "{:?}",
        e.blocks()
    );
}
