//! Lists: toggling, indent/outdent, Enter and Backspace in list lines, tasks.

use collabdoc_core::schema::mark_bit;
use collabdoc_core::sync::Hub;
use collabdoc_core::{BlockKind, Document, Editor, ListKind};

fn editor_with(lines: &str) -> Editor {
    let mut e = Editor::new(Document::create("t", "me"));
    e.insert_text(lines);
    e
}

/// `(text, list, depth)` per block.
fn shape(e: &Editor) -> Vec<(String, Option<ListKind>, u8)> {
    e.blocks()
        .iter()
        .map(|b| (b.text.clone(), b.list, b.list_depth))
        .collect()
}

fn s(text: &str, list: Option<ListKind>, depth: u8) -> (String, Option<ListKind>, u8) {
    (text.to_owned(), list, depth)
}

const B: Option<ListKind> = Some(ListKind::Bullet);
const O: Option<ListKind> = Some(ListKind::Ordered);
const T: Option<ListKind> = Some(ListKind::Task);

fn select_blocks(e: &mut Editor, from: usize, to: usize) {
    let start = e.block_start(from);
    let end = e.block_start(to) + e.blocks()[to].text.encode_utf16().count();
    e.set_selection(start, end);
}

fn caret_in(e: &mut Editor, block: usize, offset: usize) {
    let at = e.block_start(block) + offset;
    e.move_to(at);
}

#[test]
fn toggling_a_list_wraps_and_unwraps_keeping_ids_text_and_marks() {
    let mut e = editor_with("intro\none\ntwo\noutro");
    select_blocks(&mut e, 1, 1);
    e.toggle_mark(mark_bit("bold").unwrap());
    let ids: Vec<String> = e.blocks().iter().map(|b| b.block_id.clone()).collect();

    select_blocks(&mut e, 1, 2);
    assert!(e.toggle_list(ListKind::Bullet));
    assert_eq!(
        shape(&e),
        [
            s("intro", None, 0),
            s("one", B, 1),
            s("two", B, 1),
            s("outro", None, 0)
        ]
    );
    assert_eq!(e.blocks()[1].block_id, ids[1], "the line keeps its blockId");
    assert_eq!(
        e.blocks()[1].spans[0].marks,
        mark_bit("bold").unwrap(),
        "and its marks"
    );
    assert_eq!(
        e.text_in(e.selection()),
        "one\ntwo",
        "the selection follows the lines"
    );

    assert!(e.toggle_list(ListKind::Bullet));
    assert_eq!(
        shape(&e),
        [
            s("intro", None, 0),
            s("one", None, 0),
            s("two", None, 0),
            s("outro", None, 0)
        ]
    );
    assert_eq!(e.blocks()[2].block_id, ids[2]);
}

#[test]
fn toggling_another_kind_switches_the_list() {
    let mut e = editor_with("one\ntwo");
    e.select_all();
    e.toggle_list(ListKind::Bullet);
    e.toggle_list(ListKind::Ordered);
    assert_eq!(shape(&e), [s("one", O, 1), s("two", O, 1)]);
    e.toggle_list(ListKind::Task);
    assert_eq!(shape(&e), [s("one", T, 1), s("two", T, 1)]);
    assert!(e.toggle_task(1));
    assert!(e.blocks()[1].checked);
    assert!(!e.blocks()[0].checked);
    assert!(e.toggle_task(1));
    assert!(!e.blocks()[1].checked);
}

#[test]
fn a_new_list_joins_the_list_right_above() {
    let mut e = editor_with("one\ntwo");
    caret_in(&mut e, 0, 0);
    e.toggle_list(ListKind::Bullet);
    caret_in(&mut e, 1, 0);
    e.toggle_list(ListKind::Bullet);
    assert_eq!(shape(&e), [s("one", B, 1), s("two", B, 1)]);
    // One list, not two: outdenting the first item leaves the second in a list.
    caret_in(&mut e, 0, 0);
    e.outdent();
    assert_eq!(shape(&e), [s("one", None, 0), s("two", B, 1)]);
}

#[test]
fn indent_and_outdent_keep_reading_order() {
    let mut e = editor_with("one\ntwo\nthree");
    e.select_all();
    e.toggle_list(ListKind::Bullet);
    caret_in(&mut e, 1, 1);
    assert!(e.indent());
    caret_in(&mut e, 2, 0);
    assert!(e.indent());
    assert_eq!(
        shape(&e),
        [s("one", B, 1), s("two", B, 2), s("three", B, 2)]
    );
    assert_eq!(e.head(), e.block_start(2), "the caret stays on its line");

    // Outdenting "two" takes "three" along as its child.
    caret_in(&mut e, 1, 0);
    assert!(e.outdent());
    assert_eq!(
        shape(&e),
        [s("one", B, 1), s("two", B, 1), s("three", B, 2)]
    );

    // The first item cannot be indented.
    caret_in(&mut e, 0, 0);
    assert!(!e.indent());
}

#[test]
fn outdent_from_the_middle_of_a_list_splits_it() {
    let mut e = editor_with("one\ntwo\nthree");
    e.select_all();
    e.toggle_list(ListKind::Ordered);
    caret_in(&mut e, 1, 0);
    assert!(e.outdent());
    assert_eq!(
        shape(&e),
        [s("one", O, 1), s("two", None, 0), s("three", O, 1)]
    );
}

#[test]
fn enter_on_an_empty_list_line_leaves_the_list() {
    let mut e = editor_with("one");
    e.toggle_list(ListKind::Bullet);
    e.move_to(3);
    e.newline();
    assert_eq!(shape(&e), [s("one", B, 1), s("", B, 1)]);
    e.newline();
    assert_eq!(shape(&e), [s("one", B, 1), s("", None, 0)]);
    e.insert_text("after");
    assert_eq!(shape(&e), [s("one", B, 1), s("after", None, 0)]);
}

#[test]
fn backspace_at_the_start_of_a_list_line_lifts_it() {
    let mut e = editor_with("one\ntwo");
    e.select_all();
    e.toggle_list(ListKind::Bullet);
    caret_in(&mut e, 1, 0);
    e.indent();
    caret_in(&mut e, 1, 0);
    e.backspace();
    assert_eq!(shape(&e), [s("one", B, 1), s("two", B, 1)]);
    e.backspace();
    assert_eq!(shape(&e), [s("one", B, 1), s("two", None, 0)]);
    // At the start of a plain line, Backspace joins as usual.
    e.backspace();
    assert_eq!(shape(&e), [s("onetwo", B, 1)]);
}

#[test]
fn enter_above_a_sub_list_hands_it_to_the_new_item() {
    let mut e = editor_with("one\none.a\ntwo");
    e.select_all();
    e.toggle_list(ListKind::Bullet);
    caret_in(&mut e, 1, 0);
    e.indent();
    assert_eq!(
        shape(&e),
        [s("one", B, 1), s("one.a", B, 2), s("two", B, 1)]
    );

    // Enter in the middle of "one": "e" moves to a new item that owns the sub-list.
    caret_in(&mut e, 0, 2);
    assert!(e.newline());
    assert_eq!(
        shape(&e),
        [
            s("on", B, 1),
            s("e", B, 1),
            s("one.a", B, 2),
            s("two", B, 1)
        ]
    );
    assert_eq!(
        e.head(),
        e.block_start(1),
        "the caret is at the start of the new line"
    );
    e.insert_text("n");
    assert_eq!(e.blocks()[1].text, "ne");
}

#[test]
fn a_heading_becomes_a_paragraph_in_a_list() {
    let mut e = editor_with("Title");
    e.set_kind(BlockKind::Heading(2));
    e.toggle_list(ListKind::Bullet);
    assert_eq!(e.blocks()[0].kind, BlockKind::Paragraph);
    assert_eq!(e.blocks()[0].list, B);
}

#[test]
fn each_list_command_is_one_undo_step() {
    let mut e = editor_with("one\ntwo");
    e.select_all();
    e.toggle_list(ListKind::Bullet);
    caret_in(&mut e, 1, 0);
    e.indent();
    assert!(e.undo());
    assert_eq!(shape(&e), [s("one", B, 1), s("two", B, 1)]);
    assert!(e.undo());
    assert_eq!(shape(&e), [s("one", None, 0), s("two", None, 0)]);
    assert!(e.redo());
    assert_eq!(shape(&e), [s("one", B, 1), s("two", B, 1)]);
}

#[test]
fn a_block_both_sides_move_keeps_one_block_id() {
    let mut a = editor_with("one\ntwo");
    a.select_all();
    a.toggle_list(ListKind::Bullet);
    let hub = Hub::new(a.document());
    let mut b = Editor::new(a.document().fork("b"));
    // One indents "two" while the other outdents it: each move copies it,
    // so the merge has two.
    caret_in(&mut a, 1, 0);
    a.indent();
    caret_in(&mut b, 1, 0);
    b.outdent();
    for _ in 0..2 {
        hub.push(a.document()).unwrap();
        hub.push(b.document()).unwrap();
        a.remote_change(|d| hub.pull(d)).unwrap();
        b.remote_change(|d| hub.pull(d)).unwrap();
    }
    assert_eq!(a.blocks(), b.blocks());
    let mut ids: Vec<&str> = a.blocks().iter().map(|b| b.block_id.as_str()).collect();
    let all = ids.len();
    ids.sort();
    ids.dedup();
    assert_eq!(ids.len(), all, "{:?}", a.blocks());
}
