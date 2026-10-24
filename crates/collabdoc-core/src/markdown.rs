//! Markdown in and out: the clipboard format, as in the Tiptap app
//! (`editor/clipboard.ts`: selections copy as Markdown text; pasted text that
//! looks like Markdown becomes blocks). Mark syntax follows
//! `src/core/markdown.ts`: `**bold**`, `*italic*`, `~~strike~~`, `` `code` ``,
//! `==highlight==`, `<u>underline</u>`, `^sup^`, `~sub~`, `[text](href)`.

use std::collections::HashMap;

use loro::LoroValue;
use pulldown_cmark::{CodeBlockKind, Event, HeadingLevel, Options, Parser, Tag, TagEnd};

use crate::ids::new_block_id;
use crate::model::{BlockKind, ListKind, ViewBlock};
use crate::schema::*;
use crate::structure::{ChildSnap, NodeSnap};
use crate::utf16;

/// Same test as `looksLikeMarkdown` in the TS clipboard: a line that starts
/// like a heading, list item, fence, image, quote or task.
pub fn looks_like_markdown(text: &str) -> bool {
    let text = text.trim();
    !text.is_empty()
        && text.lines().any(|line| {
            let digits = line.chars().take_while(char::is_ascii_digit).count();
            let hashes = line.chars().take_while(|c| *c == '#').count();
            (1..=4).contains(&hashes) && line[hashes..].starts_with(char::is_whitespace)
                || line.starts_with(['-', '*', '+']) && line[1..].starts_with(char::is_whitespace)
                || digits > 0
                    && line[digits..].starts_with('.')
                    && line[digits + 1..].starts_with(char::is_whitespace)
                || line.starts_with("```")
                || line.starts_with("![")
                || line.starts_with('>') && line[1..].starts_with(char::is_whitespace)
        })
}

// ── Out ─────────────────────────────────────────────────────────────────

/// Markdown for a run of blocks in reading order (a selection, or a whole
/// document's blocks).
pub fn render(blocks: &[ViewBlock]) -> String {
    let mut out = String::new();
    // Marker width per list depth, for nesting indents; ordinal per depth.
    let mut widths: Vec<usize> = Vec::new();
    let mut counters: Vec<usize> = Vec::new();
    for (i, block) in blocks.iter().enumerate() {
        let depth = block.list_depth as usize;
        widths.truncate(depth.saturating_sub(1));
        counters.truncate(depth);
        while counters.len() < depth {
            counters.push(0);
        }
        let quote = "> ".repeat(block.quote_depth as usize);
        let indent: String = widths.iter().map(|w| " ".repeat(*w)).collect();
        let marker = match block.list {
            Some(kind) => {
                counters[depth - 1] += 1;
                let m = match kind {
                    ListKind::Bullet => "- ".to_owned(),
                    ListKind::Ordered => format!("{}. ", counters[depth - 1]),
                    // `*` keeps a task list after a `-` bullet list (or the other
                    // way round) a separate list in CommonMark.
                    ListKind::Task => format!("* [{}] ", if block.checked { 'x' } else { ' ' }),
                };
                widths.push(if kind == ListKind::Task { 2 } else { m.len() });
                m
            }
            None => String::new(),
        };
        let lead = format!("{quote}{indent}{marker}");
        match block.kind {
            BlockKind::Heading(level) => {
                out.push_str(&format!(
                    "{lead}{} {}",
                    "#".repeat(level as usize),
                    inline(block)
                ));
            }
            BlockKind::CodeBlock => {
                let pad = format!("{quote}{indent}");
                out.push_str(&format!("{lead}```\n"));
                for line in block.text.split('\n') {
                    out.push_str(&format!("{pad}{line}\n"));
                }
                out.push_str(&format!("{pad}```"));
            }
            BlockKind::Atom => out.push_str(&format!("{lead}{}", block.text)),
            BlockKind::Paragraph => out.push_str(&format!("{lead}{}", inline(block))),
        }
        let next_is_item = blocks.get(i + 1).is_some_and(|n| n.list.is_some());
        let tight = block.list.is_some() && next_is_item;
        out.push_str(if i + 1 == blocks.len() {
            ""
        } else if tight {
            "\n"
        } else {
            "\n\n"
        });
    }
    out
}

/// A block's text with its marks written as Markdown.
fn inline(block: &ViewBlock) -> String {
    let units = utf16::units(&block.text);
    let (marks, hrefs) = crate::model::masks(units.len(), &block.spans);
    let mut out = String::new();
    let mut start = 0;
    while start < units.len() {
        let m = marks[start];
        let mut end = start + 1;
        while end < units.len() && marks[end] == m && hrefs[end] == hrefs[start] {
            end += 1;
        }
        let mut run = String::from_utf16_lossy(&units[start..end]);
        let has = |name: &str| mark_bit(name).is_some_and(|b| m & b != 0);
        if has("code") {
            run = format!("`{run}`");
        }
        for (name, open, close) in [
            ("bold", "**", "**"),
            ("italic", "*", "*"),
            ("strike", "~~", "~~"),
            ("highlight", "==", "=="),
            ("underline", "<u>", "</u>"),
            ("superscript", "^", "^"),
            ("subscript", "~", "~"),
        ] {
            if has(name) {
                run = format!("{open}{run}{close}");
            }
        }
        if has("link")
            && let Some(href) = hrefs[start].as_deref().filter(|h| !h.is_empty())
        {
            run = format!("[{run}]({href})");
        }
        out.push_str(&run);
        start = end;
    }
    out
}

// ── In ──────────────────────────────────────────────────────────────────

type Runs = Vec<(String, Vec<(String, LoroValue)>)>;

fn mark(name: &str, href: Option<&str>) -> (String, LoroValue) {
    let mut attrs: HashMap<String, LoroValue> = HashMap::new();
    if let Some(href) = href {
        attrs.insert("href".into(), href.into());
    }
    (name.to_owned(), attrs.into())
}

fn node(name: &str, attrs: Vec<(String, LoroValue)>) -> NodeSnap {
    let mut all = vec![(BLOCK_ID_ATTR.to_owned(), LoroValue::from(new_block_id()))];
    all.extend(attrs);
    let children = if is_container_type(name) || name == "horizontalRule" {
        vec![]
    } else {
        vec![ChildSnap::Text(vec![])]
    };
    NodeSnap {
        name: name.to_owned(),
        attrs: all,
        children,
    }
}

fn container(name: &str) -> NodeSnap {
    // Lists carry no blockId in the TS schema (BLOCK_ID_TYPES).
    if is_list_type(name) {
        return NodeSnap {
            name: name.to_owned(),
            attrs: vec![],
            children: vec![],
        };
    }
    node(name, vec![])
}

fn is_textblock(name: &str) -> bool {
    matches!(
        name,
        "paragraph" | "heading" | "codeBlock" | "mermaidFigure" | "imageFigure"
    )
}

struct Builder {
    /// Open nodes; `stack[0]` is the document.
    stack: Vec<NodeSnap>,
    marks: Vec<(String, LoroValue)>,
}

impl Builder {
    fn top(&mut self) -> &mut NodeSnap {
        self.stack.last_mut().expect("document stays open")
    }

    fn close(&mut self) {
        let done = self.stack.pop().expect("open node");
        self.top().children.push(ChildSnap::Node(done));
    }

    /// Closes an open paragraph left by tight list items or images.
    fn close_textblock(&mut self) {
        if self.stack.len() > 1 && is_textblock(&self.top().name.clone()) {
            self.close();
        }
    }

    /// A list with any task item is a task list; its other items become
    /// unticked tasks (a list holds one item type).
    fn settle_task_list(&mut self) {
        let list = self.top();
        let any_task = list
            .children
            .iter()
            .any(|c| matches!(c, ChildSnap::Node(n) if n.name == "taskItem"));
        if !any_task {
            return;
        }
        list.name = "taskList".into();
        for child in &mut list.children {
            if let ChildSnap::Node(item) = child
                && item.name == "listItem"
            {
                item.name = "taskItem".into();
                item.attrs.push(("checked".into(), false.into()));
            }
        }
    }

    fn trim_trailing_newline(&mut self) {
        if let Some(ChildSnap::Text(runs)) = self.top().children.first_mut()
            && let Some((last, _)) = runs.last_mut()
            && last.ends_with('\n')
        {
            last.pop();
            if last.is_empty() {
                runs.pop();
            }
        }
    }

    fn runs(&mut self) -> &mut Runs {
        if !is_textblock(&self.top().name.clone()) {
            self.stack.push(node("paragraph", vec![]));
        }
        match self.top().children.first_mut() {
            Some(ChildSnap::Text(runs)) => runs,
            _ => unreachable!("textblocks start with their text"),
        }
    }

    fn text(&mut self, text: &str) {
        let name = self.top().name.clone();
        if name == "mermaidFigure" {
            // The source is an attribute; the text child is the caption.
            if let Some((_, LoroValue::String(source))) =
                self.top().attrs.iter_mut().find(|(k, _)| k == "source")
            {
                let joined = format!("{}{text}", source.as_str());
                *source = joined.into();
            }
            return;
        }
        if name == "codeBlock" {
            let runs = self.runs();
            runs.push((text.to_owned(), vec![]));
            return;
        }
        // `==highlight==` is not CommonMark; split it out here.
        let marks = self.marks.clone();
        let mut highlighted = false;
        for (i, piece) in text.split("==").enumerate() {
            if i > 0 {
                highlighted = !highlighted;
            }
            if piece.is_empty() {
                continue;
            }
            let mut m = marks.clone();
            if highlighted {
                m.push(mark("highlight", None));
            }
            self.runs().push((piece.to_owned(), m));
        }
    }
}

/// Blocks for Markdown `text`, ready for [`crate::structure::materialize`].
pub fn parse(text: &str) -> Vec<NodeSnap> {
    let options = Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_TASKLISTS
        | Options::ENABLE_SUPERSCRIPT
        | Options::ENABLE_SUBSCRIPT;
    let mut b = Builder {
        stack: vec![NodeSnap {
            name: "doc".into(),
            attrs: vec![],
            children: vec![],
        }],
        marks: vec![],
    };
    for event in Parser::new_ext(text, options) {
        match event {
            Event::Start(tag) => match tag {
                Tag::Paragraph => {
                    b.close_textblock();
                    b.stack.push(node("paragraph", vec![]));
                }
                Tag::Heading { level, .. } => {
                    b.close_textblock();
                    let n = match level {
                        HeadingLevel::H1 => 1.0,
                        HeadingLevel::H2 => 2.0,
                        HeadingLevel::H3 => 3.0,
                        _ => 4.0,
                    };
                    b.stack
                        .push(node("heading", vec![("level".into(), n.into())]));
                }
                Tag::CodeBlock(kind) => {
                    b.close_textblock();
                    let lang = match kind {
                        CodeBlockKind::Fenced(info) => {
                            info.split_whitespace().next().unwrap_or("").to_owned()
                        }
                        CodeBlockKind::Indented => String::new(),
                    };
                    if lang == "mermaid" {
                        b.stack
                            .push(node("mermaidFigure", vec![("source".into(), "".into())]));
                    } else if lang.is_empty() {
                        b.stack.push(node("codeBlock", vec![]));
                    } else {
                        b.stack
                            .push(node("codeBlock", vec![("language".into(), lang.into())]));
                    }
                }
                Tag::BlockQuote(_) => {
                    b.close_textblock();
                    b.stack.push(container("blockquote"));
                }
                Tag::List(start) => {
                    b.close_textblock();
                    b.stack.push(container(if start.is_some() {
                        "orderedList"
                    } else {
                        "bulletList"
                    }));
                }
                Tag::Item => {
                    b.close_textblock();
                    b.stack.push(container("listItem"));
                }
                Tag::Emphasis => b.marks.push(mark("italic", None)),
                Tag::Strong => b.marks.push(mark("bold", None)),
                Tag::Strikethrough => b.marks.push(mark("strike", None)),
                Tag::Superscript => b.marks.push(mark("superscript", None)),
                Tag::Subscript => b.marks.push(mark("subscript", None)),
                Tag::Link { dest_url, .. } => b.marks.push(mark("link", Some(&dest_url))),
                Tag::Image { dest_url, .. } => {
                    b.close_textblock();
                    b.stack.push(node(
                        "imageFigure",
                        vec![("src".into(), dest_url.to_string().into())],
                    ));
                }
                _ => {}
            },
            Event::End(tag) => match tag {
                TagEnd::CodeBlock => {
                    // The parser keeps the newline before the closing fence.
                    b.trim_trailing_newline();
                    b.close_textblock();
                }
                TagEnd::Paragraph | TagEnd::Heading(_) => b.close_textblock(),
                TagEnd::Image => b.close_textblock(),
                TagEnd::BlockQuote(_) => {
                    b.close_textblock();
                    b.close();
                }
                TagEnd::List(_) => {
                    b.close_textblock();
                    b.settle_task_list();
                    b.close();
                }
                TagEnd::Item => {
                    b.close_textblock();
                    // An item always starts with a paragraph.
                    let first_is_paragraph = matches!(
                        b.top().children.first(),
                        Some(ChildSnap::Node(n)) if n.name == "paragraph"
                    );
                    if !first_is_paragraph {
                        b.top()
                            .children
                            .insert(0, ChildSnap::Node(node("paragraph", vec![])));
                    }
                    b.close();
                }
                TagEnd::Emphasis
                | TagEnd::Strong
                | TagEnd::Strikethrough
                | TagEnd::Superscript
                | TagEnd::Subscript
                | TagEnd::Link => {
                    b.marks.pop();
                }
                _ => {}
            },
            Event::Text(t) => b.text(&t),
            Event::Code(t) => {
                let mut m = b.marks.clone();
                m.push(mark("code", None));
                b.runs().push((t.to_string(), m));
            }
            Event::InlineHtml(html) => match html.trim() {
                "<u>" => b.marks.push(mark("underline", None)),
                "</u>" => {
                    if let Some(i) = b.marks.iter().rposition(|(k, _)| k == "underline") {
                        b.marks.remove(i);
                    }
                }
                other => b.text(other),
            },
            Event::Html(html) => b.text(html.trim_end()),
            Event::SoftBreak | Event::HardBreak => b.text(" "),
            Event::Rule => {
                b.close_textblock();
                let rule = node("horizontalRule", vec![]);
                b.top().children.push(ChildSnap::Node(rule));
            }
            Event::TaskListMarker(checked) => {
                // The innermost item becomes a task; its list follows at its end.
                let n = b.stack.len();
                if n >= 2 && b.stack[n - 1].name == "listItem" {
                    b.stack[n - 1].name = "taskItem".into();
                    b.stack[n - 1]
                        .attrs
                        .push(("checked".into(), checked.into()));
                }
            }
            _ => {}
        }
    }
    while b.stack.len() > 1 {
        b.close_textblock();
        if b.stack.len() > 1 {
            b.close();
        }
    }
    let doc = b.stack.pop().expect("document");
    doc.children
        .into_iter()
        .filter_map(|c| match c {
            ChildSnap::Node(n) => Some(n),
            ChildSnap::Text(_) => None,
        })
        .collect()
}

/// When pasted Markdown is a single paragraph, its runs (to insert inline).
pub fn single_paragraph(nodes: &[NodeSnap]) -> Option<&Runs> {
    match nodes {
        [only] if only.name == "paragraph" => match only.children.first() {
            Some(ChildSnap::Text(runs)) => Some(runs),
            _ => None,
        },
        _ => None,
    }
}
