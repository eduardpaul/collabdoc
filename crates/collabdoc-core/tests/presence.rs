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

use collabdoc_core::presence::{Claim, PRESENCE_MAX_HZ, iso_time, now_ms, parse_iso_time};

fn two(text: &str) -> (Editor, Editor) {
    let mut a = Editor::new(Document::create("t", "ana"));
    a.insert_text(text);
    let b = Editor::new(a.document().fork("bo"));
    (a, b)
}

#[test]
fn iso_times_read_and_write_like_javascript() {
    // `new Date(1793000123456).toISOString()` in Node.
    assert_eq!(iso_time(1_793_000_123_456), "2026-10-26T07:35:23.456Z");
    assert_eq!(iso_time(0), "1970-01-01T00:00:00.000Z");
    assert_eq!(iso_time(951_782_400_000), "2000-02-29T00:00:00.000Z");
    for ms in [0, 951_782_400_000, 1_793_000_123_456, now_ms()] {
        assert_eq!(parse_iso_time(&iso_time(ms)), Some(ms));
    }
    assert_eq!(
        parse_iso_time("2026-10-26T07:35:23Z"),
        Some(1_793_000_123_000)
    );
    assert_eq!(
        parse_iso_time("2026-10-26T07:35:23.4Z"),
        Some(1_793_000_123_400)
    );
    assert_eq!(parse_iso_time("yesterday"), None);
    assert_eq!(parse_iso_time("2026-13-26T08:15:23Z"), None);
}

// AC-07.6: a claim travels with the caret and ends when `until` passes or
// the claimer clears it.
#[test]
fn claims_show_until_they_run_out_or_are_cleared() {
    let (a, b) = two("one\ntwo");
    let (pa, pb) = (Presence::new(&a), Presence::new(&b));
    let block = a.blocks()[1].block_id.clone();
    pa.set_claim(Some(Claim::for_seconds(vec![block.clone()], 30.0)));
    pb.apply(&pa.publish(&a, &user("Ana"))).unwrap();
    let claim = pb.carets(&b)[0].claim.clone().expect("the claim arrived");
    assert_eq!(claim.block_ids, std::slice::from_ref(&block));
    let until = parse_iso_time(&claim.until).unwrap();
    assert!((until - now_ms() - 30_000).abs() < 2_000);
    assert_eq!(pb.claimed_by(&block).as_deref(), Some("Ana"));
    assert_eq!(
        pa.claimed_by(&block),
        None,
        "our own claim is not in our way"
    );
    assert_eq!(pb.claimed_by(&a.blocks()[0].block_id), None);

    pa.set_claim(None);
    pb.apply(&pa.publish(&a, &user("Ana"))).unwrap();
    assert_eq!(pb.carets(&b)[0].claim, None);
    assert_eq!(pb.claimed_by(&block), None);

    // One that has run out reads as none, whoever sent it.
    let stale = Claim {
        block_ids: vec![block.clone()],
        until: iso_time(now_ms() + 150),
    };
    pa.set_claim(Some(stale));
    pb.apply(&pa.publish(&a, &user("Ana"))).unwrap();
    assert!(pb.carets(&b)[0].claim.is_some());
    std::thread::sleep(std::time::Duration::from_millis(200));
    assert_eq!(pb.carets(&b)[0].claim, None);
    assert_eq!(pa.claim(), None);
    // Claims are capped at two minutes.
    let long = Claim::for_seconds(vec![block], 3600.0);
    assert!(parse_iso_time(&long.until).unwrap() - now_ms() <= 120_000);
}

// AC-07.3: silence makes a participant disappear; coming back does not
// duplicate them.
#[test]
fn a_silent_participant_times_out_and_returns_once() {
    let (a, b) = two("text");
    let pa = Presence::new(&a);
    let pb = Presence::with_timeout(&b, 100);
    let update = pa.publish(&a, &user("Ana"));
    pb.apply(&update).unwrap();
    assert_eq!(pb.actors(&b, None).len(), 1);
    std::thread::sleep(std::time::Duration::from_millis(250));
    assert!(pb.carets(&b).is_empty(), "gone after the timeout");
    assert!(pb.actors(&b, None).is_empty());
    pb.apply(&pa.publish(&a, &user("Ana"))).unwrap();
    pb.apply(&pa.publish(&a, &user("Ana"))).unwrap();
    assert_eq!(pb.carets(&b).len(), 1, "back once, not twice");
}

// AC-07.5: roles are what peers published, never guessed.
#[test]
fn actors_list_everyone_with_only_what_they_published() {
    let (mut a, b) = two("one\ntwo");
    let (pa, pb) = (Presence::new(&a), Presence::new(&b));
    a.move_to(a.block_start(1) + 2);
    let block = a.blocks()[1].block_id.clone();
    pa.set_claim(Some(Claim::for_seconds(vec![block.clone()], 30.0)));
    pb.apply(&pa.publish(&a, &user("Ana"))).unwrap();
    let agent = User {
        name: "Writer".into(),
        color: "#7c3aed".into(),
        actor_id: "agent_writer".into(),
        role: Some("agent".into()),
    };
    pb.apply(&pb.publish(&b, &agent)).unwrap();
    // A peer with a caret and no `user`.
    let raw = loro::awareness::EphemeralStore::new(15_000);
    let cursor = a.cursor_bytes(0).unwrap();
    raw.set(
        "42",
        loro::LoroValue::Map(
            vec![("focus".to_owned(), loro::LoroValue::Binary(cursor.into()))].into(),
        ),
    );
    pb.apply(&raw.encode_all()).unwrap();

    let actors = pb.actors(&b, None);
    assert_eq!(actors.len(), 3, "us, Ana and the unnamed peer");
    let ana = actors.iter().find(|x| x.actor_id == "ana").unwrap();
    assert_eq!(ana.role.as_deref(), Some("human"));
    assert_eq!(ana.peer_id, pa.peer());
    let at = ana.cursor.as_ref().unwrap();
    assert_eq!((at.block_id.as_str(), at.offset), (block.as_str(), 2));
    assert_eq!(
        ana.claim.as_ref().unwrap().block_ids,
        std::slice::from_ref(&block)
    );
    let me = actors.iter().find(|x| x.peer_id == pb.peer()).unwrap();
    assert_eq!(
        (me.actor_id.as_str(), me.role.as_deref()),
        ("agent_writer", Some("agent"))
    );
    let stranger = actors.iter().find(|x| x.peer_id == "42").unwrap();
    assert_eq!(stranger.actor_id, "42");
    assert_eq!(
        (stranger.role.as_ref(), stranger.name.as_ref()),
        (None, None)
    );
    let json = serde_json::to_value(stranger).unwrap();
    assert!(
        json.get("role").is_none(),
        "role left out, not null: {json}"
    );

    // Near a block: whoever is in it or claims it.
    let near: Vec<String> = pb
        .actors(&b, Some(&block))
        .into_iter()
        .map(|x| x.actor_id)
        .collect();
    assert_eq!(near, ["ana"]);
}

// AC-07.7: presence is never in history, the saved file or Markdown.
#[test]
fn presence_never_reaches_history_the_file_or_markdown() {
    let (mut a, b) = two("text");
    let hub = Hub::new(a.document());
    let pa = Presence::new(&a);
    let pb = Presence::new(&b);
    let history = collabdoc_core::history::list_history(a.document().loro()).len();
    let block = a.blocks()[0].block_id.clone();
    pa.set_claim(Some(Claim::for_seconds(vec![block], 30.0)));
    let secret = User {
        name: "Zed Presence-Only".into(),
        ..user("Ana")
    };
    for at in 0..4 {
        a.move_to(at);
        hub.push_presence(&pa.publish(&a, &secret)).unwrap();
    }
    pb.apply(&hub.presence()).unwrap();
    assert_eq!(pb.carets(&b).len(), 1);
    hub.push(a.document()).unwrap();
    a.remote_change(|d| hub.pull(d)).unwrap();

    let entries = collabdoc_core::history::list_history(a.document().loro());
    assert_eq!(entries.len(), history, "no history entry");
    let file = a.document().to_collabdoc();
    let needle = b"Zed Presence-Only";
    assert!(
        !file.windows(needle.len()).any(|w| w == needle),
        "not in the file"
    );
    let hub_file =
        Document::from_snapshot(&hub.loro().export(loro::ExportMode::Snapshot).unwrap(), "x")
            .unwrap()
            .to_collabdoc();
    assert!(!hub_file.windows(needle.len()).any(|w| w == needle));
    let markdown = collabdoc_core::markdown::render(a.blocks());
    assert!(!markdown.contains("Zed"), "not in Markdown: {markdown}");
}

// AC-07.8: a participant moving all the time, sending as often as the
// pace allows, stays under 2 KB/s and still updates within 100 ms (07.2).
#[test]
fn presence_traffic_stays_under_two_kilobytes_a_second() {
    let mut a = Editor::new(Document::create(
        "t",
        "4b1e6a52-0d7f-4c55-9a43-1f3c2b9e8d10",
    ));
    a.insert_text(&"A paragraph of some length to move around in. ".repeat(20));
    let pa = Presence::new(&a);
    let me = User {
        name: "Ana María Lopez de la Fuente".into(),
        color: "#c45c26".into(),
        actor_id: "4b1e6a52-0d7f-4c55-9a43-1f3c2b9e8d10".into(),
        role: Some("human".into()),
    };
    let block = a.blocks()[0].block_id.clone();
    pa.set_claim(Some(Claim::for_seconds(vec![block], 30.0)));
    // Ten seconds of it.
    let (mut bytes, mut sent, mut clock) = (0, 0, 0);
    while clock < 10_000 {
        a.set_selection(sent % 40 * 7, sent % 40 * 7 + 30);
        bytes += pa.publish(&a, &me).len();
        sent += 1;
        let gap = pa.gap_ms();
        assert!(gap >= 1000 / PRESENCE_MAX_HZ);
        clock += gap;
    }
    assert!(
        bytes / 10 < 2048,
        "{bytes} bytes in ten seconds ({sent} updates)"
    );

    // Without a claim and with a usual name: within 100 ms.
    pa.set_claim(None);
    let me = User {
        name: "Ana".into(),
        ..me
    };
    pa.publish(&a, &me);
    assert!(pa.gap_ms() <= 100, "{} ms", pa.gap_ms());
}
