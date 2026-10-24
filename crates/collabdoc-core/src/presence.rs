//! Who else is here and where their caret is: the ephemeral store the TS app
//! shares beside the document (`EphemeralPayload` in `core/tools/presence.ts`).
//!
//! Each participant writes one entry under its Loro peer id:
//! `{ anchor, focus, user: { name, color, actorId, role } }`, where `anchor`
//! and `focus` are encoded Loro cursors, so a caret stays on its character
//! while text moves under it. Entries are never in the document, its history
//! or the saved file, and expire when a participant stops sending them.

use loro::LoroValue;
use loro::awareness::EphemeralStore;

use crate::editing::Editor;

/// An entry not refreshed for this long is gone (`PRESENCE_TIMEOUT_MS`).
pub const PRESENCE_TIMEOUT_MS: i64 = 15_000;
/// How often a participant re-sends its entry while idle.
pub const PRESENCE_HEARTBEAT_MS: i64 = 5_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct User {
    pub name: String,
    pub color: String,
    pub actor_id: String,
    /// `"human"` or `"agent"`; unknown when the peer did not say.
    pub role: Option<String>,
}

/// A collaborator's selection, in our editor's offsets.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Caret {
    pub peer: String,
    pub user: Option<User>,
    pub anchor: usize,
    pub head: usize,
    /// Changes when the participant moves their caret, not when text moves
    /// under it or they merely re-send it (a heartbeat).
    pub moved: u64,
}

pub struct Presence {
    store: EphemeralStore,
    peer: String,
    /// When we last wrote our entry (ms since the epoch).
    last_write: std::cell::Cell<u128>,
}

impl Presence {
    pub fn new(editor: &Editor) -> Self {
        Self {
            store: EphemeralStore::new(PRESENCE_TIMEOUT_MS),
            peer: editor.document().loro().peer_id().to_string(),
            last_write: Default::default(),
        }
    }

    pub fn peer(&self) -> &str {
        &self.peer
    }

    /// Writes our selection and identity; returns the update to send.
    pub fn publish(&self, editor: &Editor, user: &User) -> Vec<u8> {
        let (anchor, head) = (editor.anchor(), editor.head());
        let cursor = |offset| match editor.cursor_bytes(offset) {
            Some(bytes) => LoroValue::Binary(bytes.into()),
            None => LoroValue::Null,
        };
        let mut who = vec![
            ("name".to_owned(), user.name.clone().into()),
            ("color".to_owned(), user.color.clone().into()),
            ("actorId".to_owned(), user.actor_id.clone().into()),
        ];
        if let Some(role) = &user.role {
            who.push(("role".to_owned(), role.clone().into()));
        }
        let payload = vec![
            ("anchor".to_owned(), cursor(anchor)),
            ("focus".to_owned(), cursor(head)),
            ("user".to_owned(), LoroValue::Map(who.into())),
        ];
        self.next_millisecond();
        self.store.set(&self.peer, LoroValue::Map(payload.into()));
        self.store.encode(&self.peer)
    }

    /// Removes our entry (closing the pane); returns the update to send.
    pub fn leave(&self) -> Vec<u8> {
        self.next_millisecond();
        self.store.delete(&self.peer);
        self.store.encode(&self.peer)
    }

    /// Receivers keep an entry unless the update's timestamp (milliseconds)
    /// is newer, so two writes in one millisecond would lose the second.
    /// UIs throttle well below that; this makes it hold regardless.
    fn next_millisecond(&self) {
        let now = || {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or_default()
        };
        while now() <= self.last_write.get() {
            std::thread::yield_now();
        }
        self.last_write.set(now());
    }

    /// Takes in what others sent (one entry or a whole store).
    pub fn apply(&self, bytes: &[u8]) -> Result<(), String> {
        if bytes.is_empty() {
            return Ok(());
        }
        self.store.apply(bytes).map_err(|e| e.to_string())
    }

    /// Everyone else's caret that still points into the document, ordered by
    /// peer so they paint the same way every time.
    pub fn carets(&self, editor: &Editor) -> Vec<Caret> {
        self.store.remove_outdated();
        let mut carets: Vec<Caret> = self
            .store
            .get_all_states()
            .into_iter()
            .filter(|(peer, _)| *peer != self.peer)
            .filter_map(|(peer, state)| {
                let LoroValue::Map(state) = state else {
                    return None;
                };
                let at = |key: &str| match state.get(key) {
                    Some(LoroValue::Binary(bytes)) => editor.offset_of_cursor(bytes),
                    _ => None,
                };
                let head = at("focus")?;
                let anchor = at("anchor").unwrap_or(head);
                let mut hasher = std::collections::hash_map::DefaultHasher::new();
                for key in ["anchor", "focus"] {
                    if let Some(LoroValue::Binary(bytes)) = state.get(key) {
                        std::hash::Hash::hash(&bytes[..], &mut hasher);
                    }
                }
                Some(Caret {
                    peer,
                    user: state.get("user").and_then(user_of),
                    anchor,
                    head,
                    moved: std::hash::Hasher::finish(&hasher),
                })
            })
            .collect();
        carets.sort_by(|a, b| a.peer.cmp(&b.peer));
        carets
    }
}

fn user_of(value: &LoroValue) -> Option<User> {
    let LoroValue::Map(map) = value else {
        return None;
    };
    let text = |key: &str| match map.get(key) {
        Some(LoroValue::String(s)) => Some(s.to_string()),
        _ => None,
    };
    Some(User {
        name: text("name")?,
        color: text("color").unwrap_or_default(),
        actor_id: text("actorId").unwrap_or_default(),
        role: text("role"),
    })
}
