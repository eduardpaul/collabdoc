//! The GPUI layer, headless: real key bindings and platform text input
//! driving `EditorView`, and two windows syncing through the workspace.

use collabdoc_core::{BlockKind, Document, Editor};
use collabdoc_gpui::editor_view::{self, EditorView};
use collabdoc_gpui::workspace::Workspace;
use gpui::{Entity, Focusable, TestAppContext, VisualTestContext};

fn setup(cx: &mut TestAppContext) -> Document {
    let doc = Document::create("Test", "me");
    cx.update(|cx| {
        editor_view::bind_keys(cx);
        cx.set_global(Workspace::new(&doc, None));
    });
    doc
}

fn open(
    cx: &mut TestAppContext,
    doc: Document,
    who: &str,
) -> (Entity<EditorView>, VisualTestContext) {
    let who = who.to_owned();
    let window = cx.add_window(|_, cx| EditorView::new(Editor::new(doc), who, cx));
    let view = window.root(cx).unwrap();
    let mut vcx = VisualTestContext::from_window(window.into(), cx);
    vcx.update(|window, cx| window.focus(&view.focus_handle(cx)));
    vcx.run_until_parked();
    (view, vcx)
}

fn texts(view: &Entity<EditorView>, cx: &mut VisualTestContext) -> Vec<String> {
    view.read_with(cx, |v, _| {
        v.editor.blocks().iter().map(|b| b.text.clone()).collect()
    })
}

#[gpui::test]
fn typing_enter_backspace_and_shortcuts(cx: &mut TestAppContext) {
    let doc = setup(cx);
    let (view, mut cx) = open(cx, doc, "You");

    cx.simulate_input("Hello world");
    cx.simulate_keystrokes("enter");
    cx.simulate_input("Second");
    cx.run_until_parked();
    assert_eq!(texts(&view, &mut cx), ["Hello world", "Second"]);

    cx.simulate_keystrokes("backspace backspace");
    assert_eq!(texts(&view, &mut cx), ["Hello world", "Seco"]);

    // Home, select to the end, bold.
    cx.simulate_keystrokes("home shift-end ctrl-b");
    let spans = view.read_with(&cx, |v, _| v.editor.blocks()[1].spans.clone());
    assert_eq!((spans[0].start, spans[0].end), (0, 4));

    cx.simulate_keystrokes("ctrl-alt-1");
    let kind = view.read_with(&cx, |v, _| v.editor.blocks()[1].kind);
    assert_eq!(kind, BlockKind::Heading(1));

    cx.simulate_keystrokes("ctrl-z");
    let kind = view.read_with(&cx, |v, _| v.editor.blocks()[1].kind);
    assert_eq!(kind, BlockKind::Paragraph, "undo reverts the heading");
}

#[gpui::test]
fn two_windows_are_two_synced_participants(cx: &mut TestAppContext) {
    let doc = setup(cx);
    let peer_doc = doc.fork("peer");
    let (mine, mut my_cx) = open(cx, doc, "You");
    let (theirs, mut their_cx) = open(cx, peer_doc, "Peer 2");

    my_cx.simulate_input("From me");
    my_cx.run_until_parked();
    assert_eq!(texts(&theirs, &mut their_cx), ["From me"]);

    their_cx.simulate_keystrokes("ctrl-end enter");
    their_cx.simulate_input("From the peer");
    their_cx.run_until_parked();
    assert_eq!(texts(&mine, &mut my_cx), ["From me", "From the peer"]);

    // Undo in my window takes back only my typing.
    my_cx.simulate_keystrokes("ctrl-z");
    my_cx.run_until_parked();
    assert_eq!(texts(&mine, &mut my_cx), ["", "From the peer"]);
    assert_eq!(texts(&theirs, &mut their_cx), ["", "From the peer"]);
}
