//! Reading and shaping the `loro-prosemirror` tree (`src/core/tree.ts`).

use loro::{
    Container, ContainerTrait, LoroDoc, LoroList, LoroMap, LoroText, LoroValue, ValueOrContainer,
};

use crate::ids::new_block_id;
use crate::model::{BlockKind, ListKind, Span, ViewBlock};
use crate::schema::*;
use crate::utf16;

pub fn root(doc: &LoroDoc) -> LoroMap {
    doc.get_map(ROOT_DOC_KEY)
}

/// The node's `attributes` map, created when missing. Like the TS core's
/// `getOrCreateContainer`, a created child is a regular (op-id) container.
pub fn attrs(node: &LoroMap) -> LoroMap {
    match node.get(ATTRIBUTES_KEY) {
        Some(ValueOrContainer::Container(Container::Map(m))) => m,
        _ => node
            .insert_container(ATTRIBUTES_KEY, LoroMap::new())
            .expect("attributes is a map"),
    }
}

pub fn children(node: &LoroMap) -> LoroList {
    match node.get(CHILDREN_KEY) {
        Some(ValueOrContainer::Container(Container::List(l))) => l,
        _ => node
            .insert_container(CHILDREN_KEY, LoroList::new())
            .expect("children is a list"),
    }
}

fn value_string(v: Option<ValueOrContainer>) -> Option<String> {
    match v {
        Some(ValueOrContainer::Value(LoroValue::String(s))) => Some(s.to_string()),
        _ => None,
    }
}

fn value_number(v: Option<ValueOrContainer>) -> Option<f64> {
    match v {
        Some(ValueOrContainer::Value(LoroValue::Double(n))) => Some(n),
        Some(ValueOrContainer::Value(LoroValue::I64(n))) => Some(n as f64),
        _ => None,
    }
}

fn value_bool(v: Option<ValueOrContainer>) -> Option<bool> {
    match v {
        Some(ValueOrContainer::Value(LoroValue::Bool(b))) => Some(b),
        _ => None,
    }
}

pub fn node_name(node: &LoroMap) -> String {
    value_string(node.get(NODE_NAME_KEY)).unwrap_or_default()
}

pub fn block_id(node: &LoroMap) -> String {
    match node.get(ATTRIBUTES_KEY) {
        Some(ValueOrContainer::Container(Container::Map(a))) => {
            value_string(a.get(BLOCK_ID_ATTR)).unwrap_or_default()
        }
        _ => String::new(),
    }
}

fn attr_number(node: &LoroMap, key: &str) -> Option<f64> {
    match node.get(ATTRIBUTES_KEY) {
        Some(ValueOrContainer::Container(Container::Map(a))) => value_number(a.get(key)),
        _ => None,
    }
}

fn attr_bool(node: &LoroMap, key: &str) -> Option<bool> {
    match node.get(ATTRIBUTES_KEY) {
        Some(ValueOrContainer::Container(Container::Map(a))) => value_bool(a.get(key)),
        _ => None,
    }
}

/// Child containers of `node`'s `children` list, in order.
pub fn child_items(node: &LoroMap) -> Vec<Container> {
    let Some(ValueOrContainer::Container(Container::List(list))) = node.get(CHILDREN_KEY) else {
        return vec![];
    };
    (0..list.len())
        .filter_map(|i| match list.get(i) {
            Some(ValueOrContainer::Container(c)) => Some(c),
            _ => None,
        })
        .collect()
}

pub fn child_maps(node: &LoroMap) -> Vec<LoroMap> {
    child_items(node)
        .into_iter()
        .filter_map(|c| match c {
            Container::Map(m) => Some(m),
            _ => None,
        })
        .collect()
}

/// Index of the child container `id` in `parent`'s children, if still there.
pub fn index_in(parent: &LoroMap, child: &LoroMap) -> Option<usize> {
    let list = children(parent);
    let id = child.id();
    (0..list.len()).find(|&i| match list.get(i) {
        Some(ValueOrContainer::Container(c)) => c.id() == id,
        _ => false,
    })
}

/// The editable text of a textblock: its only child, a `LoroText`, or none yet.
/// `None` when the block also holds inline nodes (mentions, hard breaks).
pub fn sole_text(node: &LoroMap) -> Option<Option<LoroText>> {
    let items = child_items(node);
    match items.as_slice() {
        [] => Some(None),
        [Container::Text(t)] => Some(Some(t.clone())),
        _ => None,
    }
}

pub fn ensure_text(node: &LoroMap) -> LoroText {
    if let Some(Some(t)) = sole_text(node) {
        return t;
    }
    for item in child_items(node) {
        if let Container::Text(t) = item {
            return t;
        }
    }
    children(node)
        .insert_container(0, LoroText::new())
        .expect("insert text")
}

/// Visible text of a textblock with inline nodes, for read-only display.
fn mixed_plain_text(node: &LoroMap) -> String {
    let mut out = String::new();
    for item in child_items(node) {
        match item {
            Container::Text(t) => out.push_str(&t.to_string()),
            Container::Map(m) => match node_name(&m).as_str() {
                "mention" => {
                    let a = attrs(&m);
                    let handle =
                        value_string(a.get("handle")).or_else(|| value_string(a.get("label")));
                    if let Some(h) = handle {
                        out.push('@');
                        out.push_str(&h);
                    }
                }
                "hardBreak" => out.push('\n'),
                _ => {}
            },
            _ => {}
        }
    }
    out
}

pub fn text_spans(text: &LoroText) -> Vec<Span> {
    let mut spans = Vec::new();
    let mut offset = 0u32;
    for delta in text.to_delta() {
        let loro::TextDelta::Insert { insert, attributes } = delta else {
            continue;
        };
        let len = utf16::len(&insert) as u32;
        if let Some(attrs) = attributes {
            let mut marks = 0;
            let mut href = String::new();
            for (key, value) in attrs.iter() {
                if matches!(value, LoroValue::Null) {
                    continue;
                }
                let Some(bit) = mark_bit(key) else { continue };
                marks |= bit;
                if bit == LINK_BIT
                    && let LoroValue::Map(m) = value
                    && let Some(LoroValue::String(h)) = m.get("href")
                {
                    href = h.to_string();
                }
            }
            if marks != 0 {
                spans.push(Span {
                    start: offset,
                    end: offset + len,
                    marks,
                    href,
                });
            }
        }
        offset += len;
    }
    crate::model::normalize_spans(offset as usize, &spans)
}

/// A leaf block with the containers around it, outermost first.
#[derive(Clone)]
pub struct Located {
    pub node: LoroMap,
    pub ancestors: Vec<LoroMap>,
}

impl Located {
    pub fn parent(&self) -> &LoroMap {
        self.ancestors
            .last()
            .expect("leaf blocks always have a parent")
    }
}

fn kind_of(node: &LoroMap, name: &str) -> BlockKind {
    match name {
        "heading" => {
            let level = attr_number(node, "level").unwrap_or(1.0) as u8;
            BlockKind::Heading(level.clamp(*HEADING_LEVELS.start(), *HEADING_LEVELS.end()))
        }
        "codeBlock" => BlockKind::CodeBlock,
        n if is_atom_type(n) => BlockKind::Atom,
        _ => BlockKind::Paragraph,
    }
}

fn atom_label(node: &LoroMap, name: &str) -> String {
    let caption = sole_text(node)
        .flatten()
        .map(|t| t.to_string())
        .unwrap_or_default();
    let label = match name {
        "horizontalRule" => return "───".to_owned(),
        "imageFigure" => "Image",
        "mermaidFigure" => "Mermaid diagram",
        "infographicFigure" => "Infographic",
        other => other,
    };
    if caption.is_empty() {
        format!("[{label}]")
    } else {
        format!("[{label}: {caption}]")
    }
}

/// Every leaf block in reading order, with its view.
pub fn flatten(doc: &LoroDoc) -> Vec<(Located, ViewBlock)> {
    let mut out = Vec::new();
    let mut stack = vec![root(doc)];
    walk(&mut stack, &mut out);
    out
}

fn walk(stack: &mut Vec<LoroMap>, out: &mut Vec<(Located, ViewBlock)>) {
    let parent = stack.last().unwrap().clone();
    for child in child_maps(&parent) {
        let name = node_name(&child);
        if is_container_type(&name) {
            stack.push(child);
            walk(stack, out);
            stack.pop();
            continue;
        }
        if name == "mention" || name == "hardBreak" || name.is_empty() {
            continue;
        }
        let located = Located {
            node: child.clone(),
            ancestors: stack.clone(),
        };
        out.push((located, view_of(&child, &name, stack)));
    }
}

/// The view of one located leaf, read fresh from Loro.
pub fn located_view(located: &Located) -> ViewBlock {
    view_of(&located.node, &node_name(&located.node), &located.ancestors)
}

fn view_of(node: &LoroMap, name: &str, ancestors: &[LoroMap]) -> ViewBlock {
    let kind = kind_of(node, name);
    let mut list = None;
    let mut list_depth = 0u8;
    let mut quote_depth = 0u8;
    let mut checked = false;
    for a in ancestors {
        match node_name(a).as_str() {
            "bulletList" => (list, list_depth) = (Some(ListKind::Bullet), list_depth + 1),
            "orderedList" => (list, list_depth) = (Some(ListKind::Ordered), list_depth + 1),
            "taskList" => (list, list_depth) = (Some(ListKind::Task), list_depth + 1),
            "taskItem" => checked = attr_bool(a, "checked").unwrap_or(false),
            "blockquote" => quote_depth += 1,
            _ => {}
        }
    }
    let (editable, text, spans) = if kind == BlockKind::Atom {
        (false, atom_label(node, name), vec![])
    } else {
        match sole_text(node) {
            Some(Some(t)) => (true, t.to_string(), text_spans(&t)),
            Some(None) => (true, String::new(), vec![]),
            None => (false, mixed_plain_text(node), vec![]),
        }
    };
    ViewBlock {
        key: node.id().to_string(),
        block_id: block_id(node),
        kind,
        node_name: name.to_owned(),
        list,
        list_depth,
        quote_depth,
        checked,
        editable,
        text,
        spans,
    }
}

/// Creates a textblock with a fresh `blockId` and an empty text child.
pub fn create_textblock(parent: &LoroMap, index: usize, kind: BlockKind) -> LoroMap {
    let node = children(parent)
        .insert_container(index, LoroMap::new())
        .expect("insert block");
    set_kind(&node, kind);
    attrs(&node)
        .insert(BLOCK_ID_ATTR, new_block_id())
        .expect("set blockId");
    children(&node)
        .insert_container(0, LoroText::new())
        .expect("insert text");
    node
}

/// Creates an `item_name` list item holding one empty paragraph: `(item, paragraph)`.
pub fn create_item(list: &LoroMap, index: usize, item_name: &str) -> (LoroMap, LoroMap) {
    let item = children(list)
        .insert_container(index, LoroMap::new())
        .expect("insert item");
    item.insert(NODE_NAME_KEY, item_name).expect("set nodeName");
    let a = attrs(&item);
    a.insert(BLOCK_ID_ATTR, new_block_id())
        .expect("set blockId");
    if item_name == "taskItem" {
        a.insert("checked", false).expect("set checked");
    }
    let paragraph = create_textblock(&item, 0, BlockKind::Paragraph);
    (item, paragraph)
}

pub fn set_kind(node: &LoroMap, kind: BlockKind) {
    node.insert(NODE_NAME_KEY, kind.node_name())
        .expect("set nodeName");
    let a = attrs(node);
    match kind {
        BlockKind::Heading(level) => a.insert("level", level as f64).expect("set level"),
        _ => {
            if a.get("level").is_some() {
                a.delete("level").expect("clear level");
            }
        }
    }
}

/// Removes `node` from `ancestors.last()`, then any container left empty.
pub fn delete_leaf(located: &Located) {
    let mut node = located.node.clone();
    for parent in located.ancestors.iter().rev() {
        if let Some(i) = index_in(parent, &node) {
            children(parent).delete(i, 1).expect("delete block");
        }
        let is_root = node_name(parent) == "doc";
        if is_root || !child_maps(parent).is_empty() {
            break;
        }
        node = parent.clone();
    }
}
