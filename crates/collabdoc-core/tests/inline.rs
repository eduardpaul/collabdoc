//! Inline nodes (hard breaks, mention chips): editable, stored the way
//! `loro-prosemirror` stores them, and kept through Markdown and HTML.

use collabdoc_core::schema::mark_bit;
use collabdoc_core::tree::{self, Segment};
use collabdoc_core::{Document, Editor};

const OBJ: char = '\u{FFFC}';

fn editor() -> Editor {
    Editor::new(Document::create("t", "me"))
}

fn mention(handle: &str) -> serde_json::Map<String, serde_json::Value> {
    let mut attrs = serde_json::Map::new();
    attrs.insert("kind".into(), "person".into());
    attrs.insert("id".into(), format!("id-{handle}").into());
    attrs.insert("handle".into(), handle.into());
    attrs.insert("label".into(), handle.to_uppercase().into());
    attrs
}

/// The first block's children: `T(text)` runs and `N(name)` nodes.
fn children(e: &Editor) -> Vec<String> {
    let flat = tree::flatten(e.document().loro());
    tree::segments(&flat[0].0.node)
        .into_iter()
        .map(|p| match p.segment {
            Segment::Text(t) => format!("T({})", t.to_string()),
            Segment::Inline(m) => format!("N({})", tree::node_name(&m)),
        })
        .collect()
}

#[test]
fn a_hard_break_is_a_node_between_text_runs() {
    let mut e = editor();
    e.insert_text("ab");
    e.hard_break();
    e.insert_text("cd");
    assert_eq!(e.blocks().len(), 1);
    assert_eq!(e.blocks()[0].text, format!("ab{OBJ}cd"));
    assert_eq!(e.blocks()[0].inlines[0].name, "hardBreak");
    assert_eq!(e.blocks()[0].inlines[0].at, 2);
    assert_eq!(children(&e), ["T(ab)", "N(hardBreak)", "T(cd)"]);
    assert_eq!(e.blocks()[0].plain_text(), "ab\ncd");

    // The node map is shaped as loro-prosemirror writes one.
    let flat = tree::flatten(e.document().loro());
    let node = tree::segments(&flat[0].0.node)
        .into_iter()
        .find_map(|p| match p.segment {
            Segment::Inline(m) => Some(m),
            _ => None,
        })
        .unwrap();
    let value = tree::to_json(&node.get_deep_value());
    assert_eq!(
        value,
        serde_json::json!({"nodeName": "hardBreak", "attributes": {}, "children": []})
    );

    // Backspace after it removes it, and the runs join again.
    e.move_to(3);
    e.backspace();
    assert_eq!(e.blocks()[0].text, "abcd");
    assert!(e.blocks()[0].inlines.is_empty());
    assert_eq!(children(&e), ["T(abcd)"]);
}

#[test]
fn a_chip_inside_bold_text_splits_the_run_and_keeps_the_marks() {
    let mut e = editor();
    e.insert_text("hello world");
    e.select_all();
    e.toggle_mark(mark_bit("bold").unwrap());
    e.move_to(6);
    e.insert_mention(mention("ana"));
    let b = &e.blocks()[0];
    assert_eq!(b.text, format!("hello {OBJ} world"));
    assert_eq!(b.inlines[0].attr("handle"), "ana");
    assert_eq!(children(&e), ["T(hello )", "N(mention)", "T( world)"]);
    // Bold on both sides of the chip; the chip and the space typed after it
    // carry none.
    let bold = mark_bit("bold").unwrap();
    let spans: Vec<(u32, u32)> = b
        .spans
        .iter()
        .filter(|s| s.marks & bold != 0)
        .map(|s| (s.start, s.end))
        .collect();
    assert_eq!(spans, [(0, 6), (8, 13)]);
    assert_eq!(e.selection_markdown(), "");
    e.select_all();
    assert_eq!(e.selection_markdown(), "**hello **@ana **world**");
}

#[test]
fn enter_and_undo_across_a_chip() {
    let mut e = editor();
    e.insert_text("ask ");
    e.insert_mention(mention("bo"));
    e.insert_text("today");
    let before = e.blocks()[0].clone();
    // Enter before the chip: it moves to the new line with the text after it.
    e.move_to(4);
    e.newline();
    assert_eq!(e.blocks().len(), 2);
    assert_eq!(e.blocks()[0].text, "ask ");
    assert_eq!(e.blocks()[1].text, format!("{OBJ} today"));
    assert_eq!(e.blocks()[1].inlines[0].attr("handle"), "bo");
    // Typing and Enter within a second are one undo step; redo brings the
    // split back with the chip intact.
    let split: Vec<_> = e
        .blocks()
        .iter()
        .map(|b| (b.text.clone(), b.inlines.clone()))
        .collect();
    e.undo();
    assert_eq!(e.blocks()[0].text, "");
    e.redo();
    let again: Vec<_> = e
        .blocks()
        .iter()
        .map(|b| (b.text.clone(), b.inlines.clone()))
        .collect();
    assert_eq!(again, split);
    assert_ne!(before.text, again[0].0);
}

#[test]
fn deleting_a_selection_that_holds_chips() {
    let mut e = editor();
    e.insert_text("a");
    e.insert_mention(mention("x"));
    e.insert_text("b");
    e.hard_break();
    e.insert_text("c");
    // a ￼ ␣ b ￼ c — delete from after `a` to before `c`.
    e.set_selection(1, 5);
    e.backspace();
    assert_eq!(e.blocks()[0].text, "ac");
    assert_eq!(children(&e), ["T(ac)"]);
}

#[test]
fn carets_after_a_chip_survive_a_remote_edit() {
    let mut a = editor();
    a.insert_text("hi ");
    a.insert_mention(mention("cy"));
    a.insert_text("there");
    let mut b = Editor::new(a.document().fork("b"));
    // b's caret after "the" (past the chip and its space).
    let at = 3 + 1 + 1 + 3;
    b.move_to(at);
    let bytes = a
        .cursor_bytes(at)
        .expect("a cursor on the text after the chip");
    assert_eq!(a.offset_of_cursor(&bytes), Some(at));
    // a types at the very start; b's caret moves with its text.
    a.move_to(0);
    a.insert_text(">> ");
    let update = a.document().export_since(&b.document().version());
    b.remote_change(|d| d.import(&update).unwrap());
    assert_eq!(b.head(), at + 3);
    assert_eq!(b.offset_of_cursor(&bytes), Some(at + 3));
}

#[test]
fn markdown_hard_breaks_both_ways() {
    let mut e = editor();
    e.paste("one  \ntwo\n\n# Title\n");
    assert_eq!(e.blocks()[0].text, format!("one{OBJ}two"));
    assert_eq!(e.blocks()[0].inlines[0].name, "hardBreak");
    e.select_all();
    assert!(e.selection_markdown().starts_with("one  \ntwo\n\n# Title"));
}

#[test]
fn shift_enter_in_code_is_a_newline() {
    let mut e = editor();
    e.set_kind(collabdoc_core::BlockKind::CodeBlock);
    e.insert_text("a");
    e.hard_break();
    e.insert_text("b");
    assert_eq!(e.blocks()[0].text, "a\nb");
    assert!(e.blocks()[0].inlines.is_empty());
    assert!(!e.insert_mention(mention("no")));
}
