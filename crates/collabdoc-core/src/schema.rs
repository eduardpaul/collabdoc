//! Names shared with the TypeScript core (`src/shared/constants.ts`).
//!
//! The Loro layout is the one `loro-prosemirror` reads, so a document written
//! here opens in the Electron build and the other way round. Change nothing in
//! this file without changing the TypeScript side too.

use loro::{ExpandType, StyleConfig, StyleConfigMap};

pub const ROOT_DOC_KEY: &str = "doc";
pub const ATTRIBUTES_KEY: &str = "attributes";
pub const CHILDREN_KEY: &str = "children";
pub const NODE_NAME_KEY: &str = "nodeName";
pub const META_KEY: &str = "meta";

pub const BLOCK_ID_ATTR: &str = "blockId";
pub const SCHEMA_VERSION: i64 = 1;

/// Loro merges consecutive commits stamped within this many units (ms here).
pub const CHANGE_MERGE_INTERVAL: i64 = 1;
/// Human typing is one history/undo entry until 1 s idle or a block switch (05).
pub const HUMAN_COMMIT_IDLE_MS: i64 = 1_000;
/// Undo steps are cut by the editor; this is only a ceiling (06).
pub const UNDO_STEP_MAX_MS: i64 = 60 * 60 * 1000;
pub const UNDO_MAX_STEPS: usize = 200;

pub const ACTOR_ORIGIN_PREFIX: &str = "actor:";
pub const SYSTEM_ORIGIN_PREFIX: &str = "sys:";
pub const INIT_ORIGIN: &str = "sys:init";

pub const HEADING_LEVELS: std::ops::RangeInclusive<u8> = 1..=4;

/// Node types whose children are blocks.
pub const BLOCK_CONTAINER_TYPES: &[&str] = &[
    "blockquote",
    "listItem",
    "taskItem",
    "bulletList",
    "orderedList",
    "taskList",
];

/// Leaf blocks with no editable text of their own (captions aside).
pub const ATOM_BLOCK_TYPES: &[&str] = &[
    "horizontalRule",
    "imageFigure",
    "mermaidFigure",
    "infographicFigure",
];

/// Marks, in the bit order the editor uses for its mark masks.
pub const MARKS: &[&str] = &[
    "bold",
    "italic",
    "underline",
    "strike",
    "code",
    "link",
    "highlight",
    "superscript",
    "subscript",
];

pub fn mark_bit(name: &str) -> Option<u32> {
    MARKS.iter().position(|m| *m == name).map(|i| 1 << i)
}

pub const LINK_BIT: u32 = 1 << 5;

/// Same table as `TEXT_STYLE_CONFIG`: how a mark grows when typing at its edge.
pub fn text_style_config() -> StyleConfigMap {
    let mut map = StyleConfigMap::new();
    for name in MARKS {
        let expand = match *name {
            "bold" | "italic" | "underline" | "strike" | "link" => ExpandType::After,
            _ => ExpandType::None,
        };
        map.insert((*name).into(), StyleConfig { expand });
    }
    map
}

pub fn is_container_type(name: &str) -> bool {
    BLOCK_CONTAINER_TYPES.contains(&name)
}

pub fn is_atom_type(name: &str) -> bool {
    ATOM_BLOCK_TYPES.contains(&name)
}

pub fn is_list_type(name: &str) -> bool {
    matches!(name, "bulletList" | "orderedList" | "taskList")
}

pub fn is_item_type(name: &str) -> bool {
    matches!(name, "listItem" | "taskItem")
}
