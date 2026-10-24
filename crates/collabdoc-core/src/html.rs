//! HTML on the clipboard, beside the Markdown text: copy writes it (so rich
//! paste into browsers, Google Docs or Word keeps headings, lists and marks)
//! and paste reads it, as ProseMirror's clipboard does in the Tiptap app.
//!
//! Out, the tags are Tiptap's (`ul[data-type=taskList]`, `li[data-checked]`,
//! `mark`, `s`, `u`…), so the TS app reads what we copy. In, besides tags,
//! the inline styles other editors use are honoured (Google Docs writes
//! `<span style="font-weight:700">` inside `<b style="font-weight:normal">`).
//! Images wait for asset support; scripts and styles are skipped.

use html5gum::{DefaultEmitter, Token, Tokenizer};
use loro::LoroValue;

use crate::markdown::{Builder, container, mark, node};
use crate::model::{BlockKind, ListKind, ViewBlock, masks};
use crate::schema::*;
use crate::structure::{ChildSnap, NodeSnap};
use crate::utf16;

// ── Out ─────────────────────────────────────────────────────────────────

#[derive(Clone, PartialEq)]
enum Frame {
    Quote,
    List(ListKind),
    Item,
}

/// HTML for a run of blocks in reading order.
pub fn render(blocks: &[ViewBlock]) -> String {
    let mut out = String::from("<meta charset=\"utf-8\">");
    let mut open: Vec<Frame> = Vec::new();
    // The list kind open at each depth, for outer levels of nested lists.
    let mut kinds: Vec<ListKind> = Vec::new();
    for block in blocks {
        let depth = block.list_depth as usize;
        kinds.truncate(depth);
        if let Some(kind) = block.list {
            while kinds.len() < depth {
                kinds.push(kind);
            }
            kinds[depth - 1] = kind;
        }
        let mut path = vec![Frame::Quote; block.quote_depth as usize];
        for kind in &kinds {
            path.push(Frame::List(*kind));
            path.push(Frame::Item);
        }
        // Every list line is an item of its own: its own `<li>` is never shared.
        let keep = open
            .iter()
            .zip(&path)
            .take_while(|(a, b)| a == b)
            .count()
            .min(if block.list.is_some() {
                path.len() - 1
            } else {
                path.len()
            });
        while open.len() > keep {
            out.push_str(match open.pop().unwrap() {
                Frame::Quote => "</blockquote>",
                Frame::List(ListKind::Ordered) => "</ol>",
                Frame::List(_) => "</ul>",
                Frame::Item => "</li>",
            });
        }
        for frame in &path[keep..] {
            out.push_str(&match frame {
                Frame::Quote => "<blockquote>".to_owned(),
                Frame::List(ListKind::Ordered) => "<ol>".to_owned(),
                Frame::List(ListKind::Bullet) => "<ul>".to_owned(),
                Frame::List(ListKind::Task) => "<ul data-type=\"taskList\">".to_owned(),
                Frame::Item if block.list == Some(ListKind::Task) => format!(
                    "<li data-type=\"taskItem\" data-checked=\"{}\">",
                    block.checked
                ),
                Frame::Item => "<li>".to_owned(),
            });
            open.push(frame.clone());
        }
        match block.kind {
            BlockKind::Heading(level) => {
                out.push_str(&format!("<h{level}>{}</h{level}>", inline(block)));
            }
            BlockKind::CodeBlock => {
                out.push_str(&format!("<pre><code>{}</code></pre>", escape(&block.text)));
            }
            BlockKind::Atom => out.push_str(&format!("<p>{}</p>", escape(&block.text))),
            BlockKind::Paragraph => out.push_str(&format!("<p>{}</p>", inline(block))),
        }
    }
    while let Some(frame) = open.pop() {
        out.push_str(match frame {
            Frame::Quote => "</blockquote>",
            Frame::List(ListKind::Ordered) => "</ol>",
            Frame::List(_) => "</ul>",
            Frame::Item => "</li>",
        });
    }
    out
}

fn inline(block: &ViewBlock) -> String {
    let units = utf16::units(&block.text);
    let (marks, hrefs) = masks(units.len(), &block.spans);
    let mut out = String::new();
    let mut start = 0;
    while start < units.len() {
        let m = marks[start];
        let mut end = start + 1;
        while end < units.len() && marks[end] == m && hrefs[end] == hrefs[start] {
            end += 1;
        }
        let mut run = escape(&String::from_utf16_lossy(&units[start..end]));
        let has = |name: &str| mark_bit(name).is_some_and(|b| m & b != 0);
        for (name, tag) in [
            ("code", "code"),
            ("bold", "strong"),
            ("italic", "em"),
            ("strike", "s"),
            ("highlight", "mark"),
            ("underline", "u"),
            ("superscript", "sup"),
            ("subscript", "sub"),
        ] {
            if has(name) {
                run = format!("<{tag}>{run}</{tag}>");
            }
        }
        if has("link")
            && let Some(href) = hrefs[start].as_deref().filter(|h| !h.is_empty())
        {
            run = format!("<a href=\"{}\">{run}</a>", escape(href));
        }
        out.push_str(&run);
        start = end;
    }
    out
}

fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            c => out.push(c),
        }
    }
    out
}

// ── In ──────────────────────────────────────────────────────────────────

/// Blocks for clipboard `html`, ready for [`crate::structure::materialize`].
pub fn parse(html: &str) -> Vec<NodeSnap> {
    let mut r = Reader {
        b: Builder::new(false),
        skip: 0,
        pre: 0,
        inline: Vec::new(),
        spaced: Vec::new(),
        open: Default::default(),
    };
    // Script and style bodies are raw text, not markup.
    let mut emitter = DefaultEmitter::default();
    emitter.naively_switch_states(true);
    for Ok(token) in Tokenizer::new_with_emitter(html, emitter) {
        match token {
            Token::StartTag(tag) => {
                let name = String::from_utf8_lossy(&tag.name).to_ascii_lowercase();
                let attr = |key: &str| {
                    tag.attributes
                        .get(key.as_bytes())
                        .map(|v| String::from_utf8_lossy(v).into_owned())
                };
                r.start(&name, &attr);
                if tag.self_closing {
                    r.end(&name);
                }
            }
            Token::EndTag(tag) => {
                let name = String::from_utf8_lossy(&tag.name).to_ascii_lowercase();
                r.end(&name);
            }
            Token::String(text) => r.text(&String::from_utf8_lossy(&text)),
            _ => {}
        }
    }
    r.b.finish()
}

struct Reader {
    b: Builder,
    /// Inside `script`, `style`, `head`…: ignored.
    skip: usize,
    /// Inside `pre`: whitespace is kept.
    pre: usize,
    /// Open inline elements and how many marks each added.
    inline: Vec<(String, usize)>,
    /// Open elements styled `white-space: pre` (code from editors like VS
    /// Code): their spaces are kept, though their lines stay blocks.
    /// Each with how many elements of its name were open, itself included.
    spaced: Vec<(String, usize)>,
    /// Open elements per name.
    open: std::collections::HashMap<String, usize>,
}

const SKIPPED: &[&str] = &["script", "style", "head", "title", "template", "noscript"];
const BLOCKS: &[&str] = &[
    "p",
    "div",
    "section",
    "article",
    "header",
    "footer",
    "main",
    "aside",
    "nav",
    "figure",
    "figcaption",
    "table",
    "thead",
    "tbody",
    "tr",
    "dl",
    "dt",
    "dd",
    "center",
    "address",
];

impl Reader {
    fn start(&mut self, name: &str, attr: &dyn Fn(&str) -> Option<String>) {
        if SKIPPED.contains(&name) {
            self.skip += 1;
            return;
        }
        if self.skip > 0 {
            return;
        }
        let style = attr("style").unwrap_or_default().to_ascii_lowercase();
        let depth = self.open.entry(name.to_owned()).or_default();
        *depth += 1;
        if style.contains("white-space: pre") || style.contains("white-space:pre") {
            self.spaced.push((name.to_owned(), *depth));
        }
        match name {
            _ if BLOCKS.contains(&name) => self.end_textblock(),
            "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
                self.end_textblock();
                let level = f64::from(name.as_bytes()[1] - b'0').min(4.0);
                self.b
                    .stack
                    .push(node("heading", vec![("level".into(), level.into())]));
            }
            "blockquote" => {
                self.end_textblock();
                self.b.stack.push(container("blockquote"));
            }
            "ul" | "ol" => {
                self.end_textblock();
                let task = attr("data-type").as_deref() == Some("taskList");
                self.b.stack.push(container(match (name, task) {
                    (_, true) => "taskList",
                    ("ol", _) => "orderedList",
                    _ => "bulletList",
                }));
            }
            "li" => {
                // A new item ends the one before (`</li>` is optional).
                if self
                    .nearest(&[
                        "listItem",
                        "taskItem",
                        "bulletList",
                        "orderedList",
                        "taskList",
                    ])
                    .is_some_and(|i| is_item_type(&self.b.stack[i].name))
                {
                    self.close_to(&["listItem", "taskItem"]);
                }
                self.end_textblock();
                if !is_list_type(&self.b.top().name.clone()) {
                    self.b.stack.push(container("bulletList"));
                }
                let mut item = container("listItem");
                if let Some(checked) = attr("data-checked") {
                    item.name = "taskItem".into();
                    item.attrs
                        .push(("checked".into(), (checked == "true").into()));
                }
                self.b.stack.push(item);
            }
            "input" if attr("type").as_deref() == Some("checkbox") => {
                if let Some(i) = self.nearest(&["listItem", "taskItem"]) {
                    let item = &mut self.b.stack[i];
                    if item.name == "listItem" {
                        item.name = "taskItem".into();
                        item.attrs
                            .push(("checked".into(), attr("checked").is_some().into()));
                    }
                }
            }
            "pre" => {
                self.end_textblock();
                self.b.stack.push(node("codeBlock", vec![]));
                self.pre += 1;
            }
            "code" if self.pre > 0 => {
                // `<pre><code class="language-x">`: the language, or a diagram.
                let class = attr("class").unwrap_or_default();
                if let Some(lang) = class
                    .split_whitespace()
                    .find_map(|c| c.strip_prefix("language-"))
                {
                    let top = self.b.top();
                    if top.name == "codeBlock" {
                        if lang == "mermaid" {
                            *top = node("mermaidFigure", vec![("source".into(), "".into())]);
                        } else {
                            top.attrs.push(("language".into(), lang.into()));
                        }
                    }
                }
            }
            "br" => {
                if self.pre > 0 {
                    self.b.text("\n");
                } else {
                    // No hard breaks in the model: the line goes on as a new block.
                    self.end_textblock();
                }
            }
            "hr" => {
                self.end_textblock();
                let rule = node("horizontalRule", vec![]);
                self.b.top().children.push(ChildSnap::Node(rule));
            }
            "td" | "th" => self.text(" "),
            _ => {
                let mut added = inline_marks(name, &style, attr);
                let n = added.len();
                self.b.marks.append(&mut added);
                self.inline.push((name.to_owned(), n));
            }
        }
    }

    fn end(&mut self, name: &str) {
        if SKIPPED.contains(&name) {
            self.skip = self.skip.saturating_sub(1);
            return;
        }
        if self.skip > 0 {
            return;
        }
        if let Some(depth) = self.open.get_mut(name).filter(|d| **d > 0) {
            if let Some(i) = self.spaced.iter().rposition(|(n, _)| n == name)
                && self.spaced[i].1 == *depth
            {
                self.spaced.truncate(i);
            }
            *depth -= 1;
        }
        match name {
            _ if BLOCKS.contains(&name) => self.end_textblock(),
            "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => self.end_textblock(),
            "blockquote" => self.close_to(&["blockquote"]),
            "ul" | "ol" => self.close_to(&["bulletList", "orderedList", "taskList"]),
            "li" => self.close_to(&["listItem", "taskItem"]),
            "pre" => {
                if self.pre > 0 {
                    self.pre -= 1;
                    if matches!(self.b.top().name.as_str(), "codeBlock" | "mermaidFigure") {
                        self.b.trim_trailing_newline();
                        self.b.close();
                    }
                }
            }
            "br" | "hr" | "input" | "td" | "th" => {}
            _ => {
                // Close the inline element (and any left open inside it).
                if let Some(i) = self.inline.iter().rposition(|(n, _)| n == name) {
                    for (_, added) in self.inline.drain(i..).collect::<Vec<_>>() {
                        let keep = self.b.marks.len().saturating_sub(added);
                        self.b.marks.truncate(keep);
                    }
                }
            }
        }
    }

    fn text(&mut self, raw: &str) {
        if self.skip > 0 {
            return;
        }
        if self.pre > 0 || !self.spaced.is_empty() {
            // Line breaks inside a spaced block (not `pre`) end the line.
            let raw = if self.pre > 0 {
                raw.to_owned()
            } else {
                raw.replace('\n', "")
            };
            if !raw.is_empty() {
                self.b.text(&raw);
            }
            return;
        }
        // HTML whitespace: runs collapse to one space, none at a block start.
        let mut text = String::with_capacity(raw.len());
        let mut space = false;
        for c in raw.chars() {
            if c.is_ascii_whitespace() {
                space = true;
            } else {
                if space {
                    text.push(' ');
                    space = false;
                }
                text.push(c);
            }
        }
        if space {
            text.push(' ');
        }
        let in_textblock = crate::markdown::is_textblock(&self.b.top().name.clone());
        let at_start = !in_textblock || self.last_char().is_none_or(|c| c == ' ');
        if at_start {
            text = text.trim_start().to_owned();
        }
        if text.is_empty() {
            return;
        }
        // Text straight inside a list belongs to an item.
        if is_list_type(&self.b.top().name.clone()) {
            self.b.stack.push(container("listItem"));
        }
        self.b.text(&text);
    }

    fn last_char(&mut self) -> Option<char> {
        match self.b.top().children.first() {
            Some(ChildSnap::Text(runs)) => runs.last().and_then(|(t, _)| t.chars().last()),
            _ => None,
        }
    }

    /// Ends an open paragraph or heading, without its trailing space.
    fn end_textblock(&mut self) {
        if self.pre > 0 {
            return;
        }
        let top = self.b.top();
        if top.name == "paragraph" || top.name == "heading" {
            if let Some(ChildSnap::Text(runs)) = top.children.first_mut() {
                if let Some((last, _)) = runs.last_mut() {
                    let trimmed = last.trim_end().len();
                    last.truncate(trimmed);
                }
                runs.retain(|(t, _)| !t.is_empty());
            }
            self.b.close();
        }
    }

    /// The innermost open node named one of `names`.
    fn nearest(&self, names: &[&str]) -> Option<usize> {
        self.b
            .stack
            .iter()
            .rposition(|n| names.contains(&n.name.as_str()))
            .filter(|i| *i > 0)
    }

    /// Closes everything up to and including the innermost open `names`.
    fn close_to(&mut self, names: &[&str]) {
        let Some(target) = self.nearest(names) else {
            return;
        };
        while self.b.stack.len() > target {
            self.end_textblock();
            if self.b.stack.len() <= target {
                break;
            }
            let name = self.b.top().name.clone();
            if is_item_type(&name) {
                // An item always starts with a paragraph.
                let first_is_paragraph = matches!(
                    self.b.top().children.first(),
                    Some(ChildSnap::Node(n)) if n.name == "paragraph"
                );
                if !first_is_paragraph {
                    self.b
                        .top()
                        .children
                        .insert(0, ChildSnap::Node(node("paragraph", vec![])));
                }
            } else if is_list_type(&name) {
                self.b.settle_task_list();
            } else if name == "codeBlock" || name == "mermaidFigure" {
                self.pre = self.pre.saturating_sub(1);
            }
            self.b.close();
        }
    }
}

/// Marks an inline element adds, from its tag and its `style`.
fn inline_marks(
    name: &str,
    style: &str,
    attr: &dyn Fn(&str) -> Option<String>,
) -> Vec<(String, LoroValue)> {
    let prop = |key: &str| {
        style.split(';').find_map(|decl| {
            let (k, v) = decl.split_once(':')?;
            (k.trim() == key).then(|| v.trim().to_owned())
        })
    };
    let weight = prop("font-weight");
    let light = weight.as_deref().is_some_and(|w| {
        w == "normal" || w == "lighter" || w.parse::<u32>().is_ok_and(|n| n < 600)
    });
    let heavy = weight
        .as_deref()
        .is_some_and(|w| w == "bold" || w == "bolder" || w.parse::<u32>().is_ok_and(|n| n >= 600));
    let decoration = prop("text-decoration")
        .or_else(|| prop("text-decoration-line"))
        .unwrap_or_default();
    let align = prop("vertical-align").unwrap_or_default();
    let mut marks = Vec::new();
    let mut add = |on: bool, mark_name: &str| {
        if on {
            marks.push(mark(mark_name, None));
        }
    };
    add(heavy || (matches!(name, "b" | "strong") && !light), "bold");
    add(
        matches!(name, "i" | "em") || prop("font-style").as_deref() == Some("italic"),
        "italic",
    );
    add(
        matches!(name, "u" | "ins") || decoration.contains("underline"),
        "underline",
    );
    add(
        matches!(name, "s" | "strike" | "del") || decoration.contains("line-through"),
        "strike",
    );
    add(name == "code" || name == "kbd" || name == "tt", "code");
    add(name == "mark", "highlight");
    add(name == "sup" || align == "super", "superscript");
    add(name == "sub" || align == "sub", "subscript");
    if name == "a"
        && let Some(href) = attr("href").filter(|h| {
            let h = h.trim_start().to_ascii_lowercase();
            !h.is_empty() && !h.starts_with("javascript:")
        })
    {
        marks.push(mark("link", Some(&href)));
    }
    marks
}
