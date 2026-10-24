//! Quotes: toggling, and Enter/Backspace leaving them, as in Tiptap.

use collabdoc_core::{Document, Editor, ListKind};

fn editor_with(lines: &str) -> Editor {
    let mut e = Editor::new(Document::create("t", "me"));
    e.insert_text(lines);
    e
}

/// `(text, quote depth, in a list)` per block.
fn shape(e: &Editor) -> Vec<(String, u8, bool)> {
    e.blocks()
        .iter()
        .map(|b| (b.text.clone(), b.quote_depth, b.list.is_some()))
        .collect()
}

fn s(text: &str, depth: u8) -> (String, u8, bool) {
    (text.to_owned(), depth, false)
}

fn select_blocks(e: &mut Editor, from: usize, to: usize) {
    let start = e.block_start(from);
    let end = e.block_start(to) + e.blocks()[to].text.encode_utf16().count();
    e.set_selection(start, end);
}

fn caret_in(e: &mut Editor, block: usize, offset: usize) {
    let at = e.block_start(block) + offset;
    e.move_to(at);
}

/// Distinct quotes in the tree, by counting top-level `blockquote` nodes.
fn quotes(e: &Editor) -> usize {
    let root = collabdoc_core::tree::root(e.document().loro());
    collabdoc_core::tree::child_maps(&root)
        .iter()
        .filter(|n| collabdoc_core::tree::node_name(n) == "blockquote")
        .count()
}

#[test]
fn toggling_wraps_lines_in_one_quote_and_back() {
    let mut e = editor_with("intro\none\ntwo\noutro");
    let ids: Vec<String> = e.blocks().iter().map(|b| b.block_id.clone()).collect();
    select_blocks(&mut e, 1, 2);
    assert!(e.toggle_quote());
    assert_eq!(
        shape(&e),
        [s("intro", 0), s("one", 1), s("two", 1), s("outro", 0)]
    );
    assert_eq!(quotes(&e), 1);
    assert_eq!(e.blocks()[1].block_id, ids[1], "lines keep their ids");
    assert_eq!(e.text_in(e.selection()), "one\ntwo", "and the selection");

    assert!(e.toggle_quote());
    assert_eq!(
        shape(&e),
        [s("intro", 0), s("one", 0), s("two", 0), s("outro", 0)]
    );
    assert_eq!(quotes(&e), 0);
}

#[test]
fn leaving_from_the_middle_splits_the_quote() {
    let mut e = editor_with("a\nb\nc");
    e.select_all();
    e.toggle_quote();
    caret_in(&mut e, 1, 0);
    assert!(e.toggle_quote());
    assert_eq!(shape(&e), [s("a", 1), s("b", 0), s("c", 1)]);
    assert_eq!(quotes(&e), 2);
}

#[test]
fn enter_on_an_empty_quoted_line_leaves_the_quote() {
    let mut e = editor_with("quoted");
    e.toggle_quote();
    e.move_to(6);
    e.newline();
    assert_eq!(
        shape(&e),
        [s("quoted", 1), s("", 1)],
        "Enter stays in the quote"
    );
    e.newline();
    assert_eq!(shape(&e), [s("quoted", 1), s("", 0)]);
    e.insert_text("after");
    assert_eq!(shape(&e), [s("quoted", 1), s("after", 0)]);
}

#[test]
fn backspace_at_the_start_of_a_quote_lifts_inside_it_joins() {
    let mut e = editor_with("before\none\ntwo");
    select_blocks(&mut e, 1, 2);
    e.toggle_quote();
    // Inside the quote, Backspace joins lines as usual.
    caret_in(&mut e, 2, 0);
    e.backspace();
    assert_eq!(shape(&e), [s("before", 0), s("onetwo", 1)]);
    // At the start of the quote it takes the line out instead of joining.
    caret_in(&mut e, 1, 0);
    e.backspace();
    assert_eq!(shape(&e), [s("before", 0), s("onetwo", 0)]);
    e.backspace();
    assert_eq!(shape(&e), [s("beforeonetwo", 0)]);
}

#[test]
fn quoting_a_list_line_quotes_the_whole_list() {
    let mut e = editor_with("one\ntwo\nafter");
    select_blocks(&mut e, 0, 1);
    e.toggle_list(ListKind::Bullet);
    caret_in(&mut e, 1, 1);
    assert!(e.toggle_quote());
    let depths: Vec<(u8, bool)> = e
        .blocks()
        .iter()
        .map(|b| (b.quote_depth, b.list.is_some()))
        .collect();
    assert_eq!(depths, [(1, true), (1, true), (0, false)]);
    // List keys still act on the list inside the quote.
    caret_in(&mut e, 1, 0);
    assert!(e.indent());
    assert_eq!(e.blocks()[1].list_depth, 2);
    // And the quote toggles off again as a whole.
    assert!(e.toggle_quote());
    assert!(e.blocks().iter().all(|b| b.quote_depth == 0));
}

#[test]
fn a_quote_is_one_undo_step() {
    let mut e = editor_with("one\ntwo");
    e.select_all();
    e.toggle_quote();
    assert!(e.undo());
    assert_eq!(shape(&e), [s("one", 0), s("two", 0)]);
    assert!(e.redo());
    assert_eq!(shape(&e), [s("one", 1), s("two", 1)]);
}

#[test]
fn a_quote_has_a_block_id_like_the_ts_schema_wants() {
    let mut e = editor_with("one");
    e.toggle_quote();
    let root = collabdoc_core::tree::root(e.document().loro());
    let quote = collabdoc_core::tree::child_maps(&root)[0].clone();
    assert!(collabdoc_core::tree::block_id(&quote).starts_with("b_"));
}
