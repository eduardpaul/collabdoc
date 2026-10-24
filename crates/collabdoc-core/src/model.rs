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

/// The character an inline node (mention, hard break) takes in a block's
/// text: one UTF-16 unit, as Flutter's `WidgetSpan` does.
pub const INLINE_CHAR: char = '\u{FFFC}';
pub const INLINE_UNIT: u16 = 0xFFFC;

/// An inline node inside a textblock, at its [`INLINE_CHAR`].
#[derive(Debug, Clone, PartialEq, Default)]
pub struct InlineNode {
    /// UTF-16 offset in the block's text.
    pub at: u32,
    /// `mention`, `hardBreak`, or a node this editor only keeps.
    pub name: String,
    /// Its ProseMirror attrs (`kind`, `id`, `handle`, `label`… for mentions).
    pub attrs: serde_json::Map<String, serde_json::Value>,
}

impl InlineNode {
    pub fn hard_break() -> Self {
        Self {
            at: 0,
            name: "hardBreak".into(),
            attrs: Default::default(),
        }
    }

    pub fn attr(&self, key: &str) -> &str {
        self.attrs.get(key).and_then(|v| v.as_str()).unwrap_or("")
    }

    /// How it reads as plain text: `@handle` for a mention, a newline for a
    /// hard break.
    pub fn plain_text(&self) -> String {
        match self.name.as_str() {
            "hardBreak" => "\n".into(),
            "mention" => {
                let handle = self.attr("handle");
                format!(
                    "@{}",
                    if handle.is_empty() {
                        self.attr("label")
                    } else {
                        handle
                    }
                )
            }
            _ => String::new(),
        }
    }
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
    /// False for atoms (figures, rules).
    pub editable: bool,
    /// Code blocks use `\n` between lines; each inline node is one
    /// [`INLINE_CHAR`].
    pub text: String,
    pub spans: Vec<Span>,
    /// The inline nodes, in order.
    pub inlines: Vec<InlineNode>,
}

impl ViewBlock {
    /// The inline node at UTF-16 offset `at`, if one is there.
    pub fn inline_at(&self, at: usize) -> Option<&InlineNode> {
        self.inlines.iter().find(|n| n.at as usize == at)
    }

    /// The text with inline nodes spelled out (`@handle`, newlines).
    pub fn plain_text(&self) -> String {
        plain_text(&self.text, &self.inlines)
    }
}

/// `text` with each [`INLINE_CHAR`] that is an inline node spelled out.
pub fn plain_text(text: &str, inlines: &[InlineNode]) -> String {
    if inlines.is_empty() {
        return text.to_owned();
    }
    let mut out = String::with_capacity(text.len());
    let mut at = 0u32;
    for c in text.chars() {
        match inlines.iter().find(|n| n.at == at) {
            Some(node) if c == INLINE_CHAR => out.push_str(&node.plain_text()),
            _ => out.push(c),
        }
        at += c.len_utf16() as u32;
    }
    out
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
    /// One per [`INLINE_CHAR`] in `text` (by `at`); a placeholder without one
    /// is dropped.
    pub inlines: Vec<InlineNode>,
}

impl TargetBlock {
    pub fn new(key: Option<&str>, kind: BlockKind, text: &str) -> Self {
        Self {
            key: key.map(str::to_owned),
            kind: Some(kind),
            text: text.to_owned(),
            spans: vec![],
            inlines: vec![],
        }
    }

    pub fn with_spans(mut self, spans: Vec<Span>) -> Self {
        self.spans = spans;
        self
    }

    pub fn with_inlines(mut self, inlines: Vec<InlineNode>) -> Self {
        self.inlines = inlines;
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
            inlines: view.inlines.clone(),
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

/// Spans as a block stores them: normalised, and none over inline nodes
/// (marks live on text only).
pub fn block_spans(text: &str, inlines: &[InlineNode], spans: &[Span]) -> Vec<Span> {
    let len = crate::utf16::len(text);
    let (mut m, mut h) = masks(len, spans);
    for node in inlines {
        if let Some(i) = m.get_mut(node.at as usize) {
            *i = 0;
            h[node.at as usize] = None;
        }
    }
    spans_from_masks(&m, &h)
}
