//! Keystroke-level behaviour of the toolkit-independent editor.

use collabdoc_core::schema::mark_bit;
use collabdoc_core::sync::Hub;
use collabdoc_core::{BlockKind, Document, Editor, Span};

fn editor() -> Editor {
    Editor::new(Document::create("t", "me"))
}

fn texts(e: &Editor) -> Vec<String> {
    e.blocks().iter().map(|b| b.text.clone()).collect()
}

fn kinds(e: &Editor) -> Vec<BlockKind> {
    e.blocks().iter().map(|b| b.kind).collect()
}

fn bit(name: &str) -> u32 {
    mark_bit(name).unwrap()
}

#[test]
fn typing_enter_and_backspace() {
    let mut e = editor();
    e.insert_text("Hello world");
    assert_eq!(e.head(), 11);
    e.move_to(5);
    e.newline();
    assert_eq!(texts(&e), ["Hello", " world"]);
    assert_eq!(e.head(), 6, "caret at the start of the new block");
    e.backspace();
    assert_eq!(texts(&e), ["Hello world"]);
    assert_eq!(e.head(), 5);
    e.delete_forward();
    assert_eq!(texts(&e), ["Helloworld"]);
}

#[test]
fn enter_at_line_start_moves_the_block_down_with_its_identity() {
    let mut e = editor();
    e.insert_text("Paragraph");
    let id = e.blocks()[0].block_id.clone();
    e.move_to(0);
    e.newline();
    assert_eq!(texts(&e), ["", "Paragraph"]);
    assert_eq!(e.blocks()[1].block_id, id);
}

#[test]
fn selection_across_blocks_is_replaced_by_typing() {
    let mut e = editor();
    e.insert_text("one\ntwo\nthree");
    assert_eq!(texts(&e), ["one", "two", "three"]);
    e.set_selection(2, 9); // "e\ntwo\nt"
    assert_eq!(e.text_in(e.selection()), "e\ntwo\nt");
    e.insert_text("X");
    assert_eq!(texts(&e), ["onXhree"]);
    assert_eq!(e.head(), 3);
}

#[test]
fn arrows_step_over_graphemes_and_block_boundaries() {
    let mut e = editor();
    e.insert_text("a👍🏽\nb");
    e.move_to(0);
    e.move_right(false);
    assert_eq!(e.head(), 1);
    e.move_right(false);
    assert_eq!(e.head(), 5, "the emoji with its modifier is one step");
    e.move_right(false);
    assert_eq!(e.head(), 6, "into the next block");
    e.move_left(false);
    assert_eq!(e.head(), 5);
    e.move_left(true);
    assert_eq!(e.selection(), 1..5);
    e.move_home(false);
    assert_eq!(e.head(), 0);
    e.move_end(false);
    assert_eq!(e.head(), 5);
}

#[test]
fn bold_toggles_on_a_selection_and_for_the_next_typing() {
    let mut e = editor();
    e.insert_text("make bold");
    e.set_selection(5, 9);
    e.toggle_mark(bit("bold"));
    assert_eq!(
        e.blocks()[0].spans,
        vec![Span {
            start: 5,
            end: 9,
            marks: bit("bold"),
            href: String::new()
        }]
    );
    // Typing at the end of a bold run stays bold (expand: after).
    e.move_to(9);
    assert_eq!(e.marks_at_cursor(), bit("bold"));
    e.insert_text("!");
    assert_eq!(e.blocks()[0].spans[0].end, 10);
    // Toggle again on the whole run removes it.
    e.set_selection(5, 10);
    e.toggle_mark(bit("bold"));
    assert!(e.blocks()[0].spans.is_empty());
    // With no selection the toggle applies to what is typed next.
    e.move_to(0);
    e.toggle_mark(bit("italic"));
    e.insert_text("I");
    assert_eq!(
        e.blocks()[0].spans,
        vec![Span {
            start: 0,
            end: 1,
            marks: bit("italic"),
            href: String::new()
        }]
    );
}

#[test]
fn code_marks_do_not_grow_at_their_end() {
    let mut e = editor();
    e.insert_text("x = 1");
    e.select_all();
    e.toggle_mark(bit("code"));
    e.move_to(5);
    e.insert_text(" ok");
    assert_eq!(
        e.blocks()[0].spans,
        vec![Span {
            start: 0,
            end: 5,
            marks: bit("code"),
            href: String::new()
        }]
    );
}

#[test]
fn headings_and_code_blocks() {
    let mut e = editor();
    e.insert_text("Title");
    e.set_kind(BlockKind::Heading(1));
    assert_eq!(kinds(&e), [BlockKind::Heading(1)]);
    // Enter at the end of a heading continues with a paragraph …
    e.newline();
    assert_eq!(kinds(&e), [BlockKind::Heading(1), BlockKind::Paragraph]);
    // … and inside a code block it is a line break.
    e.insert_text("fn main() {");
    e.set_kind(BlockKind::CodeBlock);
    e.newline();
    e.insert_text("}");
    assert_eq!(texts(&e), ["Title", "fn main() {\n}"]);
    assert_eq!(kinds(&e)[1], BlockKind::CodeBlock);
}

#[test]
fn undo_steps_follow_the_caret_like_the_tiptap_editor() {
    let mut e = editor();
    e.insert_text("first");
    // Enter and typing on are one step: the caret never left the edit.
    e.newline();
    e.insert_text("second");
    // Clicking back into the first block and typing there cuts a step.
    e.move_to(5);
    e.insert_text("!");
    assert!(e.undo());
    assert_eq!(texts(&e), ["first", "second"]);
    assert!(e.head() <= e.len());
    assert!(e.undo());
    assert_eq!(texts(&e), [""]);
    assert!(e.redo());
    assert_eq!(texts(&e), ["first", "second"]);
}

#[test]
fn a_collaborators_edit_keeps_my_caret_in_my_block() {
    let doc = Document::create("t", "me");
    let mut me = Editor::new(doc);
    me.insert_text("mine");
    let hub = Hub::new(me.document());
    let mut you = Editor::new(me.document().fork("you"));

    // I am typing at the end of my line; you insert a block above it.
    you.move_to(0);
    you.insert_text("yours\n");
    hub.push(you.document()).unwrap();
    me.remote_change(|doc| hub.pull(doc)).unwrap();
    assert_eq!(texts(&me), ["yours", "mine"]);
    assert_eq!(me.head(), 6 + 4, "still at the end of \"mine\"");
}

#[test]
fn a_collaborators_insert_before_my_caret_pushes_it_along() {
    let mut me = Editor::new(Document::create("t", "me"));
    me.insert_text("Written by me");
    let hub = Hub::new(me.document());
    let mut you = Editor::new(me.document().fork("you"));
    you.move_to(0);
    you.insert_text("Edited: ");
    hub.push(you.document()).unwrap();
    me.remote_change(|doc| hub.pull(doc)).unwrap();
    assert_eq!(texts(&me), ["Edited: Written by me"]);
    assert_eq!(me.head(), 21, "my caret stays after \"me\"");
}

#[test]
fn paste_of_several_lines_makes_blocks() {
    let mut e = editor();
    e.insert_text("ab");
    e.move_to(1);
    e.insert_text("1\n2\n3");
    assert_eq!(texts(&e), ["a1", "2", "3b"]);
    assert_eq!(e.head(), 6, "after the pasted \"3\"");
}

#[test]
fn formatting_commands_are_their_own_undo_steps() {
    let mut e = editor();
    e.insert_text("Title");
    e.set_kind(BlockKind::Heading(1));
    e.select_all();
    e.toggle_mark(bit("italic"));
    assert!(e.undo());
    assert!(e.blocks()[0].spans.is_empty());
    assert_eq!(kinds(&e), [BlockKind::Heading(1)]);
    assert!(e.undo());
    assert_eq!(kinds(&e), [BlockKind::Paragraph]);
    assert_eq!(texts(&e), ["Title"]);
}

#[test]
fn links_are_set_edited_found_and_removed() {
    let mut e = editor();
    e.insert_text("read the docs today");
    e.set_selection(9, 13);
    assert!(e.set_link("https://loro.dev"));
    let link = bit("link");
    let span = e.blocks()[0].spans[0].clone();
    assert_eq!(
        (span.start, span.end, span.marks, span.href.as_str()),
        (9, 13, link, "https://loro.dev")
    );

    // The caret inside (or right after) the link finds all of it.
    assert_eq!(e.link_at(11), Some((9..13, "https://loro.dev".to_owned())));
    assert_eq!(e.link_at(13), Some((9..13, "https://loro.dev".to_owned())));
    assert_eq!(e.link_at(3), None);

    // Ctrl+K with the caret in it edits the whole link.
    e.move_to(10);
    assert!(e.set_link("https://loro.dev/docs"));
    assert_eq!(e.link_at(10).unwrap().1, "https://loro.dev/docs");
    assert_eq!(e.blocks()[0].spans.len(), 1);

    // An empty href removes it.
    e.move_to(10);
    assert!(e.set_link(""));
    assert!(e.blocks()[0].spans.is_empty());

    // With nothing selected and no link, the URL goes in as linked text.
    e.move_to(e.len());
    assert!(e.set_link("https://example.com"));
    assert_eq!(e.blocks()[0].text, "read the docs todayhttps://example.com");
    assert_eq!(e.link_at(e.len()).unwrap().0, 19..38);
}

#[test]
fn ctrl_arrows_move_by_word_and_ctrl_backspace_deletes_one() {
    let mut e = Editor::new(Document::create("t", "me"));
    e.insert_text("Hello, wörld 👍 snake_case\nnext");
    let end = e.block_start(0) + "Hello, wörld 👍 snake_case".encode_utf16().count();
    // Left: to word starts, skipping punctuation, spaces and emoji.
    e.move_to(end);
    let mut stops = vec![];
    for _ in 0..4 {
        e.move_word_left(false);
        stops.push(e.head());
    }
    let at = |s: &str| s.encode_utf16().count();
    assert_eq!(stops, [at("Hello, wörld 👍 "), at("Hello, "), 0, 0]);
    // Right: to word ends; at the end of the block, into the next.
    let mut stops = vec![];
    for _ in 0..4 {
        e.move_word_right(false);
        stops.push(e.head());
    }
    assert_eq!(stops, [at("Hello"), at("Hello, wörld"), end, end + 1]);
    // Left at the start of a block goes to the end of the one before.
    e.move_word_left(false);
    assert_eq!(e.head(), end);
    // Shift extends.
    e.move_word_left(true);
    assert_eq!(e.text_in(e.selection()), "snake_case");

    e.move_to(end);
    assert!(e.delete_word_backward());
    assert_eq!(e.blocks()[0].text, "Hello, wörld 👍 ");
    e.move_to(0);
    assert!(e.delete_word_forward());
    assert_eq!(e.blocks()[0].text, ", wörld 👍 ");
}

#[test]
fn typing_on_a_figure_starts_a_line_beside_it() {
    let mut e = Editor::new(Document::create("t", "me"));
    e.insert_text("before");
    assert!(e.insert_mermaid("graph TD; A-->B"));
    let figure = e.blocks().len() - 1;
    assert_eq!(
        e.blocks()[figure].kind,
        BlockKind::Atom,
        "the figure ends the document"
    );
    // From its end: Enter opens a paragraph after it, and typing goes there.
    let end = e.len();
    e.move_to(end);
    assert!(e.newline());
    e.insert_text("after");
    let texts: Vec<_> = e
        .blocks()
        .iter()
        .map(|b| (b.kind, b.text.clone()))
        .collect();
    assert_eq!(texts.len(), 3);
    assert_eq!(texts[2], (BlockKind::Paragraph, "after".into()));
    // From its start: typing goes into a new line before it.
    let start = e.block_start(1);
    e.move_to(start);
    e.insert_text("x");
    assert_eq!(e.blocks()[1].text, "x");
    assert_eq!(e.blocks()[2].kind, BlockKind::Atom);
    // One undo step each.
    assert!(e.undo());
    assert_eq!(e.blocks().len(), 3);
}
