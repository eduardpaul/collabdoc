//! The editor contract: whatever the editor shows after a keystroke, handed to
//! `reconcile`, becomes the document — with block identity kept where it can be.

use collabdoc_core::model::normalize_spans;
use collabdoc_core::schema::mark_bit;
use collabdoc_core::sync::Hub;
use collabdoc_core::{BlockKind, Document, ListKind, Span, TargetBlock, ViewBlock};

fn targets(blocks: &[ViewBlock]) -> Vec<TargetBlock> {
    blocks.iter().map(TargetBlock::from).collect()
}

fn texts(doc: &Document) -> Vec<String> {
    doc.blocks().into_iter().map(|b| b.text).collect()
}

fn bold(start: u32, end: u32) -> Span {
    Span {
        start,
        end,
        marks: mark_bit("bold").unwrap(),
        href: String::new(),
    }
}

/// Types `text` into the first block, the way the editor would report it.
fn type_into(doc: &mut Document, index: usize, text: &str) {
    let mut t = targets(&doc.blocks());
    t[index].text = text.to_owned();
    assert!(doc.reconcile(&t));
}

#[test]
fn new_document_has_one_empty_paragraph() {
    let doc = Document::create("Notes", "me");
    let blocks = doc.blocks();
    assert_eq!(blocks.len(), 1);
    assert_eq!(blocks[0].kind, BlockKind::Paragraph);
    assert!(blocks[0].editable);
    assert!(blocks[0].block_id.starts_with("b_"));
    assert_eq!(doc.title(), "Notes");
}

#[test]
fn typing_keeps_the_block_and_unchanged_content_is_a_no_op() {
    let mut doc = Document::create("t", "me");
    let key = doc.blocks()[0].key.clone();
    type_into(&mut doc, 0, "Hello");
    type_into(&mut doc, 0, "Hello world");
    assert_eq!(texts(&doc), ["Hello world"]);
    assert_eq!(doc.blocks()[0].key, key);
    assert!(!doc.reconcile(&targets(&doc.blocks())));
}

#[test]
fn enter_splits_and_backspace_merges() {
    let mut doc = Document::create("t", "me");
    type_into(&mut doc, 0, "Hello world");
    let first = doc.blocks()[0].clone();

    // Qt: the first half keeps the block, the second is new.
    let split = vec![
        TargetBlock::new(Some(&first.key), BlockKind::Paragraph, "Hello "),
        TargetBlock::new(None, BlockKind::Paragraph, "world"),
    ];
    assert!(doc.reconcile(&split));
    let blocks = doc.blocks();
    assert_eq!(texts(&doc), ["Hello ", "world"]);
    assert_eq!(blocks[0].key, first.key);
    assert_ne!(blocks[1].block_id, first.block_id);

    let merged = vec![TargetBlock::new(
        Some(&first.key),
        BlockKind::Paragraph,
        "Hello world",
    )];
    assert!(doc.reconcile(&merged));
    assert_eq!(texts(&doc), ["Hello world"]);
    assert_eq!(doc.blocks()[0].key, first.key);
}

#[test]
fn enter_at_line_start_keeps_identity_with_the_text() {
    let mut doc = Document::create("t", "me");
    type_into(&mut doc, 0, "A long paragraph");
    let original = doc.blocks()[0].clone();
    // Qt keeps the key on the (now empty) first half.
    let split = vec![
        TargetBlock::new(Some(&original.key), BlockKind::Paragraph, ""),
        TargetBlock::new(None, BlockKind::Paragraph, "A long paragraph"),
    ];
    assert!(doc.reconcile(&split));
    let blocks = doc.blocks();
    assert_eq!(texts(&doc), ["", "A long paragraph"]);
    assert_eq!(blocks[1].key, original.key, "the text keeps its block");
    assert_eq!(blocks[1].block_id, original.block_id);
}

#[test]
fn marks_follow_the_editor() {
    let mut doc = Document::create("t", "me");
    type_into(&mut doc, 0, "make this bold");
    let mut t = targets(&doc.blocks());
    t[0].spans = vec![bold(5, 9)];
    assert!(doc.reconcile(&t));
    assert_eq!(doc.blocks()[0].spans, vec![bold(5, 9)]);

    // Typing at the end of a bold run extends it (expand: after) …
    let mut t = targets(&doc.blocks());
    t[0].text = "make thisX bold".into();
    t[0].spans = vec![bold(5, 10)];
    doc.reconcile(&t);
    assert_eq!(doc.blocks()[0].spans, vec![bold(5, 10)]);

    // … and unbolding part of it splits the run.
    let mut t = targets(&doc.blocks());
    t[0].spans = vec![bold(5, 7)];
    doc.reconcile(&t);
    assert_eq!(doc.blocks()[0].spans, vec![bold(5, 7)]);
}

#[test]
fn links_store_their_href() {
    let mut doc = Document::create("t", "me");
    type_into(&mut doc, 0, "see docs");
    let link = mark_bit("link").unwrap();
    let mut t = targets(&doc.blocks());
    t[0].spans = vec![Span {
        start: 4,
        end: 8,
        marks: link,
        href: "https://loro.dev".into(),
    }];
    doc.reconcile(&t);
    let spans = doc.blocks()[0].spans.clone();
    assert_eq!(
        spans,
        vec![Span {
            start: 4,
            end: 8,
            marks: link,
            href: "https://loro.dev".into()
        }]
    );
}

#[test]
fn block_kinds_change_in_place() {
    let mut doc = Document::create("t", "me");
    type_into(&mut doc, 0, "Title");
    let key = doc.blocks()[0].key.clone();
    let t = vec![TargetBlock::new(Some(&key), BlockKind::Heading(2), "Title")];
    assert!(doc.reconcile(&t));
    let b = &doc.blocks()[0];
    assert_eq!(
        (b.kind, b.key.as_str()),
        (BlockKind::Heading(2), key.as_str())
    );
    let t = vec![TargetBlock::new(
        Some(&key),
        BlockKind::CodeBlock,
        "let x = 1;\nlet y = 2;",
    )];
    doc.reconcile(&t);
    assert_eq!(doc.blocks()[0].kind, BlockKind::CodeBlock);
    assert_eq!(doc.blocks()[0].text, "let x = 1;\nlet y = 2;");
}

#[test]
fn deleting_everything_leaves_one_paragraph() {
    let mut doc = Document::create("t", "me");
    type_into(&mut doc, 0, "one");
    let key = doc.blocks()[0].key.clone();
    doc.reconcile(&[
        TargetBlock::new(Some(&key), BlockKind::Paragraph, "one"),
        TargetBlock::new(None, BlockKind::Paragraph, "two"),
    ]);
    assert!(doc.reconcile(&[TargetBlock::new(None, BlockKind::Paragraph, "")]));
    assert_eq!(texts(&doc), [""]);
}

#[test]
fn undo_and_redo_are_per_participant_steps() {
    let mut doc = Document::create("t", "me");
    type_into(&mut doc, 0, "first");
    // A block switch cuts the step.
    let key = doc.blocks()[0].key.clone();
    doc.reconcile(&[
        TargetBlock::new(Some(&key), BlockKind::Paragraph, "first"),
        TargetBlock::new(None, BlockKind::Paragraph, "second"),
    ]);
    assert!(doc.can_undo());
    assert!(doc.undo());
    assert_eq!(texts(&doc), ["first"]);
    assert!(doc.undo());
    assert_eq!(texts(&doc), [""]);
    assert!(doc.redo());
    assert_eq!(texts(&doc), ["first"]);
}

#[test]
fn undo_never_reverts_a_collaborator() {
    let mut me = Document::create("t", "me");
    let mut you = me.fork("you");
    let hub = Hub::new(&me);
    type_into(&mut me, 0, "mine");
    hub.push(&me).unwrap();
    hub.pull(&mut you).unwrap();
    let mut t = targets(&you.blocks());
    t.push(TargetBlock::new(None, BlockKind::Paragraph, "yours"));
    you.reconcile(&t);
    hub.push(&you).unwrap();
    hub.pull(&mut me).unwrap();
    assert_eq!(texts(&me), ["mine", "yours"]);
    me.undo();
    assert_eq!(texts(&me), ["", "yours"]);
}

#[test]
fn concurrent_edits_in_one_block_merge() {
    let mut a = Document::create("t", "a");
    type_into(&mut a, 0, "The cat sat");
    let mut b = a.fork("b");
    let hub = Hub::new(&a);
    type_into(&mut a, 0, "The black cat sat");
    type_into(&mut b, 0, "The cat sat down");
    hub.push(&a).unwrap();
    hub.push(&b).unwrap();
    hub.pull(&mut a).unwrap();
    hub.pull(&mut b).unwrap();
    assert_eq!(texts(&a), ["The black cat sat down"]);
    assert_eq!(texts(&a), texts(&b));
}

#[test]
fn collabdoc_files_round_trip() {
    let mut doc = Document::create("Saved", "me");
    type_into(&mut doc, 0, "persist me");
    let bytes = doc.to_collabdoc();
    let reopened = Document::from_collabdoc(&bytes, "me").unwrap();
    assert_eq!(reopened.title(), "Saved");
    assert_eq!(reopened.doc_id(), doc.doc_id());
    assert_eq!(texts(&reopened), ["persist me"]);
}

#[test]
fn spans_normalise() {
    let spans = normalize_spans(10, &[bold(0, 3), bold(3, 5), bold(8, 20)]);
    assert_eq!(spans, vec![bold(0, 5), bold(8, 10)]);
}

/// A tree shaped like a Tiptap document: heading, list with a nested list, figure.
fn tiptap_like() -> Document {
    use collabdoc_core::schema::*;
    use loro::{LoroList, LoroMap, LoroText};
    let doc = Document::create("t", "me");
    let loro = doc.loro();
    let root = loro.get_map(ROOT_DOC_KEY);
    let kids = collabdoc_core::tree::children(&root);
    kids.delete(0, kids.len()).unwrap();
    let node = |parent: &LoroList, at: usize, name: &str, id: &str, text: Option<&str>| {
        let m = parent.insert_container(at, LoroMap::new()).unwrap();
        m.insert(NODE_NAME_KEY, name).unwrap();
        let a = m.insert_container(ATTRIBUTES_KEY, LoroMap::new()).unwrap();
        a.insert(BLOCK_ID_ATTR, id).unwrap();
        let c = m.insert_container(CHILDREN_KEY, LoroList::new()).unwrap();
        if let Some(t) = text {
            c.insert_container(0, LoroText::new())
                .unwrap()
                .insert(0, t)
                .unwrap();
        }
        (m, a, c)
    };
    let (_, a, _) = node(&kids, 0, "heading", "b_h", Some("Plan"));
    a.insert("level", 1.0).unwrap();
    let (_, _, list) = node(&kids, 1, "bulletList", "", None);
    let (_, _, item) = node(&list, 0, "listItem", "b_i1", None);
    node(&item, 0, "paragraph", "b_p1", Some("one"));
    let (_, _, nested) = node(&item, 1, "orderedList", "", None);
    let (_, _, item2) = node(&nested, 0, "listItem", "b_i2", None);
    node(&item2, 0, "paragraph", "b_p2", Some("one.a"));
    let (_, _, item3) = node(&list, 1, "listItem", "b_i3", None);
    node(&item3, 0, "paragraph", "b_p3", Some("two"));
    let (_, a, _) = node(&kids, 2, "mermaidFigure", "b_m", Some("Flow"));
    a.insert("source", "graph TD; A-->B").unwrap();
    loro.commit();
    doc
}

#[test]
fn nested_lists_and_figures_flatten_in_reading_order() {
    let doc = tiptap_like();
    let blocks = doc.blocks();
    let summary: Vec<_> = blocks
        .iter()
        .map(|b| (b.text.as_str(), b.kind, b.list, b.list_depth, b.editable))
        .collect();
    assert_eq!(
        summary,
        vec![
            ("Plan", BlockKind::Heading(1), None, 0, true),
            ("one", BlockKind::Paragraph, Some(ListKind::Bullet), 1, true),
            (
                "one.a",
                BlockKind::Paragraph,
                Some(ListKind::Ordered),
                2,
                true
            ),
            ("two", BlockKind::Paragraph, Some(ListKind::Bullet), 1, true),
            ("[Mermaid diagram: Flow]", BlockKind::Atom, None, 0, false),
        ]
    );
}

#[test]
fn enter_in_a_list_makes_a_list_item_in_reading_order() {
    let mut doc = tiptap_like();
    let mut t = targets(&doc.blocks());
    // Enter after "one" (which has a nested list): the new line reads next.
    t.insert(2, TargetBlock::new(None, BlockKind::Paragraph, "inserted"));
    // Enter after "two", the last item.
    t.insert(5, TargetBlock::new(None, BlockKind::Paragraph, "three"));
    assert!(doc.reconcile(&t));
    let got: Vec<_> = doc
        .blocks()
        .iter()
        .map(|b| (b.text.clone(), b.list, b.list_depth))
        .collect();
    let want: Vec<(String, Option<ListKind>, u8)> = vec![
        ("Plan".into(), None, 0),
        ("one".into(), Some(ListKind::Bullet), 1),
        ("inserted".into(), Some(ListKind::Ordered), 2),
        ("one.a".into(), Some(ListKind::Ordered), 2),
        ("two".into(), Some(ListKind::Bullet), 1),
        ("three".into(), Some(ListKind::Bullet), 1),
        ("[Mermaid diagram: Flow]".into(), None, 0),
    ];
    assert_eq!(got, want);
}

#[test]
fn figures_ignore_text_edits_but_can_be_deleted() {
    let mut doc = tiptap_like();
    let mut t = targets(&doc.blocks());
    t[4].text = "typed into a figure".into();
    assert!(!doc.reconcile(&t));
    t.remove(4);
    assert!(doc.reconcile(&t));
    assert_eq!(doc.blocks().len(), 4);
}

#[test]
fn removing_the_last_item_drops_the_empty_list() {
    let mut doc = tiptap_like();
    let t: Vec<_> = targets(&doc.blocks())
        .into_iter()
        .filter(|b| b.text != "one.a")
        .collect();
    doc.reconcile(&t);
    assert_eq!(
        texts(&doc),
        ["Plan", "one", "two", "[Mermaid diagram: Flow]"]
    );
    // The emptied nested list is gone, not left behind as an empty container.
    let json = doc.loro().get_deep_value();
    assert!(!format!("{json:?}").contains("orderedList"));
}

#[test]
fn a_list_line_cannot_become_a_heading() {
    let mut doc = tiptap_like();
    let mut t = targets(&doc.blocks());
    t[1].kind = Some(BlockKind::Heading(1));
    assert!(!doc.reconcile(&t));
    assert_eq!(doc.blocks()[1].kind, BlockKind::Paragraph);
}
