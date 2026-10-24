//! What the editor sees: a flat list of leaf blocks in reading order.
//!
//! The Loro tree nests (lists inside items inside lists, quotes); an editor
//! like Qt's `QTextDocument` is a flat run of blocks with formats. A
//! [`ViewBlock`] is one leaf of the tree with enough context (list type and
//! depth, quote depth) to draw it, and [`TargetBlock`] is what the editor hands
//! back after the person typed.

/// A textblock's own type. Lists and quotes are context, not kinds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlockKind {
    Paragraph,
    Heading(u8),
    CodeBlock,
    /// A figure or rule: shown, deletable, not text-editable here.
    Atom,
}

impl BlockKind {
    pub fn node_name(self) -> &'static str {
        match self {
            BlockKind::Paragraph => "paragraph",
            BlockKind::Heading(_) => "heading",
            BlockKind::CodeBlock => "codeBlock",
            BlockKind::Atom => "horizontalRule",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ListKind {
    Bullet,
    Ordered,
    Task,
}

/// A run of text with one set of marks. Offsets are UTF-16 code units.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Span {
    pub start: u32,
    pub end: u32,
    /// Bit `i` set = mark `schema::MARKS[i]`.
    pub marks: u32,
    /// The `link` mark's `href`, when that bit is set.
    pub href: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ViewBlock {
    /// Stable for the block's lifetime in this session (the Loro container id).
    pub key: String,
    /// The `blockId` attribute agents and comments use; may be empty in old files.
    pub block_id: String,
    pub kind: BlockKind,
    /// For atoms: the node type (`mermaidFigure`, …).
    pub node_name: String,
    pub list: Option<ListKind>,
    /// Number of list containers around the block (0 = not in a list).
    pub list_depth: u8,
    pub quote_depth: u8,
    /// For task items: whether it is ticked.
    pub checked: bool,
    /// False for atoms and for textblocks holding inline nodes (mentions, hard
    /// breaks) this editor does not edit yet.
    pub editable: bool,
    /// Code blocks use `\n` between lines.
    pub text: String,
    pub spans: Vec<Span>,
}

/// One block of the editor's content after a local edit.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct TargetBlock {
    /// The [`ViewBlock::key`] this block was rendered from; `None` for a block
    /// the editor created (Enter, paste).
    pub key: Option<String>,
    pub kind: Option<BlockKind>,
    pub text: String,
    pub spans: Vec<Span>,
}

impl TargetBlock {
    pub fn new(key: Option<&str>, kind: BlockKind, text: &str) -> Self {
        Self {
            key: key.map(str::to_owned),
            kind: Some(kind),
            text: text.to_owned(),
            spans: vec![],
        }
    }

    pub fn with_spans(mut self, spans: Vec<Span>) -> Self {
        self.spans = spans;
        self
    }
}

impl From<&ViewBlock> for TargetBlock {
    fn from(view: &ViewBlock) -> Self {
        Self {
            key: Some(view.key.clone()),
            kind: Some(view.kind),
            text: view.text.clone(),
            spans: view.spans.clone(),
        }
    }
}

/// Expands spans into one mark mask (and href) per UTF-16 unit.
pub(crate) fn masks(len: usize, spans: &[Span]) -> (Vec<u32>, Vec<Option<String>>) {
    let mut marks = vec![0u32; len];
    let mut hrefs = vec![None; len];
    for span in spans {
        let end = (span.end as usize).min(len);
        for i in (span.start as usize).min(end)..end {
            marks[i] |= span.marks;
            if span.marks & crate::schema::LINK_BIT != 0 {
                hrefs[i] = Some(span.href.clone());
            }
        }
    }
    (marks, hrefs)
}

/// Merges per-unit masks back into spans (only runs that carry marks).
pub(crate) fn spans_from_masks(marks: &[u32], hrefs: &[Option<String>]) -> Vec<Span> {
    let mut out: Vec<Span> = Vec::new();
    for (i, (&m, h)) in marks.iter().zip(hrefs).enumerate() {
        if m == 0 {
            continue;
        }
        let href = h.clone().unwrap_or_default();
        if let Some(last) = out.last_mut()
            && last.end as usize == i
            && last.marks == m
            && last.href == href
        {
            last.end += 1;
            continue;
        }
        out.push(Span {
            start: i as u32,
            end: i as u32 + 1,
            marks: m,
            href,
        });
    }
    out
}

/// Normalises spans: clipped, merged, unmarked runs dropped.
pub fn normalize_spans(len: usize, spans: &[Span]) -> Vec<Span> {
    let (m, h) = masks(len, spans);
    spans_from_masks(&m, &h)
}
