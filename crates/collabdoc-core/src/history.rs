//! History and attribution (spec 05), ported from `src/core/history.ts`,
//! `history-index.ts`, `history-diff.ts`, `checkpoints.ts` and `authors.ts`.
//!
//! Every Loro change is a history entry, attributed through the document's
//! `authors` map (peer id → `{actorId, name, color, role, handle?}`) and
//! described from its ops in the same words as the TS app, so both apps show
//! the same history for the same file. Peers that never identified
//! themselves are reported as unknown rather than guessed.

use std::collections::{HashMap, HashSet};

use loro::{
    CommitOptions, ContainerTrait, Frontiers, ID, IdSpan, LoroDoc, LoroList, LoroMap, LoroValue,
    ValueOrContainer,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::document::now_ms;
use crate::schema::*;
use crate::tree;

pub const AUTHORS_KEY: &str = "authors";
pub const COMMENTS_KEY: &str = "comments";
pub const CHECKPOINTS_KEY: &str = "checkpoints";
pub const AUTHOR_ORIGIN: &str = "sys:author";
pub const CHECKPOINT_ORIGIN: &str = "sys:checkpoint";
/// Diffs kept per index (`HISTORY_DIFF_CACHE`).
pub const HISTORY_DIFF_CACHE: usize = 32;
const UNKNOWN_COLOR: &str = "#8a7d6d";

// ── Authors ─────────────────────────────────────────────────────────────

/// A participant as the `authors` map stores it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorRecord {
    pub actor_id: String,
    pub name: String,
    pub color: String,
    /// `human` or `agent`.
    pub role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub handle: Option<String>,
}

/// An author as history sees it: `role` is `None` for a peer that never
/// identified itself.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryAuthor {
    pub actor_id: String,
    pub name: String,
    pub color: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
}

impl From<&AuthorRecord> for HistoryAuthor {
    fn from(a: &AuthorRecord) -> Self {
        Self {
            actor_id: a.actor_id.clone(),
            name: a.name.clone(),
            color: a.color.clone(),
            role: Some(a.role.clone()),
        }
    }
}

/// Never guess "human" for a peer that did not identify itself.
pub fn unknown_author(peer: &str) -> HistoryAuthor {
    HistoryAuthor {
        actor_id: peer.to_owned(),
        name: format!("Unknown peer {}", peer.chars().take(6).collect::<String>()),
        color: UNKNOWN_COLOR.to_owned(),
        role: None,
    }
}

/// Writes this peer's record (no commit).
pub fn write_author(doc: &LoroDoc, author: &AuthorRecord) {
    let mut fields: HashMap<String, LoroValue> = HashMap::new();
    fields.insert("actorId".into(), author.actor_id.as_str().into());
    fields.insert("name".into(), author.name.as_str().into());
    fields.insert("color".into(), author.color.as_str().into());
    fields.insert("role".into(), author.role.as_str().into());
    if let Some(handle) = &author.handle {
        fields.insert("handle".into(), handle.as_str().into());
    }
    doc.get_map(AUTHORS_KEY)
        .insert(&doc.peer_id().to_string(), LoroValue::from(fields))
        .expect("write author");
}

pub fn is_author_registered(doc: &LoroDoc) -> bool {
    doc.get_map(AUTHORS_KEY)
        .get(&doc.peer_id().to_string())
        .is_some()
}

/// Puts this peer in the `authors` map before its first real commit, as its
/// own `sys:author` commit (which undo never removes and history hides).
/// Ops written now would otherwise ride in the next commit.
pub fn ensure_author(doc: &LoroDoc, author: &AuthorRecord) -> bool {
    if is_author_registered(doc) {
        return false;
    }
    write_author(doc, author);
    doc.commit_with(
        CommitOptions::new()
            .origin(AUTHOR_ORIGIN)
            .timestamp(now_ms()),
    );
    true
}

pub fn read_authors(doc: &LoroDoc) -> HashMap<String, AuthorRecord> {
    let LoroValue::Map(map) = doc.get_map(AUTHORS_KEY).get_deep_value() else {
        return HashMap::new();
    };
    map.iter()
        .filter_map(|(peer, value)| as_author(value, peer).map(|a| (peer.to_string(), a)))
        .collect()
}

pub fn author_for_peer(doc: &LoroDoc, peer: &str) -> HistoryAuthor {
    read_authors(doc)
        .get(peer)
        .map(HistoryAuthor::from)
        .unwrap_or_else(|| unknown_author(peer))
}

fn as_author(value: &LoroValue, peer: &str) -> Option<AuthorRecord> {
    let LoroValue::Map(rec) = value else {
        return None;
    };
    let text = |key: &str| match rec.get(key) {
        Some(LoroValue::String(s)) => Some(s.to_string()),
        _ => None,
    };
    Some(AuthorRecord {
        name: text("name")?,
        actor_id: text("actorId").unwrap_or_else(|| peer.to_owned()),
        color: text("color").unwrap_or_else(|| UNKNOWN_COLOR.to_owned()),
        role: if text("role").as_deref() == Some("agent") {
            "agent".into()
        } else {
            "human".into()
        },
        handle: text("handle"),
    })
}

// ── Entries ─────────────────────────────────────────────────────────────

/// A version: one op id per peer, as Loro frontiers (`{peer, counter}` in
/// the TS app, the peer a decimal string).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Frontier {
    #[serde(with = "peer_string")]
    pub peer: u64,
    pub counter: i32,
}

mod peer_string {
    use serde::{Deserialize, Deserializer, Serializer, de::Error};

    pub fn serialize<S: Serializer>(peer: &u64, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&peer.to_string())
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<u64, D::Error> {
        let raw = serde_json::Value::deserialize(d)?;
        match raw {
            serde_json::Value::String(s) => s.parse().map_err(D::Error::custom),
            serde_json::Value::Number(n) => n.as_u64().ok_or_else(|| D::Error::custom("peer")),
            _ => Err(D::Error::custom("peer")),
        }
    }
}

pub fn to_frontiers(list: &[Frontier]) -> Frontiers {
    list.iter()
        .map(|f| ID::new(f.peer, f.counter))
        .collect::<Vec<_>>()
        .into()
}

pub fn from_frontiers(frontiers: &Frontiers) -> Vec<Frontier> {
    frontiers
        .iter()
        .map(|id| Frontier {
            peer: id.peer,
            counter: id.counter,
        })
        .collect()
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    /// `counter@peer` of the change's first op.
    pub id: String,
    pub peer: String,
    pub counter: i32,
    pub length: usize,
    pub lamport: u32,
    /// Milliseconds since the epoch.
    pub timestamp: i64,
    pub message: String,
    pub summary: String,
    pub details: Vec<String>,
    pub added: usize,
    pub removed: usize,
    pub author: HistoryAuthor,
    /// The version right after the change, and right before it.
    pub frontiers: Vec<Frontier>,
    pub parent_frontiers: Vec<Frontier>,
    pub block_ids: Vec<String>,
}

/// What a description needs about the document, read once per refresh.
pub struct Context {
    authors: HashMap<String, AuthorRecord>,
    comments: HashSet<String>,
    containers: HashMap<String, String>,
}

impl Context {
    pub fn read(doc: &LoroDoc) -> Self {
        Self {
            authors: read_authors(doc),
            comments: comment_container_ids(doc),
            containers: container_to_block_id(doc),
        }
    }
}

/// Every change in the document, oldest first.
pub fn list_history(doc: &LoroDoc) -> Vec<HistoryEntry> {
    let cx = Context::read(doc);
    let mut entries = Vec::new();
    for (peer, end) in doc.oplog_vv().iter() {
        let mut counter = 0;
        while counter < *end {
            let Some(change) = doc.get_change(ID::new(*peer, counter)) else {
                break;
            };
            if let Some(entry) = entry_from_change(doc, &change, &cx) {
                entries.push(entry);
            }
            counter = change.id.counter + change.len.max(1) as i32;
        }
    }
    entries.sort_by(compare_history);
    entries
}

pub fn entry_from_change(
    doc: &LoroDoc,
    change: &loro::ChangeMeta,
    cx: &Context,
) -> Option<HistoryEntry> {
    let peer = change.id.peer.to_string();
    let described = describe_change(doc, change.id, change.len, cx);
    let message = change.message.as_deref().unwrap_or("").to_owned();
    if described.details.is_empty() && message.is_empty() {
        return None;
    }
    let author = cx
        .authors
        .get(&peer)
        .map(HistoryAuthor::from)
        .unwrap_or_else(|| unknown_author(&peer));
    let last = change.id.counter + change.len.max(1) as i32 - 1;
    Some(HistoryEntry {
        id: format!("{}@{peer}", change.id.counter),
        counter: change.id.counter,
        length: change.len,
        lamport: change.lamport,
        timestamp: normalize_timestamp(change.timestamp),
        summary: summarize(
            &described.details,
            described.added,
            described.removed,
            &message,
        ),
        message,
        details: described.details,
        added: described.added,
        removed: described.removed,
        author,
        frontiers: vec![Frontier {
            peer: change.id.peer,
            counter: last,
        }],
        parent_frontiers: from_frontiers(&change.deps),
        block_ids: described.block_ids,
        peer,
    })
}

pub fn compare_history(a: &HistoryEntry, b: &HistoryEntry) -> std::cmp::Ordering {
    a.timestamp
        .cmp(&b.timestamp)
        .then(a.lamport.cmp(&b.lamport))
        .then_with(|| a.peer.cmp(&b.peer))
}

pub fn comment_container_ids(doc: &LoroDoc) -> HashSet<String> {
    let mut ids = HashSet::new();
    let root = doc.get_map(COMMENTS_KEY);
    ids.insert(root.id().to_string());
    for key in root.keys() {
        if let Some(ValueOrContainer::Container(loro::Container::Map(thread))) = root.get(&key) {
            ids.insert(thread.id().to_string());
            if let Some(ValueOrContainer::Container(loro::Container::List(replies))) =
                thread.get("replies")
            {
                ids.insert(replies.id().to_string());
            }
        }
    }
    ids
}

/// Every live container of a block (node, attributes, children, text runs)
/// to its `blockId`.
pub fn container_to_block_id(doc: &LoroDoc) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let mut stack = vec![tree::root(doc)];
    while let Some(node) = stack.pop() {
        for child in tree::child_maps(&node) {
            let id = tree::block_id(&child);
            if !id.is_empty() {
                map.insert(child.id().to_string(), id.clone());
                map.insert(tree::attrs(&child).id().to_string(), id.clone());
                map.insert(tree::children(&child).id().to_string(), id.clone());
                for placed in tree::segments(&child) {
                    if let tree::Segment::Text(t) = placed.segment {
                        map.insert(t.id().to_string(), id.clone());
                    }
                }
            }
            if is_container_type(&tree::node_name(&child)) {
                stack.push(child);
            }
        }
    }
    map
}

/// Entries by one author and/or matching a search.
pub fn filter_history<'a>(
    entries: &'a [HistoryEntry],
    actor_id: Option<&str>,
    query: &str,
) -> Vec<&'a HistoryEntry> {
    let query = query.trim().to_lowercase();
    entries
        .iter()
        .filter(|e| actor_id.is_none_or(|a| e.author.actor_id == a))
        .filter(|e| {
            query.is_empty()
                || e.summary.to_lowercase().contains(&query)
                || e.message.to_lowercase().contains(&query)
                || e.author.name.to_lowercase().contains(&query)
        })
        .collect()
}

pub fn author_counts(entries: &[HistoryEntry]) -> HashMap<String, usize> {
    let mut counts = HashMap::new();
    for e in entries {
        *counts.entry(e.author.actor_id.clone()).or_default() += 1;
    }
    counts
}

struct Described {
    details: Vec<String>,
    added: usize,
    removed: usize,
    block_ids: Vec<String>,
}

fn describe_change(doc: &LoroDoc, id: ID, len: usize, cx: &Context) -> Described {
    let changes = doc.export_json_in_id_span(IdSpan::new(
        id.peer,
        id.counter,
        id.counter + len.max(1) as i32,
    ));
    let mut lines: Vec<String> = Vec::new();
    let mut block_ids: Vec<String> = Vec::new();
    let (mut added, mut removed) = (0usize, 0usize);
    let push = |lines: &mut Vec<String>, line: Option<String>| {
        if let Some(line) = line
            && !lines.contains(&line)
        {
            lines.push(line);
        }
    };
    for change in changes {
        let Ok(json) = serde_json::to_value(&change) else {
            continue;
        };
        for op in json["ops"].as_array().into_iter().flatten() {
            let container = op["container"].as_str().unwrap_or("");
            let content = &op["content"];
            if let Some(block) = cx.containers.get(container)
                && !block_ids.contains(block)
            {
                block_ids.push(block.clone());
            }
            if container.contains(AUTHORS_KEY) {
                continue;
            }
            if container.contains(META_KEY) {
                push(&mut lines, describe_meta_op(content));
                continue;
            }
            if cx.comments.contains(container) {
                push(&mut lines, describe_comment_op(content));
                continue;
            }
            let is_text = container.ends_with(":Text");
            let kind = content["type"].as_str().unwrap_or("");
            if kind == "insert"
                && let Some(text) = content["text"].as_str()
            {
                added += crate::utf16::len(text);
            }
            if kind == "insert"
                && content["key"] == "source"
                && let Some(value) = content["value"].as_str()
            {
                added += crate::utf16::len(value);
            }
            if is_text
                && kind == "delete"
                && let Some(n) = content["len"].as_i64()
            {
                removed += n.unsigned_abs() as usize;
            }
            push(&mut lines, describe_op(content, is_text));
        }
    }
    lines.truncate(6);
    Described {
        details: lines,
        added,
        removed,
        block_ids,
    }
}

fn summarize(details: &[String], added: usize, removed: usize, message: &str) -> String {
    let stat = format_stat(added, removed);
    let first = details
        .first()
        .map(String::as_str)
        .unwrap_or(if message.is_empty() {
            "edited the document"
        } else {
            message
        });
    if stat.is_empty() {
        first.to_owned()
    } else {
        format!("{stat}  {first}")
    }
}

pub fn format_stat(added: usize, removed: usize) -> String {
    let mut parts = Vec::new();
    if added > 0 {
        parts.push(format!("+{added}"));
    }
    if removed > 0 {
        parts.push(format!("−{removed}"));
    }
    parts.join(" ")
}

fn describe_meta_op(content: &Value) -> Option<String> {
    (content["type"] == "insert" && content["key"] == "title")
        .then(|| content["value"].as_str())
        .flatten()
        .map(|v| format!("set the title to “{}”", clip(v, 72)))
}

fn describe_comment_op(content: &Value) -> Option<String> {
    if content["type"] != "insert" {
        return None;
    }
    if content["key"] == "body"
        && let Some(body) = content["value"].as_str()
    {
        return Some(if body.is_empty() {
            "deleted a comment".into()
        } else {
            format!("commented “{}”", clip(&collapse(body), 72))
        });
    }
    if content["key"] == "status" {
        return Some(if content["value"] == "resolved" {
            "resolved a thread".into()
        } else {
            "reopened a thread".into()
        });
    }
    if content["pos"].is_number() {
        // A reply: a map value with a body.
        let value = &content["value"];
        let body = value["body"]
            .as_str()
            .or_else(|| value.as_array().and_then(|a| a.first()?["body"].as_str()));
        return body
            .filter(|b| !b.is_empty())
            .map(|b| format!("replied “{}”", clip(&collapse(b), 72)));
    }
    None
}

fn describe_op(content: &Value, is_text: bool) -> Option<String> {
    let kind = content["type"].as_str().unwrap_or("");
    if kind == "insert"
        && let Some(text) = content["text"].as_str()
    {
        let text = collapse(text);
        return (!text.is_empty()).then(|| format!("inserted “{}”", clip(&text, 72)));
    }
    if kind == "delete"
        && let (Some(n), true) = (content["len"].as_i64(), content["pos"].is_number())
    {
        let n = n.unsigned_abs();
        let s = if n == 1 { "" } else { "s" };
        return Some(if is_text {
            format!("deleted {n} character{s}")
        } else {
            format!("removed {n} block{s}")
        });
    }
    if kind == "mark"
        && let Some(key) = content["style_key"].as_str()
    {
        return Some(if content["style_value"].is_null() {
            format!("removed {key}")
        } else {
            format!("applied {key}")
        });
    }
    if kind == "insert"
        && content["key"] == NODE_NAME_KEY
        && let Some(name) = content["value"].as_str()
    {
        return Some(match name {
            "mermaidFigure" => "added a Mermaid diagram".into(),
            "infographicFigure" => "added an Infographic".into(),
            "imageFigure" => "added an image".into(),
            other => format!("added {other}"),
        });
    }
    if kind == "insert"
        && content["key"] == "source"
        && let Some(source) = content["value"].as_str()
    {
        let text = collapse(source);
        return Some(if text.is_empty() {
            "updated diagram source".into()
        } else {
            format!("updated diagram “{}”", clip(&text, 72))
        });
    }
    if kind == "insert"
        && content["pos"].is_number()
        && content["value"]
            .as_str()
            .is_some_and(|v| v.starts_with("🦜:") || v.starts_with("cid:"))
    {
        return Some("added a block".into());
    }
    None
}

/// Loro records seconds unless a commit says otherwise; ours say ms.
fn normalize_timestamp(value: i64) -> i64 {
    if value == 0 {
        0
    } else if value > 1_000_000_000_000 {
        value
    } else {
        value * 1000
    }
}

fn collapse(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// At most `max` UTF-16 units, with an ellipsis when cut (`clip`).
fn clip(text: &str, max: usize) -> String {
    let units: Vec<u16> = text.encode_utf16().collect();
    if units.len() <= max {
        return text.to_owned();
    }
    let head = crate::utf16::from_utf8(text, crate::utf16::to_utf8(text, max - 1));
    format!("{}…", String::from_utf16_lossy(&units[..head]))
}

// ── Versions: previews and diffs ────────────────────────────────────────

/// A top-level block as a version shows it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryBlock {
    #[serde(rename = "type")]
    pub kind: String,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub block_id: Option<String>,
}

/// The document as it was at `frontiers`, on a throwaway fork; `None` when
/// this document does not have that version.
pub fn fork_at(doc: &LoroDoc, frontiers: &[Frontier]) -> Option<LoroDoc> {
    if frontiers.is_empty() {
        return None;
    }
    let f = to_frontiers(frontiers);
    doc.frontiers_to_vv(&f)?;
    let fork = doc.fork_at(&f).ok()?;
    crate::document::configure(&fork);
    Some(fork)
}

/// The top-level blocks at `frontiers`.
pub fn preview_at(doc: &LoroDoc, frontiers: &[Frontier]) -> Vec<HistoryBlock> {
    fork_at(doc, frontiers)
        .map(|fork| read_blocks(&fork))
        .unwrap_or_default()
}

pub fn live_preview(doc: &LoroDoc) -> Vec<HistoryBlock> {
    read_blocks(doc)
}

fn read_blocks(doc: &LoroDoc) -> Vec<HistoryBlock> {
    tree::child_maps(&tree::root(doc))
        .into_iter()
        .map(|node| {
            let kind = match tree::node_name(&node) {
                n if n.is_empty() => "paragraph".to_owned(),
                n => n,
            };
            let id = tree::block_id(&node);
            HistoryBlock {
                text: history_block_text(&node, &kind),
                kind,
                block_id: (!id.is_empty()).then_some(id),
            }
        })
        .collect()
}

fn history_block_text(node: &LoroMap, kind: &str) -> String {
    let caption = plain_text(node);
    if kind != "mermaidFigure" && kind != "infographicFigure" {
        return caption;
    }
    let source = match tree::attrs(node).get("source") {
        Some(ValueOrContainer::Value(LoroValue::String(s))) => s.to_string(),
        _ => String::new(),
    };
    match (source.is_empty(), caption.is_empty()) {
        (false, false) => format!("{source}\n\n{caption}"),
        (false, true) => source,
        _ => caption,
    }
}

/// Text runs, and nested blocks on lines of their own (`plainText`).
fn plain_text(node: &LoroMap) -> String {
    let mut out = String::new();
    for item in tree::child_items(node) {
        match item {
            loro::Container::Text(t) => out.push_str(&t.to_string()),
            loro::Container::Map(m) => {
                let nested = plain_text(&m);
                if nested.is_empty() {
                    continue;
                }
                if !out.is_empty() && !out.ends_with('\n') {
                    out.push('\n');
                }
                out.push_str(&nested);
            }
            _ => {}
        }
    }
    out
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DiffPart {
    /// `add`, `remove` or `same`.
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffHunk {
    /// `add`, `remove`, `change` or `same` (context).
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub block_id: Option<String>,
    #[serde(rename = "type")]
    pub block_type: String,
    pub before: String,
    pub after: String,
    pub parts: Vec<DiffPart>,
}

/// The word-level, per-block diff of one change.
///
/// One fork at the change, then checked out to its parent: moving back by
/// one change costs what the change did, where a second fork would cost the
/// whole document again (AC-05.4: a 2 000-block document in under 300 ms).
pub fn diff_change(doc: &LoroDoc, entry: &HistoryEntry) -> Vec<DiffHunk> {
    let Some(fork) = fork_at(doc, &entry.frontiers) else {
        return diff_blocks(&[], &[]);
    };
    let after = read_blocks(&fork);
    let before = if entry.parent_frontiers.is_empty() {
        vec![]
    } else {
        match fork.checkout(&to_frontiers(&entry.parent_frontiers)) {
            Ok(()) => read_blocks(&fork),
            Err(_) => preview_at(doc, &entry.parent_frontiers),
        }
    };
    diff_blocks(&before, &after)
}

/// From the live document to the version at `frontiers`: what a restore
/// would do.
pub fn diff_against_live(doc: &LoroDoc, frontiers: &[Frontier]) -> Vec<DiffHunk> {
    diff_blocks(&live_preview(doc), &preview_at(doc, frontiers))
}

pub fn diff_blocks(before: &[HistoryBlock], after: &[HistoryBlock]) -> Vec<DiffHunk> {
    let after_by_id: HashMap<&str, &HistoryBlock> = after
        .iter()
        .filter_map(|b| Some((b.block_id.as_deref()?, b)))
        .collect();
    let before_ids: HashSet<&str> = before
        .iter()
        .filter_map(|b| b.block_id.as_deref())
        .collect();
    let mut seen = HashSet::new();
    let mut hunks = Vec::new();
    for block in before {
        let id = block.block_id.as_deref();
        if let Some(id) = id {
            seen.insert(id);
        }
        match id.and_then(|id| after_by_id.get(id)) {
            None => hunks.push(hunk("remove", block, "", None)),
            Some(next) if next.text == block.text && next.kind == block.kind => {
                hunks.push(hunk("same", block, &next.text, None))
            }
            Some(next) => hunks.push(hunk("change", block, &next.text, Some(&next.kind))),
        }
    }
    for block in after {
        if let Some(id) = block.block_id.as_deref()
            && (seen.contains(id) || before_ids.contains(id))
        {
            continue;
        }
        hunks.push(hunk("add", block, &block.text, None));
    }
    with_context(hunks)
}

fn hunk(
    kind: &'static str,
    block: &HistoryBlock,
    after: &str,
    kind_after: Option<&str>,
) -> DiffHunk {
    let before = if kind == "add" {
        ""
    } else {
        block.text.as_str()
    };
    let after = if kind == "remove" { "" } else { after };
    DiffHunk {
        kind,
        block_id: block.block_id.clone(),
        block_type: kind_after.unwrap_or(&block.kind).to_owned(),
        before: before.to_owned(),
        after: after.to_owned(),
        parts: if kind == "same" {
            vec![DiffPart {
                kind: "same",
                text: after.to_owned(),
            }]
        } else {
            diff_words(before, after)
        },
    }
}

/// Changed hunks with one unchanged block of context on each side.
fn with_context(hunks: Vec<DiffHunk>) -> Vec<DiffHunk> {
    let mut keep = vec![false; hunks.len()];
    for (i, h) in hunks.iter().enumerate() {
        if h.kind == "same" {
            continue;
        }
        keep[i] = true;
        if i > 0 {
            keep[i - 1] = true;
        }
        if i + 1 < hunks.len() {
            keep[i + 1] = true;
        }
    }
    if !keep.contains(&true) {
        return hunks.into_iter().take(1).collect();
    }
    hunks
        .into_iter()
        .zip(keep)
        .filter_map(|(h, k)| k.then_some(h))
        .collect()
}

/// Largest LCS table [`diff_words`] builds; beyond it the middle is one
/// replacement.
const DIFF_WORDS_MAX_CELLS: usize = 1_000_000;

/// Words and the whitespace between them, as parts that are kept, added or
/// removed (`diffWordsWithSpace`).
pub fn diff_words(before: &str, after: &str) -> Vec<DiffPart> {
    let part = |kind, text: &str| DiffPart {
        kind,
        text: text.to_owned(),
    };
    if before == after {
        return if before.is_empty() {
            vec![]
        } else {
            vec![part("same", before)]
        };
    }
    if before.is_empty() {
        return vec![part("add", after)];
    }
    if after.is_empty() {
        return vec![part("remove", before)];
    }
    let a = tokenize(before);
    let b = tokenize(after);
    let mut start = 0;
    while start < a.len() && start < b.len() && a[start] == b[start] {
        start += 1;
    }
    let (mut end_a, mut end_b) = (a.len(), b.len());
    while end_a > start && end_b > start && a[end_a - 1] == b[end_b - 1] {
        end_a -= 1;
        end_b -= 1;
    }
    let mut parts = Vec::new();
    for t in &a[..start] {
        push_part(&mut parts, "same", t);
    }
    let (mid_a, mid_b) = (&a[start..end_a], &b[start..end_b]);
    if (mid_a.len() + 1) * (mid_b.len() + 1) > DIFF_WORDS_MAX_CELLS {
        if !mid_a.is_empty() {
            push_part(&mut parts, "remove", &mid_a.concat());
        }
        if !mid_b.is_empty() {
            push_part(&mut parts, "add", &mid_b.concat());
        }
    } else {
        lcs_diff(mid_a, mid_b, &mut parts);
    }
    for t in &a[end_a..] {
        push_part(&mut parts, "same", t);
    }
    parts
}

fn lcs_diff(a: &[&str], b: &[&str], parts: &mut Vec<DiffPart>) {
    let (n, m) = (a.len(), b.len());
    let width = m + 1;
    let mut dp = vec![0u32; (n + 1) * width];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            dp[i * width + j] = if a[i] == b[j] {
                dp[(i + 1) * width + j + 1] + 1
            } else {
                dp[(i + 1) * width + j].max(dp[i * width + j + 1])
            };
        }
    }
    let (mut i, mut j) = (0, 0);
    while i < n && j < m {
        if a[i] == b[j] {
            push_part(parts, "same", a[i]);
            i += 1;
            j += 1;
        } else if dp[(i + 1) * width + j] >= dp[i * width + j + 1] {
            push_part(parts, "remove", a[i]);
            i += 1;
        } else {
            push_part(parts, "add", b[j]);
            j += 1;
        }
    }
    for t in &a[i..] {
        push_part(parts, "remove", t);
    }
    for t in &b[j..] {
        push_part(parts, "add", t);
    }
}

/// Runs of whitespace and of everything else (`split(/(\s+)/)`).
fn tokenize(text: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0;
    let mut space = None;
    for (i, c) in text.char_indices() {
        let is_space = c.is_whitespace();
        if space.is_some_and(|s| s != is_space) {
            out.push(&text[start..i]);
            start = i;
        }
        space = Some(is_space);
    }
    if start < text.len() {
        out.push(&text[start..]);
    }
    out
}

fn push_part(parts: &mut Vec<DiffPart>, kind: &'static str, text: &str) {
    if let Some(last) = parts.last_mut()
        && last.kind == kind
    {
        last.text.push_str(text);
        return;
    }
    parts.push(DiffPart {
        kind,
        text: text.to_owned(),
    });
}

// ── The incremental index ───────────────────────────────────────────────

/// History that grows with the document: only changes new since the last
/// refresh are described (AC-05.10), and the last author of every block is
/// kept for the attribution gutter.
#[derive(Default)]
pub struct HistoryIndex {
    /// Per peer, the last counter described.
    seen: HashMap<u64, i32>,
    entries: Vec<HistoryEntry>,
    authors_by_block: HashMap<String, HistoryAuthor>,
    diffs: Vec<(String, Vec<DiffHunk>)>,
}

impl HistoryIndex {
    pub fn new(doc: &LoroDoc) -> Self {
        let mut index = Self::default();
        index.refresh(doc);
        index
    }

    pub fn list(&self) -> &[HistoryEntry] {
        &self.entries
    }

    pub fn get(&self, id: &str) -> Option<&HistoryEntry> {
        self.entries.iter().find(|e| e.id == id)
    }

    pub fn last_author(&self, block_id: &str) -> Option<&HistoryAuthor> {
        self.authors_by_block.get(block_id)
    }

    pub fn last_authors(&self) -> &HashMap<String, HistoryAuthor> {
        &self.authors_by_block
    }

    /// Describes what is new; returns whether anything was.
    pub fn refresh(&mut self, doc: &LoroDoc) -> bool {
        let vv = doc.oplog_vv();
        // Nothing new: no need to read the authors or the tree.
        if vv
            .iter()
            .all(|(peer, end)| self.seen.get(peer).is_some_and(|s| *s >= end - 1))
        {
            return false;
        }
        let cx = Context::read(doc);
        let mut fresh = Vec::new();
        let mut replaced = HashSet::new();
        // The version vector names every peer's latest counter; frontiers
        // would drop a peer whose last change is an ancestor of another's.
        for (peer, end) in vv.iter() {
            let last = end - 1;
            let last_end = self.seen.get(peer).copied().unwrap_or(-1);
            if last <= last_end {
                continue;
            }
            let mut cursor = if last_end < 0 { 0 } else { last_end + 1 };
            while cursor <= last {
                let Some(change) = doc.get_change(ID::new(*peer, cursor)) else {
                    break;
                };
                let change_end = change.id.counter + change.len.max(1) as i32 - 1;
                if let Some(entry) = entry_from_change(doc, &change, &cx) {
                    // A change that grew (merged typing) keeps its id.
                    if change.id.counter <= last_end {
                        replaced.insert(entry.id.clone());
                    }
                    fresh.push(entry);
                }
                self.seen.insert(*peer, change_end);
                cursor = change_end + 1;
            }
        }
        if fresh.is_empty() {
            return false;
        }
        if !replaced.is_empty() {
            self.entries.retain(|e| !replaced.contains(&e.id));
        }
        fresh.sort_by(compare_history);
        for entry in &fresh {
            for block in &entry.block_ids {
                self.authors_by_block
                    .insert(block.clone(), entry.author.clone());
            }
        }
        self.entries.extend(fresh);
        self.entries.sort_by(compare_history);
        true
    }

    /// [`diff_change`] for entry `id`, cached for the last
    /// [`HISTORY_DIFF_CACHE`] entries (a merged change keeps its id while it
    /// grows, so the length is part of the key).
    pub fn diff(&mut self, doc: &LoroDoc, id: &str) -> Option<Vec<DiffHunk>> {
        let entry = self.get(id)?.clone();
        let key = format!("{}:{}", entry.id, entry.length);
        if let Some((_, hunks)) = self.diffs.iter().find(|(k, _)| *k == key) {
            return Some(hunks.clone());
        }
        let hunks = diff_change(doc, &entry);
        if self.diffs.len() >= HISTORY_DIFF_CACHE {
            self.diffs.remove(0);
        }
        self.diffs.push((key, hunks.clone()));
        Some(hunks)
    }
}

// ── Checkpoints ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Checkpoint {
    pub id: String,
    pub name: String,
    pub frontiers: Vec<Frontier>,
    pub actor_id: String,
    pub at: i64,
}

/// A named version in the `checkpoints` list, as the TS app writes one
/// (frontiers as a JSON string). Its own `sys:checkpoint` commit.
pub fn add_checkpoint(
    doc: &LoroDoc,
    name: &str,
    actor_id: &str,
    frontiers: Option<Vec<Frontier>>,
) -> Checkpoint {
    doc.commit();
    let name = match name.trim() {
        "" => "Checkpoint",
        n => n,
    }
    .to_owned();
    let frontiers = frontiers.unwrap_or_else(|| from_frontiers(&doc.oplog_frontiers()));
    let at = now_ms();
    let id = format!("cp_{}", radix36(at as u64));
    let list: LoroList = doc.get_list(CHECKPOINTS_KEY);
    let row = list
        .insert_container(list.len(), LoroMap::new())
        .expect("checkpoint row");
    row.insert("id", id.as_str()).expect("id");
    row.insert("name", name.as_str()).expect("name");
    row.insert("actorId", actor_id).expect("actorId");
    row.insert("at", at as f64).expect("at");
    row.insert(
        "frontiers",
        serde_json::to_string(&frontiers).expect("frontiers json"),
    )
    .expect("frontiers");
    doc.commit_with(
        CommitOptions::new()
            .origin(CHECKPOINT_ORIGIN)
            .commit_msg(&format!("checkpoint: {name}"))
            .timestamp(at),
    );
    Checkpoint {
        id,
        name,
        frontiers,
        actor_id: actor_id.to_owned(),
        at,
    }
}

/// Newest first.
pub fn list_checkpoints(doc: &LoroDoc) -> Vec<Checkpoint> {
    let LoroValue::List(rows) = doc.get_list(CHECKPOINTS_KEY).get_deep_value() else {
        return vec![];
    };
    let mut out: Vec<Checkpoint> = rows.iter().filter_map(as_checkpoint).collect();
    out.sort_by_key(|c| std::cmp::Reverse(c.at));
    out
}

fn as_checkpoint(row: &LoroValue) -> Option<Checkpoint> {
    let LoroValue::Map(row) = row else {
        return None;
    };
    let text = |key: &str| match row.get(key) {
        Some(LoroValue::String(s)) => Some(s.to_string()),
        _ => None,
    };
    let at = match row.get("at")? {
        LoroValue::Double(d) => *d as i64,
        LoroValue::I64(i) => *i,
        _ => return None,
    };
    let raw = text("frontiers")?;
    let parsed: Vec<Value> = serde_json::from_str(&raw).ok()?;
    let frontiers = parsed
        .into_iter()
        .filter_map(|v| serde_json::from_value(v).ok())
        .collect();
    Some(Checkpoint {
        id: text("id")?,
        name: text("name")?,
        actor_id: text("actorId")?,
        at,
        frontiers,
    })
}

fn radix36(mut n: u64) -> String {
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if n == 0 {
        return "0".into();
    }
    let mut out = Vec::new();
    while n > 0 {
        out.push(DIGITS[(n % 36) as usize]);
        n /= 36;
    }
    out.reverse();
    String::from_utf8(out).expect("ascii")
}
