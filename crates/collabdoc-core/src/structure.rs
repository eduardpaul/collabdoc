//! Structural edits on the block tree: lists in and out, indent and outdent,
//! task ticks.
//!
//! The tree's children are plain `LoroList`s, which cannot move an element,
//! so moving a block copies it (text with marks, attributes, `blockId`,
//! children) to its new place and deletes the original — as `loro-prosemirror`
//! does for the same ProseMirror commands. Blocks are found again by
//! `blockId`, which survives the copy; their view keys do not.

use loro::{LoroList, LoroMap, LoroText, LoroValue, TextDelta, ValueOrContainer};

use crate::ids::new_block_id;
use crate::model::{BlockKind, ListKind};
use crate::schema::*;
use crate::tree::{self, Located};

/// A subtree, read out so it can be written somewhere else.
#[derive(Debug, Clone)]
pub struct NodeSnap {
    pub name: String,
    pub attrs: Vec<(String, LoroValue)>,
    pub children: Vec<ChildSnap>,
}

#[derive(Debug, Clone)]
pub enum ChildSnap {
    /// Runs of text with their marks.
    Text(Vec<(String, Vec<(String, LoroValue)>)>),
    Node(NodeSnap),
}

pub fn snapshot(node: &LoroMap) -> NodeSnap {
    let attrs = match tree::attrs(node).get_value() {
        LoroValue::Map(map) => map
            .iter()
            .map(|(k, v)| (k.to_string(), v.clone()))
            .collect(),
        _ => vec![],
    };
    let mut children = Vec::new();
    for item in tree::child_items(node) {
        match item {
            loro::Container::Text(text) => children.push(ChildSnap::Text(text_runs(&text))),
            loro::Container::Map(map) => children.push(ChildSnap::Node(snapshot(&map))),
            _ => {}
        }
    }
    NodeSnap {
        name: tree::node_name(node),
        attrs,
        children,
    }
}

pub(crate) fn text_runs(text: &LoroText) -> Vec<(String, Vec<(String, LoroValue)>)> {
    text.to_delta()
        .into_iter()
        .filter_map(|d| match d {
            TextDelta::Insert { insert, attributes } => Some((
                insert,
                attributes
                    .map(|a| {
                        a.into_iter()
                            .filter(|(_, v)| !matches!(v, LoroValue::Null))
                            .collect()
                    })
                    .unwrap_or_default(),
            )),
            _ => None,
        })
        .collect()
}

/// Inserts `runs` at char position `at`: all the text first, then the marks,
/// so a mark that grows at its end (bold) does not spread over the text
/// written after it.
pub(crate) fn write_runs(text: &LoroText, at: usize, runs: &[(String, Vec<(String, LoroValue)>)]) {
    let joined: String = runs.iter().map(|(t, _)| t.as_str()).collect();
    if joined.is_empty() {
        return;
    }
    text.insert(at, &joined).expect("insert text");
    let mut pos = at;
    for (insert, marks) in runs {
        let len = insert.chars().count();
        for (key, value) in marks {
            text.mark(pos..pos + len, key, value.clone()).expect("mark");
        }
        pos += len;
    }
}

/// Writes `snap` as child `index` of `parent`.
pub fn materialize(parent: &LoroMap, index: usize, snap: &NodeSnap) -> LoroMap {
    materialize_in(&tree::children(parent), index, snap)
}

fn materialize_in(list: &LoroList, index: usize, snap: &NodeSnap) -> LoroMap {
    let node = list
        .insert_container(index, LoroMap::new())
        .expect("insert node");
    node.insert(NODE_NAME_KEY, snap.name.as_str())
        .expect("nodeName");
    let attrs = tree::attrs(&node);
    for (key, value) in &snap.attrs {
        attrs.insert(key, value.clone()).expect("attribute");
    }
    let kids = tree::children(&node);
    for child in &snap.children {
        match child {
            ChildSnap::Node(n) => {
                materialize_in(&kids, kids.len(), n);
            }
            ChildSnap::Text(runs) => {
                let text = kids
                    .insert_container(kids.len(), LoroText::new())
                    .expect("text");
                write_runs(&text, 0, runs);
            }
        }
    }
    node
}

/// Moves `node` (a child of `from`) to child `index` of `to`. Returns the copy.
pub fn move_node(node: &LoroMap, from: &LoroMap, to: &LoroMap, index: usize) -> LoroMap {
    let snap = snapshot(node);
    let copy = materialize(to, index, &snap);
    if let Some(i) = tree::index_in(from, node) {
        tree::children(from)
            .delete(i, 1)
            .expect("delete moved node");
    }
    copy
}

pub fn list_name(kind: ListKind) -> &'static str {
    match kind {
        ListKind::Bullet => "bulletList",
        ListKind::Ordered => "orderedList",
        ListKind::Task => "taskList",
    }
}

fn item_name_for(list: &str) -> &'static str {
    if list == "taskList" {
        "taskItem"
    } else {
        "listItem"
    }
}

/// The leaf with `block_id` (or view key), wherever it is now.
pub fn find(doc: &loro::LoroDoc, id: &str) -> Option<Located> {
    tree::flatten(doc)
        .into_iter()
        .find(|(_, v)| (!v.block_id.is_empty() && v.block_id == id) || v.key == id)
        .map(|(l, _)| l)
}

/// `(item, list, list's parent)` around a list line, if it is one.
fn list_context(located: &Located) -> Option<(LoroMap, LoroMap, LoroMap)> {
    let n = located.ancestors.len();
    if n < 3 || !is_item_type(&tree::node_name(&located.ancestors[n - 1])) {
        return None;
    }
    Some((
        located.ancestors[n - 1].clone(),
        located.ancestors[n - 2].clone(),
        located.ancestors[n - 3].clone(),
    ))
}

fn child_at(parent: &LoroMap, index: usize) -> Option<LoroMap> {
    match tree::children(parent).get(index) {
        Some(ValueOrContainer::Container(loro::Container::Map(m))) => Some(m),
        _ => None,
    }
}

/// Makes the item holding `located` a child of the item before it.
pub fn indent(located: &Located) -> bool {
    let Some((item, list, _)) = list_context(located) else {
        return false;
    };
    let Some(index) = tree::index_in(&list, &item) else {
        return false;
    };
    if index == 0 {
        return false;
    }
    let Some(previous) = child_at(&list, index - 1) else {
        return false;
    };
    let name = tree::node_name(&list);
    let nested = match tree::child_maps(&previous).last() {
        Some(last) if tree::node_name(last) == name => last.clone(),
        _ => {
            let kids = tree::children(&previous);
            let nested = kids
                .insert_container(kids.len(), LoroMap::new())
                .expect("nested list");
            nested
                .insert(NODE_NAME_KEY, name.as_str())
                .expect("nodeName");
            tree::attrs(&nested);
            tree::children(&nested);
            nested
        }
    };
    let end = tree::children(&nested).len();
    move_node(&item, &list, &nested, end);
    true
}

/// Lifts the item holding `located` one level: into the parent list, or out
/// of the list altogether. Items after it come along (as its children, or as
/// a new list after it), so reading order never changes.
pub fn outdent(located: &Located) -> bool {
    let Some((item, list, parent)) = list_context(located) else {
        return false;
    };
    let Some(index) = tree::index_in(&list, &item) else {
        return false;
    };
    let name = tree::node_name(&list);
    let trailing: Vec<LoroMap> = (index + 1..tree::children(&list).len())
        .filter_map(|i| child_at(&list, i))
        .collect();

    if is_item_type(&tree::node_name(&parent)) {
        // A nested list: the item joins the outer list right after its parent item.
        let outer = located.ancestors[located.ancestors.len() - 4].clone();
        let at = tree::index_in(&outer, &parent).map_or(0, |i| i + 1);
        let moved = move_node(&item, &list, &outer, at);
        if !trailing.is_empty() {
            let kids = tree::children(&moved);
            let nested = kids
                .insert_container(kids.len(), LoroMap::new())
                .expect("nested");
            nested
                .insert(NODE_NAME_KEY, name.as_str())
                .expect("nodeName");
            tree::attrs(&nested);
            for t in &trailing {
                let end = tree::children(&nested).len();
                move_node(t, &list, &nested, end);
            }
        }
        remove_if_empty(&list, &parent);
        return true;
    }

    // A top-level list: the item's content becomes blocks after the list, and
    // the items after it a new list after those.
    let mut at = tree::index_in(&parent, &list).map_or(0, |i| i + 1);
    let snap = snapshot(&item);
    for child in &snap.children {
        if let ChildSnap::Node(n) = child {
            materialize(&parent, at, n);
            at += 1;
        }
    }
    tree::children(&list)
        .delete(index, 1)
        .expect("delete lifted item");
    if !trailing.is_empty() {
        let rest = tree::children(&parent)
            .insert_container(at, LoroMap::new())
            .expect("list");
        rest.insert(NODE_NAME_KEY, name.as_str()).expect("nodeName");
        tree::attrs(&rest);
        for t in &trailing {
            let end = tree::children(&rest).len();
            move_node(t, &list, &rest, end);
        }
    }
    remove_if_empty(&list, &parent);
    true
}

fn remove_if_empty(container: &LoroMap, parent: &LoroMap) {
    if tree::child_maps(container).is_empty()
        && let Some(i) = tree::index_in(parent, container)
    {
        tree::children(parent)
            .delete(i, 1)
            .expect("delete empty container");
    }
}

/// Turns the list holding `located` into a `kind` list (items follow).
pub fn set_list_kind(located: &Located, kind: ListKind) -> bool {
    let Some((_, list, _)) = list_context(located) else {
        return false;
    };
    let name = list_name(kind);
    if tree::node_name(&list) == name {
        return false;
    }
    list.insert(NODE_NAME_KEY, name).expect("nodeName");
    for item in tree::child_maps(&list) {
        item.insert(NODE_NAME_KEY, item_name_for(name))
            .expect("item nodeName");
        let attrs = tree::attrs(&item);
        if kind == ListKind::Task {
            if attrs.get("checked").is_none() {
                attrs.insert("checked", false).expect("checked");
            }
        } else if attrs.get("checked").is_some() {
            attrs.delete("checked").expect("clear checked");
        }
    }
    true
}

/// Wraps sibling blocks (in order, same parent, none in a list) into a `kind`
/// list, joining a list of that kind right before them.
pub fn wrap_in_list(blocks: &[Located], kind: ListKind) -> bool {
    let Some(first) = blocks.first() else {
        return false;
    };
    let parent = first.parent().clone();
    let Some(first_index) = tree::index_in(&parent, &first.node) else {
        return false;
    };
    let name = list_name(kind);
    let list = match first_index
        .checked_sub(1)
        .and_then(|i| child_at(&parent, i))
    {
        Some(prev) if tree::node_name(&prev) == name => prev,
        _ => {
            let list = tree::children(&parent)
                .insert_container(first_index, LoroMap::new())
                .expect("list");
            list.insert(NODE_NAME_KEY, name).expect("nodeName");
            tree::attrs(&list);
            tree::children(&list);
            list
        }
    };
    for block in blocks {
        let items = tree::children(&list);
        let item = items
            .insert_container(items.len(), LoroMap::new())
            .expect("item");
        item.insert(NODE_NAME_KEY, item_name_for(name))
            .expect("item nodeName");
        let attrs = tree::attrs(&item);
        attrs
            .insert(BLOCK_ID_ATTR, new_block_id())
            .expect("blockId");
        if kind == ListKind::Task {
            attrs.insert("checked", false).expect("checked");
        }
        let moved = move_node(&block.node, block.parent(), &item, 0);
        // A list line is always a paragraph.
        tree::set_kind(&moved, BlockKind::Paragraph);
    }
    true
}

/// Ticks or unticks the task item holding `located`.
pub fn set_checked(located: &Located, checked: bool) -> bool {
    let Some((item, _, _)) = list_context(located) else {
        return false;
    };
    if tree::node_name(&item) != "taskItem" {
        return false;
    }
    tree::attrs(&item)
        .insert("checked", checked)
        .expect("checked");
    true
}

/// Whether Enter in this list line must also carry nested content along.
pub fn has_content_after(located: &Located) -> bool {
    let Some((item, _, _)) = list_context(located) else {
        return false;
    };
    tree::index_in(&item, &located.node).is_some_and(|i| i + 1 < tree::children(&item).len())
}

/// Enter at `at` (UTF-16) in a list line with nested content after it (a
/// sub-list): a new item follows, holding the rest of the line and taking
/// that content along, as ProseMirror's `splitListItem` does. Returns the new
/// line's `blockId`.
pub fn split_item_with_children(line: &Located, at: usize) -> Option<String> {
    let (item, list, _) = list_context(line)?;
    let index = tree::index_in(&item, &line.node)?;
    let following: Vec<LoroMap> = (index + 1..tree::children(&item).len())
        .filter_map(|i| child_at(&item, i))
        .collect();
    if following.is_empty() {
        return None;
    }
    let text = tree::ensure_text(&line.node);
    let len = text.len_utf16();
    let current = text.to_string();
    // Never split inside a surrogate pair.
    let at = crate::utf16::from_utf8(&current, crate::utf16::to_utf8(&current, at.min(len)));
    let tail = runs_after(&text_runs(&text), at);
    if at < len {
        text.delete_utf16(at, len - at).expect("cut tail");
    }

    let item_at = tree::index_in(&list, &item).map_or(0, |i| i + 1);
    let (new_item, paragraph) = tree::create_item(&list, item_at, &tree::node_name(&item));
    write_runs(&tree::ensure_text(&paragraph), 0, &tail);
    for f in &following {
        let end = tree::children(&new_item).len();
        move_node(f, &item, &new_item, end);
    }
    Some(tree::block_id(&paragraph))
}

/// The runs from UTF-16 offset `at` on.
pub(crate) fn runs_after(
    runs: &[(String, Vec<(String, LoroValue)>)],
    at: usize,
) -> Vec<(String, Vec<(String, LoroValue)>)> {
    let mut out = Vec::new();
    let mut offset = 0;
    for (text, marks) in runs {
        let len = text.encode_utf16().count();
        if offset + len > at {
            let skip = at.saturating_sub(offset);
            let byte = crate::utf16::to_utf8(text, skip);
            out.push((text[byte..].to_owned(), marks.clone()));
        }
        offset += len;
    }
    out
}

/// An item whose first line was deleted while sub-lists (or other lines)
/// remain cannot be loaded by Tiptap. Its children take its place in `list`,
/// in reading order: sub-list items move up a level, other blocks get an
/// item each. Returns whether anything moved.
pub fn repair_headless_item(item: &LoroMap, list: &LoroMap) -> bool {
    let kids = tree::child_maps(item);
    if kids.is_empty() || tree::node_name(&kids[0]) == "paragraph" {
        return false;
    }
    let Some(index) = tree::index_in(list, item) else {
        return false;
    };
    let item_name = item_name_for(&tree::node_name(list));
    let mut at = index + 1;
    for child in &kids {
        if is_list_type(&tree::node_name(child)) {
            for sub in tree::child_maps(child) {
                let moved = move_node(&sub, child, list, at);
                moved
                    .insert(NODE_NAME_KEY, item_name)
                    .expect("item nodeName");
                at += 1;
            }
        } else {
            let holder = tree::children(list)
                .insert_container(at, LoroMap::new())
                .expect("item");
            holder
                .insert(NODE_NAME_KEY, item_name)
                .expect("item nodeName");
            tree::attrs(&holder)
                .insert(BLOCK_ID_ATTR, new_block_id())
                .expect("blockId");
            let moved = move_node(child, item, &holder, 0);
            tree::set_kind(&moved, BlockKind::Paragraph);
            at += 1;
        }
    }
    if let Some(i) = tree::index_in(list, item) {
        tree::children(list)
            .delete(i, 1)
            .expect("delete headless item");
    }
    true
}

/// Removes list containers and items left empty, keeps at least one block,
/// and gives a fresh `blockId` to the later of two blocks sharing one.
/// Concurrent edits can produce these (two people each delete a different
/// last item of the same list; both move the same block, each leaving a
/// copy); neither side's own edit could. Both sides may run this at once:
/// deleting an empty container is idempotent, and the two new ids for the
/// same duplicate settle by last-writer-wins. Returns whether anything
/// changed.
pub fn normalize(doc: &loro::LoroDoc) -> bool {
    fn dedupe(node: &LoroMap, seen: &mut std::collections::HashSet<String>) -> bool {
        let mut changed = false;
        for child in tree::child_maps(node) {
            let id = tree::block_id(&child);
            if !id.is_empty() && !seen.insert(id) {
                tree::attrs(&child)
                    .insert(BLOCK_ID_ATTR, new_block_id())
                    .expect("fresh blockId");
                changed = true;
            }
            changed |= dedupe(&child, seen);
        }
        changed
    }
    fn sweep(node: &LoroMap) -> bool {
        let mut changed = false;
        for child in tree::child_maps(node) {
            changed |= sweep(&child);
            let name = tree::node_name(&child);
            if (is_list_type(&name) || is_item_type(&name) || name == "blockquote")
                && tree::child_maps(&child).is_empty()
                && let Some(i) = tree::index_in(node, &child)
            {
                tree::children(node)
                    .delete(i, 1)
                    .expect("delete empty container");
                changed = true;
            }
        }
        changed
    }
    let root = tree::root(doc);
    let mut changed = sweep(&root);
    changed |= dedupe(&root, &mut Default::default());
    if tree::flatten(doc).is_empty() {
        tree::create_textblock(&root, 0, BlockKind::Paragraph);
        changed = true;
    }
    changed
}

/// Pastes `nodes` into the line `line` at UTF-16 offset `at`: the line is
/// split there and the nodes go between its halves; a half left empty is
/// dropped. Returns the `blockId` of the last pasted line.
pub fn paste_blocks(line: &Located, at: usize, nodes: &[NodeSnap]) -> Option<String> {
    let parent = line.parent().clone();
    // Only top-level lines take blocks (the caller types into the rest).
    if tree::node_name(&parent) != "doc" {
        return None;
    }
    let index = tree::index_in(&parent, &line.node)?;
    let text = tree::ensure_text(&line.node);
    let current = text.to_string();
    let len = text.len_utf16();
    let at = crate::utf16::from_utf8(&current, crate::utf16::to_utf8(&current, at.min(len)));
    let tail = runs_after(&text_runs(&text), at);
    if at < len {
        text.delete_utf16(at, len - at).expect("cut tail");
    }
    let mut pos = index + 1;
    let mut last = None;
    for snap in nodes {
        let node = materialize(&parent, pos, snap);
        last = last_leaf(&node).map(|leaf| tree::block_id(&leaf));
        pos += 1;
    }
    if !tail.is_empty() {
        let rest = tree::create_textblock(&parent, pos, BlockKind::Paragraph);
        write_runs(&tree::ensure_text(&rest), 0, &tail);
    }
    if text.len_utf16() == 0 && !nodes.is_empty() {
        tree::children(&parent)
            .delete(index, 1)
            .expect("drop empty head");
    }
    last
}

/// The last leaf block inside `node` (or `node` itself).
fn last_leaf(node: &LoroMap) -> Option<LoroMap> {
    let name = tree::node_name(node);
    if !is_container_type(&name) {
        return Some(node.clone());
    }
    tree::child_maps(node).iter().rev().find_map(last_leaf)
}
