//! One open document: the Loro doc, this participant's undo stack, and the
//! reconcile step that turns an editor's content back into Loro operations.

use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

use loro::{CommitOptions, ExportMode, LoroDoc, LoroText, LoroValue, UndoManager, VersionVector};

use crate::file::{self, Asset, FileError};
use crate::ids::new_doc_id;
use crate::model::{BlockKind, Span, TargetBlock, ViewBlock, masks};
use crate::schema::*;
use crate::tree::{self, Located};
use crate::utf16;

#[derive(Debug, thiserror::Error)]
pub enum DocError {
    #[error(transparent)]
    File(#[from] FileError),
    #[error("This file holds no readable document: {0}")]
    Loro(String),
}

/// Milliseconds since the epoch. Loro calls these "seconds"; the TS app
/// stamps milliseconds on purpose (see `commitTimestamp`) and so do we.
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn configure(doc: &LoroDoc) {
    doc.set_record_timestamp(true);
    doc.config_text_style(text_style_config());
    doc.set_change_merge_interval(CHANGE_MERGE_INTERVAL);
}

pub struct Document {
    doc: LoroDoc,
    undo: UndoManager,
    actor: String,
    assets: Vec<Asset>,
    /// Block and time of the last human edit, to cut history and undo steps.
    last_edit: Option<(String, i64)>,
}

impl Document {
    /// A new document: metadata plus one empty paragraph (like `createDocument`).
    pub fn create(title: &str, actor: &str) -> Self {
        let doc = LoroDoc::new();
        configure(&doc);
        let meta = doc.get_map(META_KEY);
        meta.insert("docId", new_doc_id()).unwrap();
        meta.insert("title", title).unwrap();
        meta.insert("schemaVersion", SCHEMA_VERSION as f64).unwrap();
        meta.insert("createdAt", now_ms() as f64).unwrap();
        let root = tree::root(&doc);
        root.insert(NODE_NAME_KEY, "doc").unwrap();
        tree::attrs(&root);
        tree::create_textblock(&root, 0, BlockKind::Paragraph);
        doc.commit_with(
            CommitOptions::new()
                .origin(INIT_ORIGIN)
                .commit_msg("create document")
                .timestamp(now_ms()),
        );
        Self::wrap(doc, actor, vec![])
    }

    /// A configured doc from snapshot or update bytes (like `openDocument`).
    pub fn from_snapshot(bytes: &[u8], actor: &str) -> Result<Self, DocError> {
        let doc = LoroDoc::new();
        configure(&doc);
        doc.import(bytes)
            .map_err(|e| DocError::Loro(e.to_string()))?;
        ensure_text_shape(&doc);
        Ok(Self::wrap(doc, actor, vec![]))
    }

    pub fn from_collabdoc(bytes: &[u8], actor: &str) -> Result<Self, DocError> {
        let decoded = file::decode(bytes)?;
        let mut document = Self::from_snapshot(&decoded.snapshot, actor)?;
        document.assets = decoded.assets;
        Ok(document)
    }

    pub fn to_collabdoc(&self) -> Vec<u8> {
        self.doc.commit();
        let snapshot = self
            .doc
            .export(ExportMode::Snapshot)
            .expect("snapshot export");
        file::encode(
            &self.doc_id(),
            &self.title(),
            now_ms(),
            &snapshot,
            &self.assets,
        )
    }

    /// Another participant on the same document (new Loro peer, own undo stack).
    pub fn fork(&self, actor: &str) -> Self {
        self.doc.commit();
        let doc = self.doc.fork();
        configure(&doc);
        Self::wrap(doc, actor, self.assets.clone())
    }

    fn wrap(doc: LoroDoc, actor: &str, assets: Vec<Asset>) -> Self {
        let mut undo = UndoManager::new(&doc);
        undo.set_max_undo_steps(UNDO_MAX_STEPS);
        undo.set_merge_interval(UNDO_STEP_MAX_MS);
        undo.add_exclude_origin_prefix(SYSTEM_ORIGIN_PREFIX);
        Self {
            doc,
            undo,
            actor: actor.to_owned(),
            assets,
            last_edit: None,
        }
    }

    pub fn loro(&self) -> &LoroDoc {
        &self.doc
    }

    pub fn actor(&self) -> &str {
        &self.actor
    }

    fn meta_string(&self, key: &str) -> String {
        match self.doc.get_map(META_KEY).get(key) {
            Some(loro::ValueOrContainer::Value(LoroValue::String(s))) => s.to_string(),
            _ => String::new(),
        }
    }

    pub fn doc_id(&self) -> String {
        self.meta_string("docId")
    }

    pub fn title(&self) -> String {
        self.meta_string("title")
    }

    pub fn set_title(&mut self, title: &str) {
        self.doc.get_map(META_KEY).insert("title", title).unwrap();
        self.commit_boundary(&format!("rename to “{title}”"));
    }

    pub fn blocks(&self) -> Vec<ViewBlock> {
        tree::flatten(&self.doc)
            .into_iter()
            .map(|(_, view)| view)
            .collect()
    }

    /// Plain text of the editable document, blocks separated by `\n`.
    pub fn plain_text(&self) -> String {
        self.blocks()
            .iter()
            .map(|b| b.text.as_str())
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn origin(&self) -> String {
        format!("{ACTOR_ORIGIN_PREFIX}{}", self.actor)
    }

    /// A commit that is its own history entry and undo step.
    fn commit_boundary(&mut self, message: &str) {
        self.undo.set_merge_interval(0);
        self.doc.commit_with(
            CommitOptions::new()
                .origin(&self.origin())
                .commit_msg(message)
                .timestamp(now_ms()),
        );
        self.undo.set_merge_interval(UNDO_STEP_MAX_MS);
        self.last_edit = None;
    }

    /// Applies the editor's content. Returns whether anything changed.
    ///
    /// Blocks keep their identity when the editor still knows them by key;
    /// text is diffed so concurrent edits elsewhere in the same block merge.
    /// The tree decides structure: a new block lands right after the block
    /// before it (a new list item when that block is in a list). The editor
    /// re-renders from [`Document::blocks`] afterwards, so any shape the tree
    /// does not allow (a heading as a list item's first line) snaps back.
    pub fn reconcile(&mut self, target: &[TargetBlock]) -> bool {
        let current = tree::flatten(&self.doc);
        let assigned = assign_keys(&current, target);
        let changed_key = first_change(&current, target, &assigned);
        let Some(changed_key) = changed_key else {
            return false;
        };

        let retained: Vec<bool> = {
            let mut r = vec![false; current.len()];
            for c in assigned.iter().flatten() {
                r[*c] = true;
            }
            r
        };
        for (i, (located, _)) in current.iter().enumerate() {
            if !retained[i] {
                tree::delete_leaf(located);
            }
        }
        let mut prev: Option<Located> = None;
        for (t, slot) in target.iter().zip(&assigned) {
            match slot {
                Some(c) => {
                    let (located, view) = &current[*c];
                    update_block(located, view, t);
                    prev = Some(located.clone());
                }
                None => {
                    if t.kind == Some(BlockKind::Atom) {
                        continue;
                    }
                    let located = insert_after(
                        &self.doc,
                        prev.as_ref(),
                        t.kind.unwrap_or(BlockKind::Paragraph),
                    );
                    write_text(&tree::ensure_text(&located.node), &t.text, &t.spans);
                    prev = Some(located);
                }
            }
        }
        if tree::flatten(&self.doc).is_empty() {
            tree::create_textblock(&tree::root(&self.doc), 0, BlockKind::Paragraph);
        }
        self.commit_human(&changed_key);
        true
    }

    /// Human typing is one history entry and undo step until 1 s idle or a
    /// block switch (`humanCommitCutter`). A cut commit carries its own
    /// timestamp (so Loro starts a new change) and is recorded with a zero undo
    /// merge interval (so it starts a new step); otherwise it merges.
    fn commit_human(&mut self, key: &str) {
        let now = now_ms();
        let cut = self
            .last_edit
            .as_ref()
            .is_none_or(|(k, at)| k != key || now - at > HUMAN_COMMIT_IDLE_MS);
        let mut options = CommitOptions::new().origin(&self.origin());
        if cut {
            options = options.timestamp(now);
            self.undo.set_merge_interval(0);
        }
        self.doc.commit_with(options);
        self.undo.set_merge_interval(UNDO_STEP_MAX_MS);
        self.last_edit = Some((key.to_owned(), now));
    }

    pub fn undo(&mut self) -> bool {
        self.doc.commit();
        self.last_edit = None;
        let done = self.undo.undo().unwrap_or(false);
        self.doc.commit();
        done
    }

    pub fn redo(&mut self) -> bool {
        self.doc.commit();
        self.last_edit = None;
        let done = self.undo.redo().unwrap_or(false);
        self.doc.commit();
        done
    }

    pub fn can_undo(&self) -> bool {
        self.undo.can_undo()
    }

    pub fn can_redo(&self) -> bool {
        self.undo.can_redo()
    }

    pub fn version(&self) -> VersionVector {
        self.doc.oplog_vv()
    }

    /// Everything this doc has that `since` does not.
    pub fn export_since(&self, since: &VersionVector) -> Vec<u8> {
        self.doc.commit();
        self.doc
            .export(ExportMode::updates(since))
            .expect("update export")
    }

    /// Imports a peer's updates. Returns whether the document changed.
    pub fn import(&mut self, bytes: &[u8]) -> Result<bool, DocError> {
        self.doc.commit();
        let before = self.doc.oplog_vv();
        self.doc
            .import(bytes)
            .map_err(|e| DocError::Loro(e.to_string()))?;
        Ok(self.doc.oplog_vv() != before)
    }
}

/// Gives every text-bearing block an empty `LoroText` up front, under a `sys:`
/// origin, so undoing someone's first keystroke never removes the container
/// (and a collaborator's text in it). Same rule as `ensureTextShape`.
fn ensure_text_shape(doc: &LoroDoc) {
    let mut added = 0;
    for (located, view) in tree::flatten(doc) {
        if view.kind != BlockKind::Atom && tree::child_items(&located.node).is_empty() {
            tree::children(&located.node)
                .insert_container(0, LoroText::new())
                .unwrap();
            added += 1;
        }
    }
    if added > 0 {
        doc.commit_with(CommitOptions::new().origin("sys:shape").timestamp(now_ms()));
    }
}

/// For each target block, the index of the current block it continues.
///
/// Keys must exist, be used once and keep their relative order (longest
/// increasing run); anything else counts as a new block. Then a key moves to
/// a neighbouring new block when that one matches the old text better: Qt
/// keeps a block's identity on the *first* half of a split, so Enter at the
/// start of a line would otherwise retype the whole line as new text.
fn assign_keys(current: &[(Located, ViewBlock)], target: &[TargetBlock]) -> Vec<Option<usize>> {
    let index: HashMap<&str, usize> = current
        .iter()
        .enumerate()
        .map(|(i, (_, v))| (v.key.as_str(), i))
        .collect();
    let mut seen = std::collections::HashSet::new();
    let raw: Vec<Option<usize>> = target
        .iter()
        .map(|t| {
            let c = *index.get(t.key.as_deref()?)?;
            seen.insert(c).then_some(c)
        })
        .collect();
    let mut assigned = longest_increasing(&raw);

    let mut i = 0;
    while i < target.len() {
        let Some(c) = assigned[i] else {
            i += 1;
            continue;
        };
        let (_, view) = &current[c];
        if !view.editable {
            i += 1;
            continue;
        }
        let old = utf16::units(&view.text);
        let score = |j: usize| {
            let (p, s) = utf16::common_affixes(&old, &utf16::units(&target[j].text));
            p + s
        };
        // Higher score wins; a tie keeps the block the key already had.
        let mut best = (score(i), i);
        let mut j = i;
        while j > 0 && assigned[j - 1].is_none() {
            j -= 1;
            let s = score(j);
            if s > best.0 {
                best = (s, j);
            }
        }
        let mut k = i + 1;
        while k < target.len() && assigned[k].is_none() {
            let s = score(k);
            if s > best.0 {
                best = (s, k);
            }
            k += 1;
        }
        if best.1 != i {
            assigned[best.1] = Some(c);
            assigned[i] = None;
        }
        i = k;
    }
    assigned
}

/// Keeps the longest subsequence of `Some` indices that increases; the rest become `None`.
fn longest_increasing(raw: &[Option<usize>]) -> Vec<Option<usize>> {
    let items: Vec<(usize, usize)> = raw
        .iter()
        .enumerate()
        .filter_map(|(i, c)| c.map(|c| (i, c)))
        .collect();
    let mut tails: Vec<usize> = Vec::new();
    let mut prev: Vec<Option<usize>> = vec![None; items.len()];
    for (n, &(_, c)) in items.iter().enumerate() {
        let pos = tails.partition_point(|&t| items[t].1 < c);
        if pos > 0 {
            prev[n] = Some(tails[pos - 1]);
        }
        if pos == tails.len() {
            tails.push(n);
        } else {
            tails[pos] = n;
        }
    }
    let mut keep = vec![None; raw.len()];
    let mut cursor = tails.last().copied();
    while let Some(n) = cursor {
        keep[items[n].0] = Some(items[n].1);
        cursor = prev[n];
    }
    keep
}

/// The key of the first block that differs, or `None` when nothing does.
fn first_change(
    current: &[(Located, ViewBlock)],
    target: &[TargetBlock],
    assigned: &[Option<usize>],
) -> Option<String> {
    let mut used = vec![false; current.len()];
    for (t, slot) in target.iter().zip(assigned) {
        match slot {
            None if t.kind == Some(BlockKind::Atom) => {}
            None => return Some(String::from("new")),
            Some(c) => {
                used[*c] = true;
                let view = &current[*c].1;
                if view.editable && block_differs(view, t) {
                    return Some(view.key.clone());
                }
            }
        }
    }
    used.iter()
        .position(|u| !u)
        .map(|i| current[i].1.key.clone())
}

fn block_differs(view: &ViewBlock, t: &TargetBlock) -> bool {
    let len = utf16::len(&t.text);
    view.text != t.text
        || view.spans != crate::model::normalize_spans(len, &t.spans)
        || t.kind
            .is_some_and(|k| k != view.kind && kind_allowed(view, k))
}

/// In a list item the first line is always a paragraph.
fn kind_allowed(view: &ViewBlock, kind: BlockKind) -> bool {
    view.kind != BlockKind::Atom
        && kind != BlockKind::Atom
        && (view.list.is_none() || kind == BlockKind::Paragraph)
}

fn update_block(located: &Located, view: &ViewBlock, t: &TargetBlock) {
    if !view.editable {
        return;
    }
    if let Some(kind) = t.kind
        && kind != view.kind
        && kind_allowed(view, kind)
    {
        tree::set_kind(&located.node, kind);
    }
    write_text(&tree::ensure_text(&located.node), &t.text, &t.spans);
}

/// Makes `text` read `target` with `spans`, touching only what differs.
fn write_text(text: &LoroText, target: &str, spans: &[Span]) {
    let old = utf16::units(&text.to_string());
    let new = utf16::units(target);
    let (p, s) = utf16::common_affixes(&old, &new);
    let removed = old.len() - p - s;
    if removed > 0 {
        text.delete_utf16(p, removed).expect("delete text");
    }
    let inserted = &new[p..new.len() - s];
    if !inserted.is_empty() {
        text.insert_utf16(p, &String::from_utf16_lossy(inserted))
            .expect("insert text");
    }

    let len = new.len();
    let (have, have_href) = masks(len, &tree::text_spans(text));
    let (want, want_href) = masks(len, spans);
    for (bit_index, name) in MARKS.iter().enumerate() {
        let bit = 1u32 << bit_index;
        let mut i = 0;
        while i < len {
            let wants = want[i] & bit != 0;
            let differs = (have[i] & bit != 0) != wants
                || (bit == LINK_BIT && wants && have_href[i] != want_href[i]);
            if !differs {
                i += 1;
                continue;
            }
            let start = i;
            let href = want_href[i].clone();
            while i < len
                && (want[i] & bit != 0) == wants
                && ((have[i] & bit != 0) != wants
                    || (bit == LINK_BIT && wants && have_href[i] != want_href[i]))
                && (bit != LINK_BIT || want_href[i] == href)
            {
                i += 1;
            }
            if wants {
                text.mark_utf16(start..i, name, mark_value(name, href.as_deref()))
                    .expect("mark");
            } else {
                text.unmark_utf16(start..i, name).expect("unmark");
            }
        }
    }
}

/// `loro-prosemirror` stores a mark's ProseMirror attrs as its value.
fn mark_value(name: &str, href: Option<&str>) -> LoroValue {
    let mut attrs: HashMap<String, LoroValue> = HashMap::new();
    if name == "link" {
        attrs.insert("href".into(), href.unwrap_or_default().into());
    }
    attrs.into()
}

/// Creates a block that reads right after `prev` (or first, with no `prev`).
fn insert_after(doc: &LoroDoc, prev: Option<&Located>, kind: BlockKind) -> Located {
    let kind = if kind == BlockKind::Atom {
        BlockKind::Paragraph
    } else {
        kind
    };
    let Some(prev) = prev else {
        let root = tree::root(doc);
        let node = tree::create_textblock(&root, 0, kind);
        return Located {
            node,
            ancestors: vec![root],
        };
    };
    let parent = prev.parent().clone();
    let at = tree::index_in(&parent, &prev.node).map_or(0, |i| i + 1);
    let parent_name = tree::node_name(&parent);
    if !is_item_type(&parent_name) {
        let node = tree::create_textblock(&parent, at, kind);
        return Located {
            node,
            ancestors: prev.ancestors.clone(),
        };
    }
    // `prev` is a line of a list item. A nested list right after it reads next,
    // so the new line becomes that list's first item; otherwise a new item
    // follows `prev`'s item.
    let siblings = tree::child_maps(&parent);
    if let Some(next) = siblings.get(at) {
        let next_name = tree::node_name(next);
        if is_list_type(&next_name) {
            let item_name = if next_name == "taskList" {
                "taskItem"
            } else {
                "listItem"
            };
            let (item, node) = tree::create_item(next, 0, item_name);
            let mut ancestors = prev.ancestors.clone();
            ancestors.extend([next.clone(), item]);
            return Located { node, ancestors };
        }
        let node = tree::create_textblock(&parent, at, kind);
        return Located {
            node,
            ancestors: prev.ancestors.clone(),
        };
    }
    let list = prev.ancestors[prev.ancestors.len() - 2].clone();
    let item_at = tree::index_in(&list, &parent).map_or(0, |i| i + 1);
    let (item, node) = tree::create_item(&list, item_at, &parent_name);
    let mut ancestors = prev.ancestors[..prev.ancestors.len() - 1].to_vec();
    ancestors.push(item);
    Located { node, ancestors }
}
