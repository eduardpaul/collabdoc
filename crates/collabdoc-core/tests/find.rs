//! Find and replace, with the TS find bar's rules.

use collabdoc_core::schema::mark_bit;
use collabdoc_core::{BlockKind, Document, Editor};

fn editor_with(text: &str) -> Editor {
    let mut e = Editor::new(Document::create("t", "me"));
    e.insert_text(text);
    e
}

fn texts(e: &Editor) -> Vec<String> {
    e.blocks().iter().map(|b| b.text.clone()).collect()
}

#[test]
fn finds_within_blocks_ignoring_case_unless_asked() {
    let e = editor_with("Loro and loro\nLORO 👍 loro\nlo\nro");
    let hits = e.find("loro", false);
    let words: Vec<String> = hits.iter().map(|r| e.text_in(r.clone())).collect();
    assert_eq!(words, ["Loro", "loro", "LORO", "loro"]);
    // UTF-16 offsets after the emoji.
    let second_line = e.block_start(1);
    assert_eq!(hits[3], second_line + 8..second_line + 12);
    assert_eq!(e.find("loro", true).len(), 2);
    assert!(e.find("lo\nro", false).is_empty(), "never across blocks");
    assert!(e.find("", false).is_empty());
    assert_eq!(e.find("oo", false).len(), 0);
    let e = editor_with("aaaa");
    assert_eq!(e.find("aa", false), [0..2, 2..4], "no overlaps");
}

#[test]
fn figures_are_not_searched() {
    let mut e = editor_with("");
    e.paste("```mermaid\ngraph TD; A-->B\n```\n\nA Mermaid note");
    assert_eq!(e.blocks()[0].kind, BlockKind::Atom);
    let hits = e.find("mermaid", false);
    assert_eq!(hits.len(), 1);
    assert_eq!(e.text_in(hits[0].clone()), "Mermaid");
    assert!(hits[0].start >= e.block_start(1));
}

#[test]
fn replace_all_is_one_undo_step_and_keeps_marks() {
    let mut e = editor_with("cat and Cat\nno cats here");
    // Bold the first "cat".
    e.set_selection(0, 3);
    e.toggle_mark(mark_bit("bold").unwrap());
    e.move_to(0);
    let hits = e.find("cat", false);
    assert_eq!(hits.len(), 3);
    assert!(e.replace_matches(&hits, "dog"));
    assert_eq!(texts(&e), ["dog and dog", "no dogs here"]);
    let bold = &e.blocks()[0].spans;
    assert_eq!(
        (bold[0].start, bold[0].end),
        (0, 3),
        "the bold word stays bold"
    );
    assert_eq!(bold.len(), 1);
    assert_eq!(e.head(), e.block_start(1) + 6, "caret after the last one");

    assert!(e.undo());
    assert_eq!(texts(&e), ["cat and Cat", "no cats here"]);
}

#[test]
fn replacing_one_match_moves_on_from_there() {
    let mut e = editor_with("one two one two one");
    let hits = e.find("one", false);
    assert!(e.replace_matches(&hits[1..2], "1"));
    assert_eq!(texts(&e), ["one two 1 two one"]);
    assert_eq!(e.head(), 9);
    // The next match is the first one at or after the caret.
    let next = e
        .find("one", false)
        .into_iter()
        .find(|r| r.start >= e.head());
    assert_eq!(next, Some(14..17));
}

#[test]
fn a_replacement_keeps_a_link_and_drops_partial_marks() {
    let mut e = editor_with("see docs here");
    e.set_selection(4, 8);
    e.set_link("https://loro.dev");
    e.set_selection(8, 13);
    e.toggle_mark(mark_bit("italic").unwrap());
    let hits = e.find("docs", false);
    e.replace_matches(&hits, "guide");
    let spans = &e.blocks()[0].spans;
    assert_eq!(spans[0].href, "https://loro.dev");
    assert_eq!((spans[0].start, spans[0].end), (4, 9));
    // "s h" spans a link end and an italic start: shares neither.
    let hits = e.find("e h", false);
    e.replace_matches(&hits, "E\nH");
    assert_eq!(texts(&e), ["see guidE Here"], "line breaks become spaces");
    let marks_at = |at: u32| {
        e.blocks()[0]
            .spans
            .iter()
            .find(|s| s.start <= at && at < s.end)
            .map_or(0, |s| s.marks)
    };
    assert_eq!(marks_at(9), 0);
}

#[test]
fn ranges_that_do_not_fit_change_nothing() {
    let mut e = editor_with("abc\ndef");
    let across_a_break = 2..5;
    let past_the_end = 10..12;
    assert!(!e.replace_matches(&[across_a_break], "x"));
    assert!(!e.replace_matches(&[past_the_end], "x"));
    assert_eq!(texts(&e), ["abc", "def"]);
}
