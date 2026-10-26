//! Who else is here and where their caret is: the ephemeral store the TS app
//! shares beside the document (`EphemeralPayload` in `core/tools/presence.ts`).
//!
//! Each participant writes one entry under its Loro peer id:
//! `{ anchor, focus, user: { name, color, actorId, role }, claim }`, where
//! `anchor` and `focus` are encoded Loro cursors, so a caret stays on its
//! character while text moves under it, and `claim` is
//! `{ blockIds, until }` (an ISO time) while the participant is working on
//! those blocks. Entries are never in the document, its history or the saved
//! file, and expire when a participant stops sending them.

use std::cell::RefCell;

use loro::LoroValue;
use loro::awareness::EphemeralStore;
use serde::Serialize;

use crate::editing::Editor;

/// An entry not refreshed for this long is gone (`PRESENCE_TIMEOUT_MS`).
pub const PRESENCE_TIMEOUT_MS: i64 = 15_000;
/// How often a participant re-sends its entry while idle.
pub const PRESENCE_HEARTBEAT_MS: i64 = 5_000;
/// The most caret updates a participant sends a second (`PRESENCE_MAX_HZ`).
pub const PRESENCE_MAX_HZ: i64 = 20;
/// What one moving participant may send a second (AC-07.8 allows 2 KB).
/// An entry is about 200 bytes (cursors and names travel whole each time),
/// so this, not the 20 Hz cap, usually sets the pace: about 10 a second.
pub const PRESENCE_BYTES_PER_S: usize = 2000;
/// How long a claim lasts unless the claimer says otherwise, and at most.
pub const DEFAULT_CLAIM_SECONDS: f64 = 30.0;
pub const MAX_CLAIM_SECONDS: f64 = 120.0;

/// Blocks a participant is working on, until `until` (an ISO time).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Claim {
    pub block_ids: Vec<String>,
    pub until: String,
}

impl Claim {
    /// A claim on `block_ids` for `seconds` (1–120) from now.
    pub fn for_seconds(block_ids: Vec<String>, seconds: f64) -> Self {
        let seconds = seconds.clamp(1.0, MAX_CLAIM_SECONDS);
        Self {
            block_ids,
            until: iso_time(now_ms() + (seconds * 1000.0) as i64),
        }
    }

    /// Whether `until` is still ahead.
    pub fn is_live(&self) -> bool {
        parse_iso_time(&self.until).is_some_and(|until| until > now_ms())
    }
}

/// Where a participant's caret is, as agents see it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockCursor {
    pub block_id: String,
    pub offset: usize,
}

/// One participant, as `get_presence` reports them (`Presence`): `role`,
/// `name` and `color` only when they published them (AC-07.5).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Actor {
    pub actor_id: String,
    pub peer_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<BlockCursor>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claim: Option<Claim>,
}

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
    /// What they are working on, while the claim lasts.
    pub claim: Option<Claim>,
}

pub struct Presence {
    store: EphemeralStore,
    peer: String,
    /// When we last wrote our entry (ms since the epoch).
    last_write: std::cell::Cell<i64>,
    /// Ours, sent with every update until it runs out.
    claim: RefCell<Option<Claim>>,
    /// The size of our last update.
    last_size: std::cell::Cell<usize>,
}

impl Presence {
    pub fn new(editor: &Editor) -> Self {
        Self::with_timeout(editor, PRESENCE_TIMEOUT_MS)
    }

    /// Entries not refreshed for `timeout_ms` are dropped.
    pub fn with_timeout(editor: &Editor, timeout_ms: i64) -> Self {
        Self {
            store: EphemeralStore::new(timeout_ms),
            peer: editor.document().loro().peer_id().to_string(),
            last_write: Default::default(),
            claim: RefCell::new(None),
            last_size: Default::default(),
        }
    }

    /// How long to wait after an update before sending the next: at most
    /// [`PRESENCE_MAX_HZ`] a second and [`PRESENCE_BYTES_PER_S`] bytes.
    pub fn gap_ms(&self) -> i64 {
        let by_rate = 1000 / PRESENCE_MAX_HZ;
        let by_size = (self.last_size.get() * 1000).div_ceil(PRESENCE_BYTES_PER_S) as i64;
        by_rate.max(by_size)
    }

    /// Claims blocks (or, with `None`, gives them up); sent with the next
    /// [`Presence::publish`].
    pub fn set_claim(&self, claim: Option<Claim>) {
        *self.claim.borrow_mut() = claim.filter(Claim::is_live);
    }

    /// Our claim, while it lasts.
    pub fn claim(&self) -> Option<Claim> {
        self.claim.borrow().clone().filter(Claim::is_live)
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
        let mut payload = vec![
            ("anchor".to_owned(), cursor(anchor)),
            ("focus".to_owned(), cursor(head)),
            ("user".to_owned(), LoroValue::Map(who.into())),
        ];
        // Left out, not null, when there is none: every byte is sent 10×/s.
        if let Some(claim) = self.claim() {
            let claim = LoroValue::Map(
                vec![
                    (
                        "blockIds".to_owned(),
                        LoroValue::List(
                            claim
                                .block_ids
                                .into_iter()
                                .map(LoroValue::from)
                                .collect::<Vec<_>>()
                                .into(),
                        ),
                    ),
                    ("until".to_owned(), claim.until.into()),
                ]
                .into(),
            );
            payload.push(("claim".to_owned(), claim));
        }
        self.next_millisecond();
        self.store.set(&self.peer, LoroValue::Map(payload.into()));
        let update = self.store.encode(&self.peer);
        self.last_size.set(update.len());
        update
    }

    /// Removes our entry (closing the pane); returns the update to send.
    pub fn leave(&self) -> Vec<u8> {
        self.claim.replace(None);
        self.next_millisecond();
        self.store.delete(&self.peer);
        self.store.encode(&self.peer)
    }

    /// Receivers keep an entry unless the update's timestamp (milliseconds)
    /// is newer, so two writes in one millisecond would lose the second.
    /// UIs throttle well below that; this makes it hold regardless.
    fn next_millisecond(&self) {
        while now_ms() <= self.last_write.get() {
            std::thread::yield_now();
        }
        self.last_write.set(now_ms());
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
                    claim: state.get("claim").and_then(claim_of),
                })
            })
            .collect();
        carets.sort_by(|a, b| a.peer.cmp(&b.peer));
        carets
    }

    /// Everyone here, us included, as agents see them (`readPresence`):
    /// who they are as far as they said, where their caret is and what they
    /// claim. With `near`, only those at or claiming that block.
    pub fn actors(&self, editor: &Editor, near: Option<&str>) -> Vec<Actor> {
        self.store.remove_outdated();
        let mut actors: Vec<Actor> = self
            .store
            .get_all_states()
            .into_iter()
            .filter_map(|(peer, state)| {
                let LoroValue::Map(state) = state else {
                    return None;
                };
                let cursor = match state.get("focus") {
                    Some(LoroValue::Binary(bytes)) => editor
                        .offset_of_cursor(bytes)
                        .map(|global| editor.locate(global))
                        .map(|(index, offset)| BlockCursor {
                            block_id: editor.blocks()[index].block_id.clone(),
                            offset,
                        })
                        .filter(|c| !c.block_id.is_empty()),
                    _ => None,
                };
                let claim = state.get("claim").and_then(claim_of);
                if let Some(near) = near {
                    let at = cursor.as_ref().is_some_and(|c| c.block_id == near);
                    let claims = claim
                        .as_ref()
                        .is_some_and(|c| c.block_ids.iter().any(|b| b == near));
                    if !at && !claims {
                        return None;
                    }
                }
                let user = state.get("user").and_then(user_of);
                Some(Actor {
                    actor_id: user
                        .as_ref()
                        .map(|u| u.actor_id.clone())
                        .filter(|id| !id.is_empty())
                        .unwrap_or_else(|| peer.clone()),
                    peer_id: peer,
                    role: user.as_ref().and_then(|u| u.role.clone()),
                    name: user.as_ref().map(|u| u.name.clone()),
                    color: user.map(|u| u.color).filter(|c| !c.is_empty()),
                    cursor,
                    claim,
                })
            })
            .collect();
        actors.sort_by(|a, b| a.peer_id.cmp(&b.peer_id));
        actors
    }

    /// Who else is working on `block_id`, by name (`findClaim`).
    pub fn claimed_by(&self, block_id: &str) -> Option<String> {
        self.store.remove_outdated();
        self.store
            .get_all_states()
            .into_iter()
            .filter(|(peer, _)| *peer != self.peer)
            .find_map(|(peer, state)| {
                let LoroValue::Map(state) = state else {
                    return None;
                };
                let claim = state.get("claim").and_then(claim_of)?;
                if !claim.block_ids.iter().any(|b| b == block_id) {
                    return None;
                }
                Some(match state.get("user").and_then(user_of) {
                    Some(user) => user.name,
                    None => peer,
                })
            })
    }
}

/// A live claim; an expired one reads as none.
fn claim_of(value: &LoroValue) -> Option<Claim> {
    let LoroValue::Map(map) = value else {
        return None;
    };
    let Some(LoroValue::String(until)) = map.get("until") else {
        return None;
    };
    let block_ids = match map.get("blockIds") {
        Some(LoroValue::List(ids)) => ids
            .iter()
            .filter_map(|id| match id {
                LoroValue::String(s) => Some(s.to_string()),
                _ => None,
            })
            .collect(),
        _ => vec![],
    };
    Some(Claim {
        block_ids,
        until: until.to_string(),
    })
    .filter(Claim::is_live)
}

pub use crate::document::now_ms;

/// `new Date(ms).toISOString()`: `2026-10-26T09:30:00.000Z`.
pub fn iso_time(ms: i64) -> String {
    let (days, in_day) = (ms.div_euclid(86_400_000), ms.rem_euclid(86_400_000));
    // Civil from days (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        in_day / 3_600_000,
        in_day / 60_000 % 60,
        in_day / 1000 % 60,
        in_day % 1000
    )
}

/// Milliseconds since the epoch of a UTC ISO time as [`iso_time`] (and JS
/// `toISOString`) writes it; seconds' fraction optional.
pub fn parse_iso_time(text: &str) -> Option<i64> {
    let text = text.strip_suffix('Z')?;
    let (date, time) = text.split_once('T')?;
    let mut date = date.split('-').map(|p| p.parse::<i64>().ok());
    let (year, month, day) = (date.next()??, date.next()??, date.next()??);
    let (hms, fraction) = time.split_once('.').unwrap_or((time, "0"));
    let mut hms = hms.split(':').map(|p| p.parse::<i64>().ok());
    let (h, m, s) = (hms.next()??, hms.next()??, hms.next()??);
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || h > 23 || m > 59 || s > 60 {
        return None;
    }
    let ms = format!("{fraction:0<3}")[..3].parse::<i64>().ok()?;
    // Days from civil.
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(days * 86_400_000 + h * 3_600_000 + m * 60_000 + s * 1000 + ms)
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
