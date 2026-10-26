//! One open document: the Loro doc, this participant's undo stack, and the
//! reconcile step that turns an editor's content back into Loro operations.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use loro::{
    CommitOptions, ContainerTrait, ExportMode, Frontiers, LoroDoc, LoroList, LoroMap, LoroText,
    LoroValue, UndoManager, VersionVector,
};

use crate::figures::{self, AssetError};
use crate::file::{self, Asset, FileError};
use crate::history::{self, AuthorRecord};
use crate::ids::new_doc_id;
use crate::model::{
    BlockKind, INLINE_UNIT, InlineNode, ListKind, Span, TargetBlock, ViewBlock, masks,
    spans_from_masks,
};
use crate::schema::*;
use crate::structure;
use crate::tree::{self, Located, Segment};
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
/// A string in the document's `meta` map (`docId`, `title`…).
pub fn meta_string(doc: &LoroDoc, key: &str) -> String {
    match doc.get_map(META_KEY).get(key) {
        Some(loro::ValueOrContainer::Value(LoroValue::String(s))) => s.to_string(),
        _ => String::new(),
    }
}

/// Milliseconds since the epoch: the system clock, or `Date.now()` in the
/// browser (where `SystemTime::now` panics).
pub fn now_ms() -> i64 {
    #[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
    {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0)
    }
    #[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
    {
        js_sys::Date::now() as i64
    }
}

pub fn configure(doc: &LoroDoc) {
    doc.set_record_timestamp(true);
    doc.config_text_style(text_style_config());
    doc.set_change_merge_interval(CHANGE_MERGE_INTERVAL);
}

/// Every leaf block with its location, in reading order.
type Flat = Rc<Vec<(Located, ViewBlock)>>;

pub struct Document {
    doc: LoroDoc,
    undo: UndoManager,
    actor: String,
    assets: Vec<Asset>,
    /// Assets added since [`Document::take_new_assets`], for the store.
    new_assets: Vec<Asset>,
    /// Who edits through this document, for the `authors` map.
    author: Option<AuthorRecord>,
    /// Block and time of the last human edit, to cut history and undo steps.
    last_edit: Option<(String, i64)>,
    /// The flattened tree, valid while the doc is at `frontiers`. Typing
    /// re-reads only the blocks it touched instead of the whole tree.
    flat: RefCell<Option<(Frontiers, Flat)>>,
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
            new_assets: Vec::new(),
            author: None,
            last_edit: None,
            flat: RefCell::new(None),
        }
    }

    pub fn loro(&self) -> &LoroDoc {
        &self.doc
    }

    pub fn actor(&self) -> &str {
        &self.actor
    }

    fn meta_string(&self, key: &str) -> String {
        meta_string(&self.doc, key)
    }

    /// The same document carrying `assets`.
    pub fn with_assets(mut self, assets: Vec<Asset>) -> Self {
        self.assets = assets;
        self
    }

    /// Who edits through this document. Their record goes into the
    /// `authors` map before their first edit (never on open, which would
    /// leave the file unsaved), or now when it changed (a rename).
    pub fn set_author(&mut self, author: AuthorRecord) {
        let changed = self.author.as_ref() != Some(&author);
        self.author = Some(author);
        if changed && history::is_author_registered(&self.doc) {
            self.doc.commit();
            let author = self.author.as_ref().expect("just set");
            history::write_author(&self.doc, author);
            self.doc.commit_with(
                CommitOptions::new()
                    .origin(history::AUTHOR_ORIGIN)
                    .timestamp(now_ms()),
            );
        }
    }

    pub fn author(&self) -> Option<&AuthorRecord> {
        self.author.as_ref()
    }

    fn ensure_author(&mut self) {
        if let Some(author) = &self.author {
            self.doc.commit();
            history::ensure_author(&self.doc, author);
        }
    }

    /// A named version of the document as it is now (a checkpoint).
    pub fn add_checkpoint(&mut self, name: &str) -> history::Checkpoint {
        let actor = self
            .author
            .as_ref()
            .map_or_else(|| self.actor.clone(), |a| a.actor_id.clone());
        history::add_checkpoint(&self.doc, name, &actor, None)
    }

    /// Makes the document read as it did at `frontiers`, as one new commit
    /// by this participant ("Restore version"): history keeps everything
    /// after that version, and undo takes the restore back. Blocks keep
    /// their identity where the version has them too.
    pub fn restore(&mut self, frontiers: &[history::Frontier]) -> bool {
        let Some(old) = history::fork_at(&self.doc, frontiers) else {
            return false;
        };
        self.ensure_author();
        let live_root = tree::root(&self.doc);
        let old_root = tree::root(&old);
        restore_children(&live_root, &old_root);
        let changed = self.doc.get_pending_txn_len() > 0;
        if changed {
            structure::normalize(&self.doc);
            self.commit_boundary("Restore version");
        }
        changed
    }

    /// Images and other files the document carries (`asset:<sha256>`).
    pub fn assets(&self) -> &[Asset] {
        &self.assets
    }

    pub fn asset(&self, hash: &str) -> Option<&Asset> {
        self.assets.iter().find(|a| a.hash == hash)
    }

    /// Adds image bytes (checked against the size limits); returns the
    /// `asset:<hash>` source that names them.
    pub fn put_asset(&mut self, bytes: Vec<u8>) -> Result<String, AssetError> {
        let asset = figures::make_asset(bytes, &self.assets)?;
        let src = format!("asset:{}", asset.hash);
        if self.asset(&asset.hash).is_none() {
            self.new_assets.push(asset.clone());
            self.assets.push(asset);
        }
        Ok(src)
    }

    /// Bytes someone else added (another participant, a merge): known here
    /// from now on.
    pub fn adopt_asset(&mut self, asset: Asset) {
        if self.asset(&asset.hash).is_none() {
            self.assets.push(asset);
        }
    }

    /// The assets added since the last call, which the store must keep.
    pub fn take_new_assets(&mut self) -> Vec<Asset> {
        std::mem::take(&mut self.new_assets)
    }

    /// Sets attribute `key` of the figure `id` (`blockId` or view key):
    /// `src`, `alt`, `source`, `width` (50, 75, 100 or null), `align`.
    /// One undo step.
    pub fn set_figure_attr(&mut self, id: &str, key: &str, value: &serde_json::Value) -> bool {
        let valid = match key {
            "src" | "alt" | "source" => value.is_string(),
            "width" => {
                value.is_null()
                    || value
                        .as_f64()
                        .is_some_and(|w| figures::FIGURE_WIDTHS.contains(&(w as u8)))
            }
            "align" => value
                .as_str()
                .is_some_and(|a| figures::FIGURE_ALIGNS.contains(&a)),
            _ => false,
        };
        if !valid {
            return false;
        }
        self.structural(&format!("figure {key}"), |doc| {
            let Some(located) = structure::find(doc, id) else {
                return false;
            };
            if !figures::is_figure(&tree::node_name(&located.node)) {
                return false;
            }
            let attrs = tree::attrs(&located.node);
            let have = match attrs.get(key) {
                Some(loro::ValueOrContainer::Value(v)) => tree::to_json(&v),
                _ => serde_json::Value::Null,
            };
            if &have == value {
                return false;
            }
            if value.is_null() {
                attrs.delete(key).expect("clear attribute");
            } else {
                attrs
                    .insert(key, tree::from_json(value))
                    .expect("set attribute");
            }
            true
        })
    }

    /// Sets the caption of the figure `id`. One undo step.
    pub fn set_caption(&mut self, id: &str, caption: &str) -> bool {
        let caption = caption.replace('\n', " ");
        self.structural("caption", |doc| {
            let Some(located) = structure::find(doc, id) else {
                return false;
            };
            if !figures::is_figure(&tree::node_name(&located.node))
                || tree::content(&located.node).0 == caption
            {
                return false;
            }
            write_text(&tree::ensure_text(&located.node), &caption, &[]);
            true
        })
    }

    /// Forgets undo and redo, after loading content that is not an edit
    /// (an import).
    pub fn clear_history(&mut self) {
        self.doc.commit();
        self.undo.clear();
    }

    pub fn doc_id(&self) -> String {
        self.meta_string("docId")
    }

    pub fn title(&self) -> String {
        self.meta_string("title")
    }

    pub fn set_title(&mut self, title: &str) {
        self.ensure_author();
        self.doc.get_map(META_KEY).insert("title", title).unwrap();
        self.commit_boundary(&format!("rename to “{title}”"));
    }

    /// A Loro cursor at UTF-16 offset `local` of the block with view key
    /// `key`: on the text run there (`None` beside an inline node with no
    /// text around it, or in a figure).
    pub fn cursor_at(&self, key: &str, local: usize) -> Option<loro::cursor::Cursor> {
        let flat = self.flat();
        let (located, _) = flat
            .iter()
            .find(|(_, view)| view.key == key && view.editable)?;
        let segments = tree::segments(&located.node);
        let texts = || {
            segments.iter().filter_map(|p| match &p.segment {
                Segment::Text(t) => Some((p, t)),
                Segment::Inline(_) => None,
            })
        };
        let (placed, text) = texts()
            .find(|(p, _)| p.start <= local && local < p.start + p.len)
            .or_else(|| texts().find(|(p, _)| p.start <= local && local <= p.start + p.len))?;
        let s = text.to_string();
        let chars = s[..utf16::to_utf8(&s, local - placed.start)]
            .chars()
            .count();
        text.get_cursor(chars, loro::cursor::Side::Middle)
    }

    /// Where char position `pos` of the text container `text` is in the
    /// view: `(block index, UTF-16 offset in the block)`.
    pub fn offset_in_text(&self, text: &loro::ContainerID, pos: usize) -> Option<(usize, usize)> {
        let flat = self.flat();
        flat.iter().enumerate().find_map(|(i, (located, view))| {
            if !view.editable {
                return None;
            }
            tree::segments(&located.node)
                .into_iter()
                .find_map(|p| match p.segment {
                    Segment::Text(t) if &t.id() == text => {
                        let s = t.to_string();
                        let units = utf16::len(&s.chars().take(pos).collect::<String>());
                        Some((i, p.start + units))
                    }
                    _ => None,
                })
        })
    }

    pub fn blocks(&self) -> Vec<ViewBlock> {
        self.flat().iter().map(|(_, view)| view.clone()).collect()
    }

    /// The flattened tree, recomputed only when the doc moved on without us
    /// (an import, undo, or a direct Loro edit).
    fn flat(&self) -> Flat {
        let frontiers = self.doc.state_frontiers();
        if let Some((at, flat)) = self.flat.borrow().as_ref()
            && *at == frontiers
        {
            return flat.clone();
        }
        let flat = Rc::new(tree::flatten(&self.doc));
        *self.flat.borrow_mut() = Some((frontiers, flat.clone()));
        flat
    }

    /// Plain text of the editable document, blocks separated by `\n`.
    pub fn plain_text(&self) -> String {
        self.blocks()
            .iter()
            .map(ViewBlock::label)
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
        self.reconcile_from(target, None)
    }

    /// [`Document::reconcile`] for an editor that knows where the caret was
    /// before the edit: history and undo cut when that block differs from the
    /// one the caret was in after the previous edit (see
    /// [`Document::set_caret_block`]), as `humanCommitCutter` does. Without
    /// it, the first changed block stands in for the caret.
    pub fn reconcile_from(&mut self, target: &[TargetBlock], caret_block: Option<&str>) -> bool {
        let current = self.flat();
        let assigned = assign_keys(&current, target);
        let changed_key = first_change(&current, target, &assigned);
        let Some(changed_key) = changed_key else {
            return false;
        };
        self.ensure_author();

        let mut retained = vec![false; current.len()];
        for c in assigned.iter().flatten() {
            retained[*c] = true;
        }
        let mut restructured = false;
        for (i, (located, view)) in current.iter().enumerate() {
            if retained[i] {
                continue;
            }
            if restructured {
                // An earlier deletion moved blocks; this one may be among them.
                let id = if view.block_id.is_empty() {
                    &view.key
                } else {
                    &view.block_id
                };
                if let Some(fresh) = structure::find(&self.doc, id) {
                    restructured |= tree::delete_leaf(&fresh);
                }
            } else {
                restructured |= tree::delete_leaf(located);
            }
        }
        // Deleting moved blocks (see `delete_leaf`): find them again by id.
        let current = if restructured {
            relocate(&self.doc, &current)
        } else {
            current
        };
        // The new flat view, built as we go: untouched blocks keep their view,
        // touched and new ones are read back from Loro.
        let mut flat = Vec::with_capacity(target.len());
        let mut prev: Option<Located> = None;
        for (t, slot) in target.iter().zip(&assigned) {
            match slot {
                Some(c) => {
                    let (located, view) = &current[*c];
                    if view.editable && block_differs(view, t) {
                        update_block(located, view, t);
                        flat.push((located.clone(), tree::located_view(located)));
                    } else {
                        flat.push((located.clone(), view.clone()));
                    }
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
                    write_content(&located.node, t);
                    flat.push((located.clone(), tree::located_view(&located)));
                    prev = Some(located);
                }
            }
        }
        let rebuilt = restructured || flat.is_empty();
        if rebuilt {
            tree::create_textblock(&tree::root(&self.doc), 0, BlockKind::Paragraph);
        }
        self.commit_human(caret_block.unwrap_or(&changed_key));
        let flat = if rebuilt {
            tree::flatten(&self.doc)
        } else {
            flat
        };
        *self.flat.borrow_mut() = Some((self.doc.state_frontiers(), Rc::new(flat)));
        true
    }

    /// A structural edit (lists, indent): its own history entry and undo step.
    fn structural(&mut self, message: &str, f: impl FnOnce(&LoroDoc) -> bool) -> bool {
        self.ensure_author();
        let changed = f(&self.doc);
        if changed {
            self.commit_boundary(message);
        }
        changed
    }

    /// Bullet, numbered or task list for the blocks `ids` (`blockId`s or view
    /// keys), like the toolbar toggles: blocks already in such a list leave
    /// it, blocks in another kind of list switch kind, others are wrapped.
    pub fn toggle_list(&mut self, ids: &[String], kind: ListKind) -> bool {
        let flat = tree::flatten(&self.doc);
        let chosen: Vec<&(Located, ViewBlock)> = ids
            .iter()
            .filter_map(|id| flat.iter().find(|(_, v)| v.block_id == *id || v.key == *id))
            .filter(|(_, v)| v.kind != BlockKind::Atom)
            .collect();
        if chosen.is_empty() {
            return false;
        }
        let stable: Vec<String> = chosen
            .iter()
            .map(|(_, v)| {
                if v.block_id.is_empty() {
                    v.key.clone()
                } else {
                    v.block_id.clone()
                }
            })
            .collect();
        if chosen.iter().all(|(_, v)| v.list == Some(kind)) {
            return self.structural("leave list", |doc| {
                let mut changed = false;
                for id in &stable {
                    while let Some(located) = structure::find(doc, id) {
                        if !structure::outdent(&located) {
                            break;
                        }
                        changed = true;
                    }
                }
                changed
            });
        }
        if chosen.iter().all(|(_, v)| v.list.is_some()) {
            return self.structural("change list", |doc| {
                let mut changed = false;
                for id in &stable {
                    if let Some(located) = structure::find(doc, id) {
                        changed |= structure::set_list_kind(&located, kind);
                    }
                }
                changed
            });
        }
        self.structural("make list", |doc| {
            // Runs of neighbouring blocks with one parent become one list each.
            let mut changed = false;
            let mut i = 0;
            while i < stable.len() {
                let Some(first) = structure::find(doc, &stable[i]) else {
                    i += 1;
                    continue;
                };
                if tree::located_view(&first).list.is_some() {
                    i += 1;
                    continue;
                }
                let mut run = vec![first];
                while i + run.len() < stable.len() {
                    let Some(next) = structure::find(doc, &stable[i + run.len()]) else {
                        break;
                    };
                    let last = run.last().unwrap();
                    let same_parent = next.parent().id() == last.parent().id();
                    let adjacent = tree::index_in(last.parent(), &last.node)
                        .zip(tree::index_in(next.parent(), &next.node))
                        .is_some_and(|(a, b)| b == a + 1);
                    if !same_parent || !adjacent || tree::located_view(&next).list.is_some() {
                        break;
                    }
                    run.push(next);
                }
                i += run.len();
                changed |= structure::wrap_in_list(&run, kind);
            }
            changed
        })
    }

    /// Quote on or off for the blocks `ids`, like Tiptap's
    /// `toggleBlockquote`: if they are all quoted they leave their innermost
    /// quote, otherwise the unquoted ones are wrapped (a block in a list
    /// brings the whole list, since an item cannot start with a quote).
    pub fn toggle_quote(&mut self, ids: &[String]) -> bool {
        let flat = tree::flatten(&self.doc);
        let chosen: Vec<(String, u8)> = ids
            .iter()
            .filter_map(|id| flat.iter().find(|(_, v)| v.block_id == *id || v.key == *id))
            .map(|(_, v)| (stable_view_id(v), v.quote_depth))
            .collect();
        if chosen.is_empty() {
            return false;
        }
        if chosen.iter().all(|(_, depth)| *depth > 0) {
            return self.structural("leave quote", |doc| {
                let mut changed = false;
                for (id, depth) in &chosen {
                    // A list lifted with an earlier line already took this one.
                    if let Some(located) = structure::find(doc, id)
                        && tree::located_view(&located).quote_depth == *depth
                    {
                        changed |= structure::lift_out_of_quote(&located);
                    }
                }
                changed
            });
        }
        self.structural("quote", |doc| {
            // What to wrap for each block, deduplicated, in reading order.
            let mut units: Vec<(LoroMap, LoroMap)> = Vec::new();
            for (id, depth) in &chosen {
                if *depth > 0 {
                    continue;
                }
                let Some(located) = structure::find(doc, id) else {
                    continue;
                };
                let unit = quote_unit(&located);
                if !units.iter().any(|(node, _)| node.id() == unit.0.id()) {
                    units.push(unit);
                }
            }
            // Runs of neighbouring siblings become one quote each.
            let mut changed = false;
            let mut i = 0;
            while i < units.len() {
                let parent = units[i].1.clone();
                let mut run = vec![units[i].0.clone()];
                while let Some((next, next_parent)) = units.get(i + run.len()) {
                    let adjacent = tree::index_in(&parent, run.last().unwrap())
                        .zip(tree::index_in(&parent, next))
                        .is_some_and(|(a, b)| b == a + 1);
                    if next_parent.id() != parent.id() || !adjacent {
                        break;
                    }
                    run.push(next.clone());
                }
                i += run.len();
                changed |= structure::wrap_in_quote(&parent, &run);
            }
            changed
        })
    }

    /// Takes line `id` out of its innermost quote (Enter on an empty quoted
    /// line; Backspace at the start of a quote, with `only_first`).
    pub fn lift_quote(&mut self, id: &str, only_first: bool) -> bool {
        self.structural("leave quote", |doc| {
            structure::find(doc, id).is_some_and(|located| {
                (!only_first || structure::starts_quote(&located))
                    && structure::lift_out_of_quote(&located)
            })
        })
    }

    pub fn indent(&mut self, ids: &[String]) -> bool {
        let ids = ids.to_vec();
        self.structural("indent", |doc| {
            let mut changed = false;
            for id in &ids {
                if let Some(located) = structure::find(doc, id) {
                    changed |= structure::indent(&located);
                }
            }
            changed
        })
    }

    pub fn outdent(&mut self, ids: &[String]) -> bool {
        let ids = ids.to_vec();
        self.structural("outdent", |doc| {
            let mut changed = false;
            for id in &ids {
                if let Some(located) = structure::find(doc, id) {
                    changed |= structure::outdent(&located);
                }
            }
            changed
        })
    }

    pub fn set_checked(&mut self, id: &str, checked: bool) -> bool {
        self.structural(if checked { "tick task" } else { "untick task" }, |doc| {
            structure::find(doc, id)
                .is_some_and(|located| structure::set_checked(&located, checked))
        })
    }

    /// Enter in a list line with a sub-list after it; see
    /// [`structure::split_item_with_children`]. Returns the new line's id.
    pub fn split_list_item(&mut self, id: &str, at: usize) -> Option<String> {
        let mut created = None;
        self.structural("split list item", |doc| {
            created = structure::find(doc, id)
                .filter(structure::has_content_after)
                .and_then(|line| structure::split_item_with_children(&line, at));
            created.is_some()
        });
        created
    }

    /// Pastes Markdown blocks into line `id` at `at`; one undo step. Returns
    /// the last pasted line's id.
    pub fn paste_blocks(
        &mut self,
        id: &str,
        at: usize,
        nodes: &[structure::NodeSnap],
    ) -> Option<String> {
        let mut last = None;
        self.structural("paste", |doc| {
            last =
                structure::find(doc, id).and_then(|line| structure::paste_blocks(&line, at, nodes));
            last.is_some()
        });
        last
    }

    /// A command (bold, heading, …): its own history entry and undo step,
    /// never merged with typing before or after it.
    pub fn reconcile_step(&mut self, target: &[TargetBlock]) -> bool {
        self.last_edit = None;
        let changed = self.reconcile(target);
        self.last_edit = None;
        changed
    }

    /// Where the caret ended up after an edit, for the next cut decision.
    pub fn set_caret_block(&mut self, key: &str) {
        if let Some((last, _)) = &mut self.last_edit {
            *last = key.to_owned();
        }
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
        self.tidy();
        done
    }

    pub fn redo(&mut self) -> bool {
        self.doc.commit();
        self.last_edit = None;
        let done = self.undo.redo().unwrap_or(false);
        self.doc.commit();
        self.tidy();
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
        self.tidy();
        Ok(self.doc.oplog_vv() != before)
    }

    /// Merged concurrent edits, and undoing one's own edit after them, can
    /// leave empty containers, duplicate ids or no block at all; tidy them as
    /// bookkeeping (never an undo step).
    fn tidy(&mut self) {
        if structure::normalize(&self.doc) {
            self.doc.commit_with(
                CommitOptions::new()
                    .origin("sys:normalize")
                    .timestamp(now_ms()),
            );
        }
    }
}

/// `current` with every block found again by `blockId` after blocks moved.
fn relocate(doc: &LoroDoc, current: &[(Located, ViewBlock)]) -> Flat {
    let fresh = tree::flatten(doc);
    Rc::new(
        current
            .iter()
            .map(|(located, view)| {
                fresh
                    .iter()
                    .find(|(_, v)| {
                        if view.block_id.is_empty() {
                            v.key == view.key
                        } else {
                            v.block_id == view.block_id
                        }
                    })
                    .cloned()
                    .unwrap_or_else(|| (located.clone(), view.clone()))
            })
            .collect(),
    )
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
    let (text, spans, inlines) = clean_target(t);
    view.text != text
        || view.spans != spans
        || !same_inlines(&view.inlines, &inlines)
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
    write_content(&located.node, t);
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

    let (want, want_href) = masks(new.len(), spans);
    apply_marks(text, &want, &want_href);
}

/// Marks `text` (already holding the right characters) as `want` says, one
/// mask (and link href) per UTF-16 unit.
fn apply_marks(text: &LoroText, want: &[u32], want_href: &[Option<String>]) {
    let len = want.len();
    let (have, have_href) = masks(len, &tree::text_spans(text));
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

/// A target's text, spans and inline nodes as a block would store them:
/// placeholders without a node dropped, no marks on inline nodes.
fn clean_target(t: &TargetBlock) -> (String, Vec<Span>, Vec<InlineNode>) {
    let units = utf16::units(&t.text);
    let has_placeholder = units.contains(&INLINE_UNIT);
    if !has_placeholder && t.inlines.is_empty() {
        return (
            t.text.clone(),
            crate::model::normalize_spans(units.len(), &t.spans),
            vec![],
        );
    }
    let (marks, hrefs) = masks(units.len(), &t.spans);
    let mut text = Vec::with_capacity(units.len());
    let (mut m, mut h) = (Vec::new(), Vec::new());
    let mut inlines = Vec::new();
    for (i, &u) in units.iter().enumerate() {
        if u == INLINE_UNIT {
            let Some(node) = t.inlines.iter().find(|n| n.at as usize == i) else {
                continue;
            };
            inlines.push(InlineNode {
                at: text.len() as u32,
                ..node.clone()
            });
            text.push(u);
            m.push(0);
            h.push(None);
            continue;
        }
        text.push(u);
        m.push(marks[i]);
        h.push(hrefs[i].clone());
    }
    (
        String::from_utf16_lossy(&text),
        spans_from_masks(&m, &h),
        inlines,
    )
}

fn same_inlines(a: &[InlineNode], b: &[InlineNode]) -> bool {
    a.len() == b.len()
        && a.iter()
            .zip(b)
            .all(|(x, y)| x.at == y.at && x.name == y.name && x.attrs == y.attrs)
}

/// Makes a textblock read `t`: its text runs and inline nodes (the children
/// `loro-prosemirror` keeps: text, then a node map, then text…), touching
/// only what differs.
fn write_content(node: &LoroMap, t: &TargetBlock) {
    let (target, spans, inlines) = clean_target(t);
    let segments = tree::segments(node);
    // One text run (or none) is the common case. Several runs side by side
    // happen after concurrent edits; the mixed path writes across them and
    // joins them.
    let mixed = segments.len() > 1
        || segments
            .iter()
            .any(|p| matches!(p.segment, Segment::Inline(_)));
    if !mixed && inlines.is_empty() {
        write_text(&tree::ensure_text(node), &target, &spans);
        return;
    }
    let (old_text, _, old_inlines) = tree::content(node);
    let old = utf16::units(&old_text);
    let new = utf16::units(&target);
    let (mut p, mut s) = utf16::common_affixes(&old, &new);
    // A kept placeholder must stay the same kind of node.
    let name_at = |list: &[InlineNode], at: usize| {
        list.iter()
            .find(|n| n.at as usize == at)
            .map(|n| n.name.clone())
    };
    if let Some(i) = (0..p).find(|&i| name_at(&old_inlines, i) != name_at(&inlines, i)) {
        p = i;
    }
    if let Some(k) = (0..s)
        .find(|&k| name_at(&old_inlines, old.len() - 1 - k) != name_at(&inlines, new.len() - 1 - k))
    {
        s = k;
    }
    delete_content(node, p..old.len() - s);
    let mut i = p;
    while i < new.len() - s {
        if new[i] == INLINE_UNIT {
            let n = inlines
                .iter()
                .find(|n| n.at as usize == i)
                .expect("clean placeholders have nodes");
            insert_inline(node, i, n);
            i += 1;
        } else {
            let mut j = i;
            while j < new.len() - s && new[j] != INLINE_UNIT {
                j += 1;
            }
            insert_content_text(node, i, &String::from_utf16_lossy(&new[i..j]));
            i = j;
        }
    }
    merge_texts(node);
    let (want, want_href) = masks(new.len(), &spans);
    for placed in tree::segments(node) {
        match &placed.segment {
            Segment::Inline(map) => {
                if let Some(n) = inlines.iter().find(|n| n.at as usize == placed.start) {
                    tree::update_inline_attrs(map, n);
                }
            }
            Segment::Text(text) => {
                let range = placed.start..placed.start + placed.len;
                apply_marks(text, &want[range.clone()], &want_href[range]);
            }
        }
    }
}

/// Deletes the UTF-16 `range` of a textblock's content.
fn delete_content(node: &LoroMap, range: std::ops::Range<usize>) {
    if range.is_empty() {
        return;
    }
    let list = tree::children(node);
    for placed in tree::segments(node).iter().rev() {
        let a = placed.start.max(range.start);
        let b = (placed.start + placed.len).min(range.end);
        if a >= b {
            continue;
        }
        match &placed.segment {
            Segment::Text(t) => t
                .delete_utf16(a - placed.start, b - a)
                .expect("delete text"),
            Segment::Inline(_) => list.delete(placed.index, 1).expect("delete inline node"),
        }
    }
}

/// Where new content at `at` goes in the children list: before the first
/// child that starts at or after it.
fn child_index_at(segments: &[tree::Placed], at: usize, list: &LoroList) -> usize {
    segments
        .iter()
        .find(|p| p.start >= at)
        .map_or(list.len(), |p| p.index)
}

fn insert_content_text(node: &LoroMap, at: usize, text: &str) {
    let segments = tree::segments(node);
    let found = segments.iter().find_map(|p| match &p.segment {
        Segment::Text(t) if p.start <= at && at <= p.start + p.len => Some((p.start, t.clone())),
        _ => None,
    });
    if let Some((start, t)) = found {
        t.insert_utf16(at - start, text).expect("insert text");
        return;
    }
    let list = tree::children(node);
    let index = child_index_at(&segments, at, &list);
    let t = list
        .insert_container(index, LoroText::new())
        .expect("insert text run");
    t.insert_utf16(0, text).expect("insert text");
}

fn insert_inline(node: &LoroMap, at: usize, inline: &InlineNode) {
    let segments = tree::segments(node);
    let list = tree::children(node);
    // Inside a text run: split it around the node.
    let inside = segments.iter().find_map(|p| match &p.segment {
        Segment::Text(t) if p.start < at && at < p.start + p.len => Some((p.clone(), t.clone())),
        _ => None,
    });
    if let Some((placed, text)) = inside {
        let off = at - placed.start;
        let tail = structure::runs_after(&structure::text_runs(&text), off);
        text.delete_utf16(off, placed.len - off)
            .expect("cut text run");
        let rest = list
            .insert_container(placed.index + 1, LoroText::new())
            .expect("insert text run");
        structure::write_runs(&rest, 0, &tail);
        tree::create_inline(&list, placed.index + 1, inline);
        return;
    }
    let index = child_index_at(&segments, at, &list);
    tree::create_inline(&list, index, inline);
}

/// Joins text runs that ended up side by side (a node between them went).
fn merge_texts(node: &LoroMap) {
    let list = tree::children(node);
    loop {
        let segments = tree::segments(node);
        let pair = segments
            .windows(2)
            .find_map(|w| match (&w[0].segment, &w[1].segment) {
                (Segment::Text(a), Segment::Text(b)) if w[1].index == w[0].index + 1 => {
                    Some((a.clone(), b.clone(), w[1].index))
                }
                _ => None,
            });
        let Some((a, b, index)) = pair else {
            return;
        };
        structure::write_runs(&a, a.len_unicode(), &structure::text_runs(&b));
        list.delete(index, 1).expect("delete merged run");
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

/// A block's `blockId`, or its view key in files that lack ids.
fn stable_view_id(view: &ViewBlock) -> String {
    if view.block_id.is_empty() {
        view.key.clone()
    } else {
        view.block_id.clone()
    }
}

/// `(node, parent)` to wrap in a quote for `located`: the block, or the
/// outermost list around it.
fn quote_unit(located: &Located) -> (LoroMap, LoroMap) {
    let a = &located.ancestors;
    let mut unit = (located.node.clone(), located.parent().clone());
    for i in (1..a.len()).rev() {
        let name = tree::node_name(&a[i]);
        if !is_list_type(&name) && !is_item_type(&name) {
            break;
        }
        if is_list_type(&name) {
            unit = (a[i].clone(), a[i - 1].clone());
        }
    }
    unit
}

// ── Restore ─────────────────────────────────────────────────────────────

/// What identifies a child across versions: its `blockId`, or for a list
/// (which has none) its name and its first line's id.
fn identity(node: &LoroMap) -> String {
    let id = tree::block_id(node);
    if !id.is_empty() {
        return id;
    }
    let name = tree::node_name(node);
    let first = tree::child_maps(node)
        .first()
        .map(identity)
        .unwrap_or_default();
    format!("{name}:{first}")
}

/// Makes `live`'s block children read like `old`'s (a version of them).
fn restore_children(live: &LoroMap, old: &LoroMap) {
    let live_kids = tree::child_maps(live);
    let old_kids = tree::child_maps(old);
    let live_keys: Vec<String> = live_kids.iter().map(identity).collect();
    let mut used = vec![false; live_kids.len()];
    let raw: Vec<Option<usize>> = old_kids
        .iter()
        .map(|o| {
            let key = identity(o);
            let i = live_keys
                .iter()
                .enumerate()
                .position(|(i, k)| !used[i] && *k == key)?;
            used[i] = true;
            Some(i)
        })
        .collect();
    let assigned = longest_increasing(&raw);
    let kept: HashSet<usize> = assigned.iter().flatten().copied().collect();
    let list = tree::children(live);
    for i in (0..live_kids.len()).rev() {
        if !kept.contains(&i)
            && let Some(at) = tree::index_in(live, &live_kids[i])
        {
            list.delete(at, 1).expect("delete block");
        }
    }
    let mut pos = 0;
    for (old_kid, slot) in old_kids.iter().zip(&assigned) {
        match slot {
            Some(i) => {
                let live_kid = &live_kids[*i];
                let at = tree::index_in(live, live_kid).unwrap_or(pos);
                restore_node(live, at, live_kid, old_kid);
                pos = at + 1;
            }
            None => {
                structure::materialize(live, pos, &structure::snapshot(old_kid));
                pos += 1;
            }
        }
    }
}

/// Makes one kept child read like its version.
fn restore_node(parent: &LoroMap, at: usize, live: &LoroMap, old: &LoroMap) {
    let name = tree::node_name(old);
    if tree::node_name(live) != name {
        tree::children(parent).delete(at, 1).expect("replace block");
        structure::materialize(parent, at, &structure::snapshot(old));
        return;
    }
    // Attributes.
    let want = match tree::attrs(old).get_value() {
        LoroValue::Map(m) => m,
        _ => Default::default(),
    };
    let attrs = tree::attrs(live);
    for key in attrs.keys().map(|k| k.to_string()).collect::<Vec<_>>() {
        if !want.contains_key(&key) {
            attrs.delete(&key).expect("delete attribute");
        }
    }
    for (key, value) in want.iter() {
        let have = match attrs.get(key) {
            Some(loro::ValueOrContainer::Value(v)) => Some(v),
            _ => None,
        };
        if have.as_ref() != Some(value) {
            attrs.insert(key, value.clone()).expect("set attribute");
        }
    }
    if is_container_type(&name) {
        restore_children(live, old);
        return;
    }
    // Text, marks and inline nodes (a figure's caption too).
    let (text, spans, inlines) = tree::content(old);
    let target = TargetBlock {
        key: None,
        kind: None,
        text,
        spans,
        inlines,
    };
    let (have_text, have_spans, have_inlines) = tree::content(live);
    if have_text != target.text
        || have_spans != target.spans
        || !same_inlines(&have_inlines, &target.inlines)
    {
        write_content(live, &target);
    }
}
