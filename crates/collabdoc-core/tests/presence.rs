//! Presence: carets travel as Loro cursors beside the document, never in it.

use collabdoc_core::presence::{Presence, User};
use collabdoc_core::sync::Hub;
use collabdoc_core::{Document, Editor};

fn user(name: &str) -> User {
    User {
        name: name.into(),
        color: "#e5484d".into(),
        actor_id: name.to_lowercase(),
        role: Some("human".into()),
    }
}

fn sync(hub: &Hub, editors: &mut [&mut Editor]) {
    for e in editors.iter() {
        hub.push(e.document()).unwrap();
    }
    for e in editors.iter_mut() {
        e.remote_change(|d| hub.pull(d)).unwrap();
    }
}

#[test]
fn a_caret_shows_up_where_the_other_participant_is_and_rides_edits() {
    let mut a = Editor::new(Document::create("t", "ana"));
    a.insert_text("hello world\nsecond");
    let hub = Hub::new(a.document());
    let mut b = Editor::new(a.document().fork("bo"));
    let (pa, pb) = (Presence::new(&a), Presence::new(&b));

    // Ana selects "world".
    a.set_selection(6, 11);
    hub.push_presence(&pa.publish(&a, &user("Ana"))).unwrap();
    pb.apply(&hub.presence()).unwrap();
    let carets = pb.carets(&b);
    assert_eq!(carets.len(), 1);
    assert_eq!(carets[0].peer, pa.peer());
    assert_eq!((carets[0].anchor, carets[0].head), (6, 11));
    assert_eq!(carets[0].user, Some(user("Ana")));
    assert!(
        pa.carets(&a).is_empty(),
        "our own entry is not a remote caret"
    );

    // Bo types in front of it: the selection still covers "world", and it
    // does not count as Ana moving.
    let moved = carets[0].moved;
    b.move_to(0);
    b.insert_text(">> ");
    let caret = &pb.carets(&b)[0];
    assert_eq!(b.text_in(caret.anchor..caret.head), "world");
    assert_eq!(caret.moved, moved);
    // Re-sending the same caret is not a move either; selecting less is.
    pb.apply(&pa.publish(&a, &user("Ana"))).unwrap();
    assert_eq!(pb.carets(&b)[0].moved, moved);
    a.set_selection(6, 9);
    pb.apply(&pa.publish(&a, &user("Ana"))).unwrap();
    assert_ne!(pb.carets(&b)[0].moved, moved);
    a.set_selection(6, 11);

    // And after a sync, Ana's view agrees.
    sync(&hub, &mut [&mut a, &mut b]);
    assert_eq!(a.text_in(a.selection()), "world");
}

#[test]
fn a_caret_in_another_block_lands_in_that_block() {
    let mut a = Editor::new(Document::create("t", "ana"));
    a.insert_text("one\ntwo\nthree");
    let b = Editor::new(a.document().fork("bo"));
    let (pa, pb) = (Presence::new(&a), Presence::new(&b));
    let at = a.block_start(2) + 2;
    a.move_to(at);
    pb.apply(&pa.publish(&a, &user("Ana"))).unwrap();
    let caret = &pb.carets(&b)[0];
    assert_eq!((caret.anchor, caret.head), (at, at));
}

#[test]
fn leaving_removes_the_caret_and_presence_is_never_in_the_document() {
    let mut a = Editor::new(Document::create("t", "ana"));
    a.insert_text("text");
    let b = Editor::new(a.document().fork("bo"));
    let (pa, pb) = (Presence::new(&a), Presence::new(&b));
    let version = a.document().version();
    pb.apply(&pa.publish(&a, &user("Ana"))).unwrap();
    assert_eq!(pb.carets(&b).len(), 1);
    assert_eq!(a.document().version(), version, "publishing edits nothing");
    // Moving at once (same millisecond) still gets through.
    a.move_to(1);
    pb.apply(&pa.publish(&a, &user("Ana"))).unwrap();
    assert_eq!(pb.carets(&b)[0].head, 1);

    pb.apply(&pa.leave()).unwrap();
    assert!(pb.carets(&b).is_empty());
}

#[test]
fn a_peer_that_published_no_user_is_unnamed_not_guessed() {
    let mut a = Editor::new(Document::create("t", "ana"));
    a.insert_text("text");
    let b = Editor::new(a.document().fork("bo"));
    let pb = Presence::new(&b);
    // A raw entry from another app: cursors, no `user`.
    let store = loro::awareness::EphemeralStore::new(15_000);
    let cursor = a.cursor_bytes(2).unwrap();
    store.set(
        "42",
        loro::LoroValue::Map(
            vec![
                (
                    "anchor".to_owned(),
                    loro::LoroValue::Binary(cursor.clone().into()),
                ),
                ("focus".to_owned(), loro::LoroValue::Binary(cursor.into())),
                ("user".to_owned(), loro::LoroValue::Null),
            ]
            .into(),
        ),
    );
    pb.apply(&store.encode_all()).unwrap();
    let caret = &pb.carets(&b)[0];
    assert_eq!(
        (caret.peer.as_str(), caret.head, caret.user.as_ref()),
        ("42", 2, None)
    );
}
