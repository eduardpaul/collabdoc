//! Who the user is and who else is in a document (spec 07): `@handle` rules
//! (`shared/handles.ts`), the colour palette (`shared/actors.ts`), the
//! profile kept in `profile.json` (`main/profile.ts`) and the participant
//! registry (`core/participants.ts`).
//!
//! Everything here answers the way the TS app does, so a handle or colour
//! one install derives is the one every other install derives too.

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::history::AuthorRecord;
use crate::ids::new_actor_id;

/// Palette for humans and agents (`USER_COLORS`).
pub const USER_COLORS: [&str; 8] = [
    "#c45c26", "#1f8a70", "#2563eb", "#7c3aed", "#db2777", "#d97706", "#0ea5e9", "#65a30d",
];

const HANDLE_MAX: usize = 20;
const NAME_MAX: usize = 40;

fn handle_char(c: char) -> bool {
    c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-'
}

/// `@Ana Lopez` → `ana-lopez`: lower case, no `@`, spaces to `-`, nothing
/// outside `[a-z0-9_-]`, at most 20 characters.
pub fn normalize_handle(raw: &str) -> String {
    let lower = raw.trim().to_lowercase();
    let mut out = String::new();
    let mut space = false;
    for c in lower.trim_start_matches('@').chars() {
        if c.is_whitespace() {
            space = true;
            continue;
        }
        if space {
            out.push('-');
            space = false;
        }
        if handle_char(c) {
            out.push(c);
        }
    }
    // Trimmed, so a run of spaces is never last.
    out.truncate(HANDLE_MAX);
    out
}

/// 2–20 of `[a-z0-9_-]`.
pub fn is_valid_handle(handle: &str) -> bool {
    (2..=HANDLE_MAX).contains(&handle.len()) && handle.chars().all(handle_char)
}

/// A valid handle derived from a display name; falls back to `you`.
pub fn handle_from_name(name: &str) -> String {
    let normalized = normalize_handle(name);
    if is_valid_handle(&normalized) {
        return normalized;
    }
    let mut padded = format!("{normalized}user");
    padded.truncate(HANDLE_MAX);
    if is_valid_handle(&padded) {
        padded
    } else {
        "you".into()
    }
}

/// `preferred`, or `preferred-2`, `-3`, … when it is taken.
pub fn uniquify_handle(preferred: &str, taken: &HashSet<String>) -> String {
    let base = if is_valid_handle(preferred) {
        preferred.to_owned()
    } else {
        handle_from_name(preferred)
    };
    if !taken.contains(&base) {
        return base;
    }
    for n in 2..1000 {
        let suffix = format!("-{n}");
        let next = format!(
            "{}{suffix}",
            &base[..base.len().min(HANDLE_MAX - suffix.len())]
        );
        if !taken.contains(&next) {
            return next;
        }
    }
    format!("{}-x", &base[..base.len().min(16)])
}

/// One person to give a handle to.
pub struct HandleClaim<'a> {
    pub id: &'a str,
    pub name: &'a str,
    pub handle: Option<&'a str>,
}

/// A unique handle for everyone. Input order is the collision order: the
/// first keeps the handle they want, later ones get `-2`, `-3`. Sort by id
/// first so every peer assigns the same suffixes.
pub fn assign_handles(people: &[HandleClaim]) -> HashMap<String, String> {
    let mut taken = HashSet::new();
    let mut assigned = HashMap::new();
    for person in people {
        let preferred = match person.handle {
            Some(h) if is_valid_handle(h) => h.to_owned(),
            _ => handle_from_name(person.name),
        };
        let handle = uniquify_handle(&preferred, &taken);
        taken.insert(handle.clone());
        assigned.insert(person.id.to_owned(), handle);
    }
    assigned
}

/// Handles mentioned in free text, lower-cased, without the `@`, in order,
/// each once. A handle starts after a non-handle character and is 2–20
/// handle characters long.
pub fn mentioned_handles(text: &str) -> Vec<String> {
    let word = |c: char| c.is_ascii_alphanumeric() || c == '_' || c == '-';
    let chars: Vec<char> = text.chars().collect();
    let mut out: Vec<String> = Vec::new();
    for (i, &c) in chars.iter().enumerate() {
        if c != '@' || (i > 0 && word(chars[i - 1])) {
            continue;
        }
        let run: String = chars[i + 1..].iter().take_while(|&&c| word(c)).collect();
        if (2..=HANDLE_MAX).contains(&run.len()) {
            let handle = run.to_ascii_lowercase();
            if !out.contains(&handle) {
                out.push(handle);
            }
        }
    }
    out
}

/// A stable colour for an id (`colorForId`): the TS hash over UTF-16 units.
pub fn color_for_id(id: &str) -> &'static str {
    let hash = id
        .encode_utf16()
        .fold(0u32, |h, unit| h.wrapping_mul(31).wrapping_add(unit as u32));
    USER_COLORS[hash as usize % USER_COLORS.len()]
}

/// The first `max` UTF-16 units of `s` (JS `slice(0, max)`), never splitting
/// a character.
fn slice_utf16(s: &str, max: usize) -> &str {
    let mut units = 0;
    for (i, c) in s.char_indices() {
        units += c.len_utf16();
        if units > max {
            return &s[..i];
        }
    }
    s
}

/// The order JS `a.localeCompare(b)` gives ids, so registries sort the same
/// in both apps: punctuation, then digits, then letters ignoring case; then
/// lower case before upper at the first difference.
pub fn locale_compare(a: &str, b: &str) -> Ordering {
    const ORDER: &str = "_-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$0123456789abcdefghijklmnopqrstuvwxyz";
    let primary = |c: char| match ORDER.find(c.to_ascii_lowercase()) {
        Some(i) => i as u32,
        None => 0x100 + c as u32,
    };
    let key = |s: &str| s.chars().map(primary).collect::<Vec<_>>();
    let case = |s: &str| {
        s.chars()
            .map(|c| c.is_ascii_uppercase())
            .collect::<Vec<_>>()
    };
    key(a)
        .cmp(&key(b))
        .then_with(|| case(a).cmp(&case(b)))
        .then_with(|| a.cmp(b))
}

/// The profile in `<userData>/profile.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    /// The user's actor id in every document.
    pub user_id: String,
    pub name: String,
    pub handle: String,
    pub color: String,
    /// False until the user has been asked for their name.
    pub setup_complete: bool,
}

impl Default for Profile {
    fn default() -> Self {
        Self {
            user_id: new_actor_id(),
            name: "You".into(),
            handle: "you".into(),
            color: USER_COLORS[0].into(),
            setup_complete: false,
        }
    }
}

impl Profile {
    /// What a stored (or proposed) profile is once tidied: a name of 1–40
    /// characters (else `You`), a valid handle (else one from the name), a
    /// `#` colour.
    pub fn sanitize(raw: &Value) -> Self {
        let fallback = Self::default();
        let Value::Object(rec) = raw else {
            return fallback;
        };
        let text = |key: &str| rec.get(key).and_then(Value::as_str);
        let name = match text("name").map(str::trim).filter(|n| !n.is_empty()) {
            // Trimmed again, so reading a stored name back gives the same name.
            Some(n) => slice_utf16(n, NAME_MAX).trim_end().to_owned(),
            None => fallback.name,
        };
        let handle = text("handle")
            .filter(|h| is_valid_handle(h))
            .map(str::to_owned)
            .unwrap_or_else(|| handle_from_name(&name));
        Self {
            user_id: text("userId")
                .filter(|id| !id.is_empty())
                .map(str::to_owned)
                .unwrap_or(fallback.user_id),
            name,
            handle,
            color: text("color")
                .filter(|c| c.starts_with('#'))
                .map(str::to_owned)
                .unwrap_or(fallback.color),
            setup_complete: rec.get("setupComplete") == Some(&Value::Bool(true)),
        }
    }

    pub fn path(user_data: &Path) -> PathBuf {
        user_data.join("profile.json")
    }

    /// The stored profile. The first time there is none, a new one is
    /// stored and returned with `setup_complete` false, so the first launch
    /// asks for a name and later ones do not (as the TS app does).
    pub fn load(user_data: &Path) -> Self {
        let stored = std::fs::read_to_string(Self::path(user_data))
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok());
        match stored {
            Some(raw) => Self::sanitize(&raw),
            None => {
                let created = Self::default();
                // Without a writable folder the profile lives for this run.
                let _ = created.save(user_data);
                created
            }
        }
    }

    /// Stores the profile (sanitized, set up) and returns what was stored.
    pub fn save(&self, user_data: &Path) -> std::io::Result<Self> {
        let mut value = serde_json::to_value(self).expect("a profile serializes");
        value["setupComplete"] = Value::Bool(true);
        let next = Self::sanitize(&value);
        let file = Self::path(user_data);
        std::fs::create_dir_all(user_data)?;
        let text = serde_json::to_string_pretty(&next).expect("a profile serializes");
        crate::store::atomic_write(&file, text.as_bytes())?;
        Ok(next)
    }

    /// This user as a document author.
    pub fn author(&self) -> AuthorRecord {
        AuthorRecord {
            actor_id: self.user_id.clone(),
            name: self.name.clone(),
            color: self.color.clone(),
            role: "human".into(),
            handle: Some(self.handle.clone()),
        }
    }
}

/// An agent asked into the document.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Invited {
    pub id: String,
    pub name: String,
    pub color: Option<String>,
    pub role: Option<String>,
}

/// Someone addressable in the document (`RegistryPerson`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Person {
    pub id: String,
    pub handle: String,
    pub name: String,
    pub color: String,
    pub role: String,
    pub online: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Registry {
    pub people: Vec<Person>,
    pub local_handle: String,
    /// The local user's handle was taken by someone with an earlier id.
    pub handle_changed: bool,
}

/// Everyone addressable in the document: its authors (online or not), the
/// local user and invited agents. Handles are unique and assigned in id
/// order, so every peer computes the same suffixes (AC-07.9).
pub fn participant_registry(
    local: &AuthorRecord,
    authors: &[AuthorRecord],
    invited: &[Invited],
    online: &HashSet<String>,
) -> Registry {
    struct Entry {
        name: String,
        color: String,
        role: String,
        handle: Option<String>,
    }
    let mut by_id: HashMap<String, Entry> = HashMap::new();
    let mut add = |id: &str, person: Entry| match by_id.get_mut(id) {
        None => {
            by_id.insert(id.to_owned(), person);
        }
        Some(existing) => {
            if !person.name.is_empty() {
                existing.name = person.name;
            }
            if !person.color.is_empty() {
                existing.color = person.color;
            }
            if person.handle.is_some() {
                existing.handle = person.handle;
            }
            existing.role = person.role;
        }
    };
    for author in std::iter::once(local).chain(authors) {
        add(
            &author.actor_id,
            Entry {
                name: author.name.clone(),
                color: author.color.clone(),
                role: author.role.clone(),
                handle: author.handle.clone(),
            },
        );
    }
    for agent in invited {
        add(
            &agent.id,
            Entry {
                name: agent.name.clone(),
                color: agent
                    .color
                    .clone()
                    .unwrap_or_else(|| color_for_id(&agent.id).into()),
                role: agent.role.clone().unwrap_or_else(|| "agent".into()),
                handle: Some(handle_from_name(&agent.name)),
            },
        );
    }

    let mut ordered: Vec<(String, Entry)> = by_id.into_iter().collect();
    ordered.sort_by(|a, b| locale_compare(&a.0, &b.0));
    let claims: Vec<HandleClaim> = ordered
        .iter()
        .map(|(id, p)| HandleClaim {
            id,
            name: &p.name,
            handle: p.handle.as_deref(),
        })
        .collect();
    let handles = assign_handles(&claims);
    let people = ordered
        .iter()
        .map(|(id, p)| Person {
            id: id.clone(),
            handle: handles
                .get(id)
                .cloned()
                .unwrap_or_else(|| handle_from_name(&p.name)),
            name: p.name.clone(),
            color: p.color.clone(),
            role: p.role.clone(),
            online: online.contains(id),
        })
        .collect();
    let local_handle = handles
        .get(&local.actor_id)
        .cloned()
        .unwrap_or_else(|| handle_from_name(&local.name));
    let preferred = match local.handle.as_deref() {
        Some(h) if !h.is_empty() => h.to_owned(),
        _ => handle_from_name(&local.name),
    };
    Registry {
        handle_changed: local_handle != preferred,
        people,
        local_handle,
    }
}

/// Where someone's caret is, for the session list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Whereabouts {
    pub actor_id: String,
    pub block_id: Option<String>,
}

/// A row of the "In this session" list (`SessionRow`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRow {
    #[serde(flatten)]
    pub person: Person,
    /// `idle`, `working` or `typing in <block>`.
    pub status: String,
    /// `you`, `agent` or `peer`.
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor_block_id: Option<String>,
}

/// The local user, everyone online and invited agents, each with what they
/// are doing (AC-07.4).
pub fn session_rows(
    people: &[Person],
    local_id: &str,
    presence: &[Whereabouts],
    working: &HashSet<String>,
    block_label: impl Fn(&str) -> String,
) -> Vec<SessionRow> {
    people
        .iter()
        .filter(|p| p.online || p.id == local_id || p.role == "agent")
        .map(|person| {
            let typing = presence
                .iter()
                .find(|w| w.actor_id == person.id)
                .and_then(|w| w.block_id.clone());
            let status = if working.contains(&person.id) {
                "working".to_owned()
            } else if let Some(block) = &typing {
                format!("typing in {}", block_label(block))
            } else {
                "idle".to_owned()
            };
            let kind = if person.id == local_id {
                "you"
            } else if person.role == "agent" {
                "agent"
            } else {
                "peer"
            };
            let mut person = person.clone();
            person.online = person.online || person.id == local_id;
            SessionRow {
                person,
                status,
                kind: kind.into(),
                cursor_block_id: typing,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handles_follow_the_ts_rules() {
        assert_eq!(normalize_handle("  @@Ana  María Lopez! "), "ana-mara-lopez");
        assert_eq!(normalize_handle("A_b-C"), "a_b-c");
        assert_eq!(normalize_handle(&"x".repeat(30)).len(), 20);
        assert!(is_valid_handle("ab"));
        assert!(!is_valid_handle("a"));
        assert!(!is_valid_handle("Ab"));
        assert!(!is_valid_handle(&"a".repeat(21)));
        assert_eq!(handle_from_name("Ana"), "ana");
        assert_eq!(handle_from_name("A"), "auser");
        assert_eq!(handle_from_name("名前"), "user");
        assert_eq!(handle_from_name(""), "user");
        let taken: HashSet<String> = ["ana", "ana-2"].map(String::from).into();
        assert_eq!(uniquify_handle("ana", &taken), "ana-3");
        let long = "a".repeat(20);
        let taken: HashSet<String> = [long.clone()].into();
        assert_eq!(
            uniquify_handle(&long, &taken),
            format!("{}-2", "a".repeat(18))
        );
        assert_eq!(
            mentioned_handles(
                "hi @Ana and @bob, mail a@b.c, @ana again @x @toolong_handle_over_twenty"
            ),
            ["ana", "bob"]
        );
    }

    #[test]
    fn colors_hash_like_the_ts_app() {
        // `colorForId` in Node: 'a' → 97 % 8 = 1; 'agent_writer' → 5.
        assert_eq!(color_for_id("a"), USER_COLORS[1]);
        assert_eq!(color_for_id(""), USER_COLORS[0]);
        assert_eq!(color_for_id("agent_writer"), USER_COLORS[5]);
    }

    #[test]
    fn ids_sort_like_locale_compare() {
        let mut ids = vec![
            "b-id",
            "agentx",
            "agent-writer",
            "Agent",
            "agent_writer",
            "a-id",
        ];
        ids.sort_by(|a, b| locale_compare(a, b));
        assert_eq!(
            ids,
            [
                "a-id",
                "Agent",
                "agent_writer",
                "agent-writer",
                "agentx",
                "b-id"
            ]
        );
        let mut words = vec!["ab-", "AB", "Ab", "aB", "ab", "a0", "a-b", "a_b", "a"];
        words.sort_by(|a, b| locale_compare(a, b));
        assert_eq!(
            words,
            ["a", "a_b", "a-b", "a0", "ab", "aB", "Ab", "AB", "ab-"]
        );
    }

    #[test]
    fn a_profile_is_sanitized_stored_and_read_back() {
        let dir = std::env::temp_dir().join(format!("cd-profile-{}", new_actor_id()));
        let first = Profile::load(&dir);
        assert!(!first.setup_complete, "the first launch asks for a name");
        assert_eq!((first.name.as_str(), first.handle.as_str()), ("You", "you"));
        let again = Profile::load(&dir);
        assert_eq!(again.user_id, first.user_id);
        assert!(again.setup_complete, "later launches do not ask");

        let edited = Profile {
            name: format!("  {}  ", "Ana ".repeat(20)),
            handle: "Not Valid".into(),
            color: "red".into(),
            ..again
        };
        let saved = edited.save(&dir).unwrap();
        assert_eq!(saved.name.chars().count(), 39);
        assert_eq!(saved.handle, "ana-ana-ana-ana-ana-");
        assert_eq!(saved.color, USER_COLORS[0]);
        assert_eq!(Profile::load(&dir), saved);
        assert_eq!(
            saved.author().handle.as_deref(),
            Some(saved.handle.as_str())
        );

        let junk = Profile::sanitize(&serde_json::json!({"name": "  ", "userId": 4}));
        assert_eq!(junk.name, "You");
        assert_eq!(junk.user_id.len(), 36);
        std::fs::remove_dir_all(dir).unwrap();
    }

    fn author(id: &str, name: &str, handle: Option<&str>) -> AuthorRecord {
        AuthorRecord {
            actor_id: id.into(),
            name: name.into(),
            color: "#111".into(),
            role: "human".into(),
            handle: handle.map(str::to_owned),
        }
    }

    // `participants.test.ts`.
    #[test]
    fn registry_suffixes_are_the_same_on_every_peer() {
        let local = author("b-id", "Bob", Some("ana"));
        let authors = [author("a-id", "Ann", Some("ana")), local.clone()];
        let invited = [Invited {
            id: "agent_writer".into(),
            name: "Writer".into(),
            ..Default::default()
        }];
        let online: HashSet<String> = ["b-id".to_owned()].into();
        let host = participant_registry(&local, &authors, &invited, &online);
        let mut reversed = authors.clone();
        reversed.reverse();
        let guest = participant_registry(&local, &reversed, &invited, &online);
        assert_eq!(host, guest);
        let by = |id: &str| host.people.iter().find(|p| p.id == id).unwrap();
        assert_eq!(by("a-id").handle, "ana");
        assert_eq!(by("b-id").handle, "ana-2");
        assert_eq!(by("agent_writer").handle, "writer");
        assert_eq!(by("agent_writer").role, "agent");
        assert!(host.handle_changed);
        assert_eq!(host.local_handle, "ana-2");
        assert!(!by("a-id").online, "offline authors are listed");
    }

    #[test]
    fn session_rows_have_you_agents_and_what_they_do() {
        let local = author("me", "You", Some("you"));
        let invited = [Invited {
            id: "agent_writer".into(),
            name: "Writer".into(),
            ..Default::default()
        }];
        let online: HashSet<String> = ["me".to_owned()].into();
        let registry =
            participant_registry(&local, &[author("gone", "Old", None)], &invited, &online);
        let presence = [Whereabouts {
            actor_id: "me".into(),
            block_id: Some("b_aaa".into()),
        }];
        let rows = session_rows(&registry.people, "me", &presence, &HashSet::new(), |_| {
            "¶1".into()
        });
        let ids: Vec<&str> = rows.iter().map(|r| r.person.id.as_str()).collect();
        assert_eq!(ids, ["agent_writer", "me"]);
        assert_eq!(rows[1].status, "typing in ¶1");
        assert_eq!(rows[1].kind, "you");
        assert_eq!(rows[0].status, "idle");
        assert_eq!(rows[0].kind, "agent");
        let working: HashSet<String> = ["agent_writer".to_owned()].into();
        let rows = session_rows(&registry.people, "me", &[], &working, |_| String::new());
        assert_eq!(rows[0].status, "working");
        assert_eq!(rows[1].status, "idle");
    }
}
