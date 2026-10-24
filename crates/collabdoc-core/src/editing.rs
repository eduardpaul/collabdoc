//! Editor behaviour without a UI toolkit: selection, typing, Enter/Backspace,
//! marks and block types over a [`Document`].
//!
//! Positions are global UTF-16 offsets into the blocks joined by `\n` — the
//! coordinate space platform text input (IME) speaks. Every edit is phrased as
//! "the blocks should now read like this" and handed to
//! [`Document::reconcile`], so the tree, block identity and undo stay the
//! core's business and a UI only draws [`ViewBlock`]s and forwards input.

use std::ops::Range;

use loro::cursor::{Cursor, Side};
use unicode_segmentation::UnicodeSegmentation;

use crate::document::Document;
use crate::html;
use crate::markdown;
use crate::model::{BlockKind, ListKind, TargetBlock, ViewBlock, masks, spans_from_masks};
use crate::schema::{LINK_BIT, mark_bit};
use crate::structure::NodeSnap;
use crate::utf16;
use loro::LoroValue;

/// Marks that grow when typing at their end (`expand: after`).
fn expand_after_mask() -> u32 {
    ["bold", "italic", "underline", "strike", "link"]
        .iter()
        .filter_map(|m| mark_bit(m))
        .fold(0, |a, b| a | b)
}

/// One block's content as the editor rewrites it.
#[derive(Clone)]
struct Piece {
    key: Option<String>,
    kind: BlockKind,
    units: Vec<u16>,
    marks: Vec<u32>,
    hrefs: Vec<Option<String>>,
}

impl Piece {
    fn of(view: &ViewBlock) -> Self {
        let units = utf16::units(&view.text);
        let (marks, hrefs) = masks(units.len(), &view.spans);
        Self {
            key: Some(view.key.clone()),
            kind: view.kind,
            units,
            marks,
            hrefs,
        }
    }

    fn slice(&self, range: Range<usize>) -> Self {
        Self {
            key: None,
            kind: self.kind,
            units: self.units[range.clone()].to_vec(),
            marks: self.marks[range.clone()].to_vec(),
            hrefs: self.hrefs[range].to_vec(),
        }
    }

    fn append(&mut self, other: &Piece) {
        self.units.extend_from_slice(&other.units);
        self.marks.extend_from_slice(&other.marks);
        self.hrefs.extend_from_slice(&other.hrefs);
    }

    fn push_text(&mut self, text: &str, marks: u32, href: &Option<String>) {
        for u in text.encode_utf16() {
            self.units.push(u);
            self.marks.push(marks);
            self.hrefs.push(if marks & LINK_BIT != 0 {
                href.clone()
            } else {
                None
            });
        }
    }

    fn target(&self) -> TargetBlock {
        TargetBlock {
            key: self.key.clone(),
            kind: Some(self.kind),
            text: String::from_utf16_lossy(&self.units),
            spans: spans_from_masks(&self.marks, &self.hrefs),
        }
    }
}

pub struct Editor {
    doc: Document,
    blocks: Vec<ViewBlock>,
    /// Global offset where each block starts.
    starts: Vec<usize>,
    anchor: usize,
    head: usize,
    /// Marks for the next typed text after a toolbar toggle with no selection.
    stored_marks: Option<u32>,
}

impl Editor {
    pub fn new(doc: Document) -> Self {
        let mut editor = Self {
            doc,
            blocks: vec![],
            starts: vec![],
            anchor: 0,
            head: 0,
            stored_marks: None,
        };
        editor.reload();
        editor
    }

    /// The document, done editing.
    pub fn into_document(self) -> Document {
        self.doc
    }

    pub fn document(&self) -> &Document {
        &self.doc
    }

    pub fn blocks(&self) -> &[ViewBlock] {
        &self.blocks
    }

    pub fn block_start(&self, index: usize) -> usize {
        self.starts[index]
    }

    fn block_len(&self, index: usize) -> usize {
        utf16::len(&self.blocks[index].text)
    }

    /// Total length of the joined text.
    pub fn len(&self) -> usize {
        let last = self.blocks.len() - 1;
        self.starts[last] + self.block_len(last)
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Re-reads the blocks (after a remote change, undo, open).
    fn reload(&mut self) {
        self.blocks = self.doc.blocks();
        self.starts.clear();
        let mut at = 0;
        for block in &self.blocks {
            self.starts.push(at);
            at += utf16::len(&block.text) + 1;
        }
        self.anchor = self.snap(self.anchor);
        self.head = self.snap(self.head);
    }

    /// `(block index, offset in block)` of a global offset.
    pub fn locate(&self, global: usize) -> (usize, usize) {
        let index = self
            .starts
            .partition_point(|&s| s <= global)
            .saturating_sub(1);
        (
            index,
            (global - self.starts[index]).min(self.block_len(index)),
        )
    }

    pub fn selection(&self) -> Range<usize> {
        self.anchor.min(self.head)..self.anchor.max(self.head)
    }

    pub fn is_reversed(&self) -> bool {
        self.head < self.anchor
    }

    pub fn head(&self) -> usize {
        self.head
    }

    pub fn anchor(&self) -> usize {
        self.anchor
    }

    pub fn set_selection(&mut self, anchor: usize, head: usize) {
        self.anchor = self.snap(anchor);
        self.head = self.snap(head);
        self.stored_marks = None;
    }

    /// Clamps `offset` to the text and off the inside of a surrogate pair, so
    /// no edit can split a character.
    fn snap(&self, offset: usize) -> usize {
        let offset = offset.min(self.len());
        let (index, local) = self.locate(offset);
        let text = &self.blocks[index].text;
        self.starts[index] + utf16::from_utf8(text, utf16::to_utf8(text, local))
    }

    pub fn move_to(&mut self, offset: usize) {
        self.set_selection(offset, offset);
    }

    pub fn select_to(&mut self, offset: usize) {
        self.set_selection(self.anchor, offset);
    }

    pub fn select_all(&mut self) {
        self.set_selection(0, self.len());
    }

    /// The joined text of `range` (blocks separated by `\n`).
    pub fn text_in(&self, range: Range<usize>) -> String {
        let all: Vec<u16> = self
            .blocks
            .iter()
            .map(|b| b.text.as_str())
            .collect::<Vec<_>>()
            .join("\n")
            .encode_utf16()
            .collect();
        let end = range.end.min(all.len());
        String::from_utf16_lossy(&all[range.start.min(end)..end])
    }

    /// The previous grapheme boundary (block starts count as one step back).
    pub fn previous_boundary(&self, offset: usize) -> usize {
        let (index, local) = self.locate(offset);
        if local == 0 {
            return offset.saturating_sub(1);
        }
        let text = &self.blocks[index].text;
        let local8 = utf16::to_utf8(text, local);
        let prev8 = text
            .grapheme_indices(true)
            .map(|(i, _)| i)
            .rfind(|&i| i < local8)
            .unwrap_or(0);
        self.starts[index] + utf16::from_utf8(text, prev8)
    }

    pub fn next_boundary(&self, offset: usize) -> usize {
        let (index, local) = self.locate(offset);
        if local >= self.block_len(index) {
            return (offset + 1).min(self.len());
        }
        let text = &self.blocks[index].text;
        let local8 = utf16::to_utf8(text, local);
        let next8 = text
            .grapheme_indices(true)
            .map(|(i, _)| i)
            .find(|&i| i > local8)
            .unwrap_or(text.len());
        self.starts[index] + utf16::from_utf8(text, next8)
    }

    /// Ctrl+Left: the start of the word before `offset` (Chromium on Linux);
    /// at the start of a block, the end of the one before.
    pub fn previous_word(&self, offset: usize) -> usize {
        let (index, local) = self.locate(offset);
        if local == 0 {
            return offset.saturating_sub(1);
        }
        let text = &self.blocks[index].text;
        let local8 = utf16::to_utf8(text, local);
        let start8 = text
            .split_word_bound_indices()
            .rev()
            .find(|(i, w)| *i < local8 && is_word(w))
            .map_or(0, |(i, _)| i);
        self.starts[index] + utf16::from_utf8(text, start8)
    }

    /// Ctrl+Right: the end of the word after `offset`; at the end of a block,
    /// the start of the next.
    pub fn next_word(&self, offset: usize) -> usize {
        let (index, local) = self.locate(offset);
        if local >= self.block_len(index) {
            return (offset + 1).min(self.len());
        }
        let text = &self.blocks[index].text;
        let local8 = utf16::to_utf8(text, local);
        let end8 = text
            .split_word_bound_indices()
            .map(|(i, w)| (i + w.len(), w))
            .find(|(end, w)| *end > local8 && is_word(w))
            .map_or(text.len(), |(end, _)| end);
        self.starts[index] + utf16::from_utf8(text, end8)
    }

    pub fn move_word_left(&mut self, extend: bool) {
        let target = self.previous_word(self.head);
        if extend {
            self.select_to(target)
        } else {
            self.move_to(target)
        }
    }

    pub fn move_word_right(&mut self, extend: bool) {
        let target = self.next_word(self.head);
        if extend {
            self.select_to(target)
        } else {
            self.move_to(target)
        }
    }

    /// Ctrl+Backspace: deletes back to the start of the word (or the
    /// selection).
    pub fn delete_word_backward(&mut self) -> bool {
        let mut range = self.selection();
        if range.is_empty() {
            range.start = self.previous_word(range.start);
        }
        self.replace(range, "")
    }

    /// Ctrl+Delete: deletes to the end of the word (or the selection).
    pub fn delete_word_forward(&mut self) -> bool {
        let mut range = self.selection();
        if range.is_empty() {
            range.end = self.next_word(range.end);
        }
        self.replace(range, "")
    }

    pub fn move_left(&mut self, extend: bool) {
        let sel = self.selection();
        let target = if !extend && !sel.is_empty() {
            sel.start
        } else {
            self.previous_boundary(self.head)
        };
        if extend {
            self.select_to(target)
        } else {
            self.move_to(target)
        }
    }

    pub fn move_right(&mut self, extend: bool) {
        let sel = self.selection();
        let target = if !extend && !sel.is_empty() {
            sel.end
        } else {
            self.next_boundary(self.head)
        };
        if extend {
            self.select_to(target)
        } else {
            self.move_to(target)
        }
    }

    pub fn move_home(&mut self, extend: bool) {
        let (index, _) = self.locate(self.head);
        let target = self.starts[index];
        if extend {
            self.select_to(target)
        } else {
            self.move_to(target)
        }
    }

    pub fn move_end(&mut self, extend: bool) {
        let (index, _) = self.locate(self.head);
        let target = self.starts[index] + self.block_len(index);
        if extend {
            self.select_to(target)
        } else {
            self.move_to(target)
        }
    }

    /// Marks that typing at the caret would get.
    pub fn marks_at_cursor(&self) -> u32 {
        if let Some(marks) = self.stored_marks {
            return marks;
        }
        let (index, local) = self.locate(self.head);
        let piece = Piece::of(&self.blocks[index]);
        typing_marks(&piece, local).0
    }

    pub fn kind_at_cursor(&self) -> BlockKind {
        self.blocks[self.locate(self.head).0].kind
    }

    /// Types `text` over the selection. `\n` starts a new block, except in a
    /// code block, where it is a line break.
    pub fn insert_text(&mut self, text: &str) -> bool {
        let range = self.selection();
        self.replace(range, text)
    }

    /// Enter. In a list: an empty line leaves the list (one level), and a
    /// line with a sub-list under it hands the sub-list to the new item.
    pub fn newline(&mut self) -> bool {
        if self.anchor == self.head {
            let (index, local) = self.locate(self.head);
            let block = &self.blocks[index];
            // An empty quoted line leaves the quote (lists decide first).
            if block.list.is_none()
                && block.quote_depth > 0
                && block.text.is_empty()
                && block.kind != BlockKind::Atom
            {
                let id = stable_id(block);
                return self.structural(|doc, _| doc.lift_quote(&id, false));
            }
            if block.list.is_some() && block.editable {
                if block.text.is_empty() {
                    return self.outdent();
                }
                let id = stable_id(block);
                if let Some(new_id) = self.doc.split_list_item(&id, local) {
                    self.reload();
                    if let Some(i) = self.blocks.iter().position(|b| stable_id(b) == new_id) {
                        let at = self.starts[i];
                        self.move_to(at);
                    }
                    return true;
                }
            }
        }
        self.insert_text("\n")
    }

    /// Backspace. At the very start of a list line it lifts the line out one
    /// level instead of joining it to the line above; at the start of a quote
    /// it takes the line out of the quote.
    pub fn backspace(&mut self) -> bool {
        let mut range = self.selection();
        if range.is_empty() {
            let (index, local) = self.locate(range.start);
            let block = &self.blocks[index];
            if local == 0 && block.list.is_some() && block.editable {
                return self.outdent();
            }
            // At the start of a quote, Backspace lifts the line out of it.
            if local == 0 && block.list.is_none() && block.quote_depth > 0 && block.editable {
                let id = stable_id(block);
                if self.structural(|doc, _| doc.lift_quote(&id, true)) {
                    return true;
                }
            }
            range.start = self.previous_boundary(range.start);
        }
        self.replace(range, "")
    }

    pub fn delete_forward(&mut self) -> bool {
        let mut range = self.selection();
        if range.is_empty() {
            range.end = self.next_boundary(range.end);
        }
        self.replace(range, "")
    }

    /// Replaces `range` (global UTF-16) with `text`; the caret lands after it.
    pub fn replace(&mut self, range: Range<usize>, text: &str) -> bool {
        self.replace_with(range, text, None)
    }

    fn replace_with(&mut self, range: Range<usize>, text: &str, rich: Option<&[Run]>) -> bool {
        let range = self.snap(range.start)..self.snap(range.end);
        if range.is_empty() {
            let (index, local) = self.locate(range.start);
            let something = !text.is_empty() || rich.is_some_and(|r| !r.is_empty());
            if !self.blocks[index].editable && something {
                return self.insert_beside_figure(index, local > 0, text, rich);
            }
        }
        let Some(targets) = self.plan_replace(range.clone(), text, rich) else {
            return false;
        };
        let changed = self.apply(&targets);
        let inserted = match rich {
            Some(runs) => runs.iter().map(|(t, _, _)| utf16::len(t)).sum(),
            None => utf16::len(text),
        };
        let caret = (range.start + inserted).min(self.len());
        self.anchor = caret;
        self.head = caret;
        self.stored_marks = None;
        self.note_caret();
        changed
    }

    /// Typing, Enter or a paste with the caret on a figure (which holds no
    /// text) starts new lines beside it: after it from its end, before it from
    /// its start, as ProseMirror lets you continue past a block node.
    fn insert_beside_figure(
        &mut self,
        index: usize,
        after: bool,
        text: &str,
        rich: Option<&[Run]>,
    ) -> bool {
        let runs: Vec<Run> = match rich {
            Some(runs) => runs.to_vec(),
            None => vec![(text.to_owned(), 0, None)],
        };
        let mut lines = split_lines(&runs);
        // The break between the figure and the new line is implied.
        if after && lines.len() > 1 && lines[0].is_empty() {
            lines.remove(0);
        } else if !after && lines.len() > 1 && lines.last().is_some_and(Vec::is_empty) {
            lines.pop();
        }
        let pieces: Vec<TargetBlock> = lines
            .iter()
            .map(|line| {
                let mut p = Piece {
                    key: None,
                    kind: BlockKind::Paragraph,
                    units: vec![],
                    marks: vec![],
                    hrefs: vec![],
                };
                for (t, m, h) in line {
                    p.push_text(t, *m, h);
                }
                p.target()
            })
            .collect();
        let n = pieces.len();
        let at = if after { index + 1 } else { index };
        let mut targets: Vec<TargetBlock> =
            self.blocks[..at].iter().map(TargetBlock::from).collect();
        targets.extend(pieces);
        targets.extend(self.blocks[at..].iter().map(TargetBlock::from));
        let changed = self.apply(&targets);
        let last = (at + n).saturating_sub(1).min(self.blocks.len() - 1);
        let caret = self.starts[last] + self.block_len(last);
        self.anchor = caret;
        self.head = caret;
        self.stored_marks = None;
        self.note_caret();
        changed
    }

    fn plan_replace(
        &self,
        range: Range<usize>,
        text: &str,
        rich: Option<&[Run]>,
    ) -> Option<Vec<TargetBlock>> {
        let (mut bs, mut os) = self.locate(range.start);
        let (mut be, mut oe) = self.locate(range.end);
        // The newline next to a figure is not deletable: Backspace after it
        // (or Delete before it) removes the figure instead.
        if !self.blocks[bs].editable && os == self.block_len(bs) && bs < be {
            if text.is_empty() && bs + 1 == be && oe == 0 {
                return Some(self.without_block(bs));
            }
            (bs, os) = (bs + 1, 0);
        }
        if !self.blocks[be].editable && oe == 0 && bs < be {
            if text.is_empty() && bs + 1 == be && os == self.block_len(bs) {
                return Some(self.without_block(be));
            }
            be -= 1;
            oe = self.block_len(be);
        }
        let head_editable = self.blocks[bs].editable;
        let tail_editable = self.blocks[be].editable;
        // A figure is replaced only as a whole.
        if !head_editable && os != 0 {
            return None;
        }
        if !tail_editable && oe != self.block_len(be) {
            return None;
        }
        if !head_editable && bs == be && os == oe {
            return None;
        }

        let first = Piece::of(&self.blocks[bs]);
        let last = Piece::of(&self.blocks[be]);
        let (marks, href) = match self.stored_marks {
            Some(m) => (m, None),
            None if head_editable => typing_marks(&first, os),
            None => (0, None),
        };
        let code = head_editable && first.kind == BlockKind::CodeBlock;
        let runs: Vec<Run> = match rich {
            Some(runs) => runs.to_vec(),
            None => vec![(text.to_owned(), marks, href.clone())],
        };
        let lines: Vec<Vec<Run>> = if code { vec![runs] } else { split_lines(&runs) };

        let mut head = if head_editable {
            let mut p = first.slice(0..os);
            p.key = first.key.clone();
            p
        } else {
            Piece {
                key: None,
                kind: BlockKind::Paragraph,
                units: vec![],
                marks: vec![],
                hrefs: vec![],
            }
        };
        let tail = if tail_editable {
            last.slice(oe..last.units.len())
        } else {
            last.slice(0..0)
        };
        if head.key.is_none() && tail_editable && lines.len() == 1 {
            head.key = last.key.clone();
            head.kind = last.kind;
        }

        let mut pieces = Vec::new();
        for (t, m, h) in &lines[0] {
            head.push_text(t, *m, h);
        }
        if lines.len() == 1 {
            head.append(&tail);
            pieces.push(head);
        } else {
            // Enter at the end of a heading continues with a paragraph.
            let next_kind = match head.kind {
                BlockKind::Heading(_) if tail.units.is_empty() => BlockKind::Paragraph,
                kind => kind,
            };
            pieces.push(head);
            for (n, line) in lines[1..].iter().enumerate() {
                let mut p = Piece {
                    key: None,
                    kind: next_kind,
                    units: vec![],
                    marks: vec![],
                    hrefs: vec![],
                };
                for (t, m, h) in line {
                    p.push_text(t, *m, h);
                }
                if n == lines.len() - 2 {
                    p.append(&tail);
                }
                pieces.push(p);
            }
        }

        let mut targets: Vec<TargetBlock> =
            self.blocks[..bs].iter().map(TargetBlock::from).collect();
        targets.extend(pieces.iter().map(Piece::target));
        targets.extend(self.blocks[be + 1..].iter().map(TargetBlock::from));
        Some(targets)
    }

    /// Where `query` occurs, as global UTF-16 ranges in reading order: within
    /// blocks, not overlapping, figures skipped, ignoring case unless
    /// `case_sensitive` (the TS find bar's rules).
    pub fn find(&self, query: &str, case_sensitive: bool) -> Vec<Range<usize>> {
        let fold = |c: char| -> char {
            if case_sensitive {
                return c;
            }
            let mut lower = c.to_lowercase();
            match (lower.next(), lower.next()) {
                (Some(l), None) => l,
                _ => c,
            }
        };
        let needle: Vec<char> = query.chars().map(fold).collect();
        if needle.is_empty() {
            return vec![];
        }
        let mut found = vec![];
        for (i, block) in self.blocks.iter().enumerate() {
            if !block.editable {
                continue;
            }
            let hay: Vec<char> = block.text.chars().map(fold).collect();
            // UTF-16 offset of each char, plus the end.
            let mut offsets = Vec::with_capacity(hay.len() + 1);
            let mut at = 0;
            for c in block.text.chars() {
                offsets.push(at);
                at += c.len_utf16();
            }
            offsets.push(at);
            let mut c = 0;
            while c + needle.len() <= hay.len() {
                if hay[c..c + needle.len()] == needle[..] {
                    found.push(
                        self.starts[i] + offsets[c]..self.starts[i] + offsets[c + needle.len()],
                    );
                    c += needle.len();
                } else {
                    c += 1;
                }
            }
        }
        found
    }

    /// Replaces each of `ranges` (from [`Editor::find`]: inside one block
    /// each, in order) with `text`, as one undo step. The new text keeps the
    /// marks the replaced text had throughout; line breaks become spaces.
    /// The caret lands after the last replacement.
    pub fn replace_matches(&mut self, ranges: &[Range<usize>], text: &str) -> bool {
        let text = text.replace(['\r', '\n'], " ");
        let mut targets = Vec::with_capacity(self.blocks.len());
        let mut caret = None;
        let mut next = ranges.iter().peekable();
        for (i, block) in self.blocks.iter().enumerate() {
            let start = self.starts[i];
            let end = start + utf16::len(&block.text);
            let mut mine = vec![];
            while let Some(r) = next.peek() {
                if r.start < start || r.end > end || !block.editable {
                    break;
                }
                mine.push((r.start - start)..(r.end - start));
                next.next();
            }
            if mine.is_empty() {
                targets.push(TargetBlock::from(block));
                continue;
            }
            let piece = Piece::of(block);
            let mut out = piece.slice(0..0);
            out.key = piece.key.clone();
            let mut from = 0;
            for r in &mine {
                if r.start < from || r.end > piece.units.len() {
                    return false;
                }
                out.append(&piece.slice(from..r.start));
                let shared = piece.marks[r.clone()].iter().fold(u32::MAX, |a, m| a & m);
                let shared = if r.is_empty() { 0 } else { shared };
                let href = piece.hrefs.get(r.start).cloned().flatten();
                out.push_text(&text, shared, &href);
                from = r.end;
                caret = Some((i, out.units.len()));
            }
            out.append(&piece.slice(from..piece.units.len()));
            targets.push(out.target());
        }
        if next.peek().is_some() {
            return false;
        }
        let changed = self.doc.reconcile_step(&targets);
        self.reload();
        if let Some((block, local)) = caret {
            let at = self.starts[block] + local.min(self.block_len(block));
            self.move_to(at);
        }
        changed
    }

    fn without_block(&self, index: usize) -> Vec<TargetBlock> {
        self.blocks
            .iter()
            .enumerate()
            .filter(|(i, _)| *i != index)
            .map(|(_, b)| TargetBlock::from(b))
            .collect()
    }

    /// Bold, italic, … on the selection; with no selection, for what is typed next.
    pub fn toggle_mark(&mut self, bit: u32) -> bool {
        let range = self.selection();
        if range.is_empty() {
            self.stored_marks = Some(self.marks_at_cursor() ^ bit);
            return false;
        }
        let (bs, os) = self.locate(range.start);
        let (be, oe) = self.locate(range.end);
        let mut pieces: Vec<Piece> = self.blocks.iter().map(Piece::of).collect();
        let span = |i: usize, p: &Piece| {
            let start = if i == bs { os } else { 0 };
            let end = if i == be { oe } else { p.units.len() };
            start..end
        };
        let all_set = (bs..=be).all(|i| {
            let p = &pieces[i];
            !self.blocks[i].editable || p.marks[span(i, p)].iter().all(|m| m & bit != 0)
        });
        for (i, piece) in pieces.iter_mut().enumerate().take(be + 1).skip(bs) {
            if !self.blocks[i].editable {
                continue;
            }
            for u in span(i, piece) {
                if all_set {
                    piece.marks[u] &= !bit;
                } else {
                    piece.marks[u] |= bit;
                }
            }
        }
        let targets: Vec<TargetBlock> = pieces.iter().map(Piece::target).collect();
        let changed = self.doc.reconcile_step(&targets);
        self.reload();
        changed
    }

    /// Paragraph / heading / code block for every block the selection touches.
    pub fn set_kind(&mut self, kind: BlockKind) -> bool {
        let range = self.selection();
        let (bs, _) = self.locate(range.start);
        let (be, _) = self.locate(range.end);
        let targets: Vec<TargetBlock> = self
            .blocks
            .iter()
            .enumerate()
            .map(|(i, b)| {
                let mut t = TargetBlock::from(b);
                if (bs..=be).contains(&i) && b.editable {
                    t.kind = Some(kind);
                }
                t
            })
            .collect();
        let changed = self.doc.reconcile_step(&targets);
        self.reload();
        changed
    }

    /// The link around global `offset` (the character after it, or before
    /// it at a link's end): its global range and `href`.
    pub fn link_at(&self, offset: usize) -> Option<(Range<usize>, String)> {
        let (index, local) = self.locate(offset.min(self.len()));
        let piece = Piece::of(&self.blocks[index]);
        let has = |u: usize| piece.marks.get(u).is_some_and(|m| m & LINK_BIT != 0);
        let at = if has(local) {
            local
        } else if local > 0 && has(local - 1) {
            local - 1
        } else {
            return None;
        };
        let href = piece.hrefs[at].clone().unwrap_or_default();
        let same = |u: usize| has(u) && piece.hrefs[u].as_deref() == Some(href.as_str());
        let mut start = at;
        while start > 0 && same(start - 1) {
            start -= 1;
        }
        let mut end = at + 1;
        while end < piece.units.len() && same(end) {
            end += 1;
        }
        let base = self.starts[index];
        Some((base + start..base + end, href))
    }

    /// Ctrl+K. Links the selection (or the link under the caret) to `href`;
    /// an empty `href` removes the link. With nothing selected and no link
    /// under the caret, inserts `href` itself as linked text.
    pub fn set_link(&mut self, href: &str) -> bool {
        let mut range = self.selection();
        if range.is_empty() {
            match self.link_at(range.start) {
                Some((link, _)) => range = link,
                None if href.is_empty() => return false,
                None => {
                    let start = range.start;
                    if !self.insert_text(href) {
                        return false;
                    }
                    range = start..start + utf16::len(href);
                }
            }
        }
        let (bs, os) = self.locate(range.start);
        let (be, oe) = self.locate(range.end);
        let mut pieces: Vec<Piece> = self.blocks.iter().map(Piece::of).collect();
        for (i, piece) in pieces.iter_mut().enumerate().take(be + 1).skip(bs) {
            if !self.blocks[i].editable {
                continue;
            }
            let start = if i == bs { os } else { 0 };
            let end = if i == be { oe } else { piece.units.len() };
            for u in start..end {
                if href.is_empty() {
                    piece.marks[u] &= !LINK_BIT;
                    piece.hrefs[u] = None;
                } else {
                    piece.marks[u] |= LINK_BIT;
                    piece.hrefs[u] = Some(href.to_owned());
                }
            }
        }
        let targets: Vec<TargetBlock> = pieces.iter().map(Piece::target).collect();
        let changed = self.doc.reconcile_step(&targets);
        self.reload();
        changed
    }

    /// The selection as Markdown: what Ctrl+C puts on the clipboard, as the
    /// Tiptap app's `ClipboardMarkdown` does.
    pub fn selection_markdown(&self) -> String {
        markdown::render(&self.selected_views())
    }

    /// The selection as HTML, for the clipboard's `text/html` beside the
    /// Markdown text.
    pub fn selection_html(&self) -> String {
        let views = self.selected_views();
        if views.is_empty() {
            return String::new();
        }
        html::render(&views)
    }

    /// The selected blocks, the first and last cut to the selection.
    fn selected_views(&self) -> Vec<ViewBlock> {
        let range = self.selection();
        if range.is_empty() {
            return vec![];
        }
        let (bs, os) = self.locate(range.start);
        let (be, oe) = self.locate(range.end);
        (bs..=be)
            .map(|i| {
                let mut view = self.blocks[i].clone();
                if view.editable {
                    let piece = Piece::of(&view);
                    let start = if i == bs { os } else { 0 };
                    let end = if i == be { oe } else { piece.units.len() };
                    let part = piece.slice(start..end);
                    view.text = String::from_utf16_lossy(&part.units);
                    view.spans = spans_from_masks(&part.marks, &part.hrefs);
                }
                view
            })
            .collect()
    }

    /// Ctrl+V. Text that looks like Markdown (as the TS clipboard decides)
    /// becomes formatted text or blocks; anything else is typed as is.
    pub fn paste(&mut self, text: &str) -> bool {
        if !markdown::looks_like_markdown(text) {
            return self.insert_text(text);
        }
        self.paste_nodes(&markdown::parse(text), text)
    }

    /// Paste with `text/html` on the clipboard: the HTML decides (as in
    /// ProseMirror), `text` is the fallback where blocks cannot go.
    pub fn paste_html(&mut self, html: &str, text: &str) -> bool {
        let nodes = html::parse(html);
        if nodes.is_empty() {
            return self.paste(text);
        }
        self.paste_nodes(&nodes, text)
    }

    /// Inserts a Mermaid diagram with `source` at the caret (the "Insert as
    /// diagram" answer when pasted text looks like Mermaid).
    pub fn insert_mermaid(&mut self, source: &str) -> bool {
        let figure = markdown::mermaid_figure(source.trim_end());
        self.paste_nodes(&[figure], source)
    }

    fn paste_nodes(&mut self, nodes: &[NodeSnap], text: &str) -> bool {
        if let Some(runs) = markdown::single_paragraph(nodes) {
            let runs: Vec<Run> = runs
                .iter()
                .map(|(t, marks)| {
                    let mut bits = 0;
                    let mut href = None;
                    for (name, value) in marks {
                        bits |= mark_bit(name).unwrap_or(0);
                        if name == "link"
                            && let LoroValue::Map(m) = value
                            && let Some(LoroValue::String(h)) = m.get("href")
                        {
                            href = Some(h.to_string());
                        }
                    }
                    (t.clone(), bits, href)
                })
                .collect();
            let range = self.selection();
            return self.replace_with(range, "", Some(&runs));
        }
        if nodes.is_empty() {
            return false;
        }
        let range = self.selection();
        if !range.is_empty() {
            self.replace(range, "");
        }
        let (index, local) = self.locate(self.head);
        let block = &self.blocks[index];
        // Blocks go in at the top level for now; inside a list or quote the
        // Markdown is typed as text.
        if !block.editable || block.list.is_some() || block.quote_depth > 0 {
            return self.insert_text(text);
        }
        let id = stable_id(block);
        match self.doc.paste_blocks(&id, local, nodes) {
            Some(last) => {
                self.reload();
                if let Some(i) = self.blocks.iter().position(|b| stable_id(b) == last) {
                    let end = self.starts[i] + utf16::len(&self.blocks[i].text);
                    self.move_to(end);
                }
                true
            }
            None => self.insert_text(text),
        }
    }

    /// Bullet, numbered or task list on or off for the selected blocks.
    pub fn toggle_list(&mut self, kind: ListKind) -> bool {
        self.structural(|doc, ids| doc.toggle_list(ids, kind))
    }

    /// Quote on or off for the selected blocks (Ctrl+Shift+B).
    pub fn toggle_quote(&mut self) -> bool {
        self.structural(|doc, ids| doc.toggle_quote(ids))
    }

    /// Tab in a list: the selected items become children of the item above.
    pub fn indent(&mut self) -> bool {
        self.structural(|doc, ids| doc.indent(ids))
    }

    /// Shift+Tab in a list: one level up (or out of the list).
    pub fn outdent(&mut self) -> bool {
        self.structural(|doc, ids| doc.outdent(ids))
    }

    /// Ticks or unticks the task line at block `index`.
    pub fn toggle_task(&mut self, index: usize) -> bool {
        let Some(block) = self.blocks.get(index) else {
            return false;
        };
        if block.list != Some(ListKind::Task) {
            return false;
        }
        let (id, checked) = (stable_id(block), block.checked);
        let points = self.stable_points();
        let changed = self.doc.set_checked(&id, !checked);
        self.reload();
        self.restore_stable(points);
        changed
    }

    /// Runs a structural edit on the selected blocks. Blocks may be copied to
    /// new places (new view keys), so the selection follows `blockId`s.
    fn structural(&mut self, f: impl FnOnce(&mut Document, &[String]) -> bool) -> bool {
        let range = self.selection();
        let (bs, _) = self.locate(range.start);
        let (be, _) = self.locate(range.end);
        let ids: Vec<String> = self.blocks[bs..=be].iter().map(stable_id).collect();
        let points = self.stable_points();
        let changed = f(&mut self.doc, &ids);
        self.reload();
        self.restore_stable(points);
        self.stored_marks = None;
        changed
    }

    fn stable_points(&self) -> ((String, usize), (String, usize)) {
        let point = |offset: usize| {
            let (i, local) = self.locate(offset);
            (stable_id(&self.blocks[i]), local)
        };
        (point(self.anchor), point(self.head))
    }

    fn restore_stable(&mut self, (anchor, head): ((String, usize), (String, usize))) {
        let find = |(id, local): &(String, usize), fallback: usize| {
            self.blocks
                .iter()
                .position(|b| stable_id(b) == *id)
                .map(|i| self.starts[i] + (*local).min(utf16::len(&self.blocks[i].text)))
                .unwrap_or(fallback)
        };
        let a = find(&anchor, self.anchor);
        let h = find(&head, self.head);
        self.anchor = self.snap(a);
        self.head = self.snap(h);
    }

    fn caret_key(&self) -> String {
        self.blocks[self.locate(self.head).0].key.clone()
    }

    fn apply(&mut self, targets: &[TargetBlock]) -> bool {
        let before = self.caret_key();
        let changed = self.doc.reconcile_from(targets, Some(&before));
        self.reload();
        changed
    }

    fn note_caret(&mut self) {
        let key = self.caret_key();
        self.doc.set_caret_block(&key);
    }

    pub fn undo(&mut self) -> bool {
        let anchor = self.anchor_point();
        let done = self.doc.undo();
        self.reload();
        self.restore(anchor);
        done
    }

    pub fn redo(&mut self) -> bool {
        let anchor = self.anchor_point();
        let done = self.doc.redo();
        self.reload();
        self.restore(anchor);
        done
    }

    /// Applies a change from elsewhere (a collaborator's update) through `f`.
    /// The selection rides along with the text around it, as Loro cursors do.
    pub fn remote_change<R>(&mut self, f: impl FnOnce(&mut Document) -> R) -> R {
        let anchor = self.anchor_point();
        let result = f(&mut self.doc);
        self.reload();
        self.restore(anchor);
        result
    }

    fn anchor_point(&self) -> (Anchor, Anchor) {
        (self.point_at(self.anchor), self.point_at(self.head))
    }

    /// A caret position that survives other people's edits: a Loro cursor on
    /// the character, plus block and offset for when that cannot resolve.
    fn point_at(&self, offset: usize) -> Anchor {
        let (i, local) = self.locate(offset);
        let block = &self.blocks[i];
        let char_pos = char_count(&block.text, local);
        let cursor = self
            .doc
            .text_of(&block.key)
            .and_then(|t| t.get_cursor(char_pos, Side::Middle));
        Anchor {
            key: block.key.clone(),
            local,
            cursor,
        }
    }

    /// A Loro cursor at `offset`, encoded the way presence carries it
    /// (`None` in a block without text, which only old files have).
    pub fn cursor_bytes(&self, offset: usize) -> Option<Vec<u8>> {
        self.point_at(self.snap(offset.min(self.len())))
            .cursor
            .map(|c| c.encode())
    }

    /// Where a collaborator's encoded cursor points in our text now, if its
    /// block is still there.
    pub fn offset_of_cursor(&self, bytes: &[u8]) -> Option<usize> {
        let cursor = Cursor::decode(bytes).ok()?;
        let found = self.doc.loro().get_cursor_pos(&cursor).ok()?;
        let container = found.update.as_ref().unwrap_or(&cursor).container.clone();
        let index = self.doc.block_with_text(&container)?;
        let text = &self.blocks[index].text;
        let local = utf16::len(&text.chars().take(found.current.pos).collect::<String>());
        Some(self.snap(self.starts[index] + local))
    }

    fn resolve(&self, point: &Anchor, fallback: usize) -> usize {
        let Some(index) = self.blocks.iter().position(|b| b.key == point.key) else {
            return fallback;
        };
        let text = &self.blocks[index].text;
        let local = match point
            .cursor
            .as_ref()
            .map(|c| self.doc.loro().get_cursor_pos(c))
        {
            Some(Ok(found)) => {
                utf16::len(&text.chars().take(found.current.pos).collect::<String>())
            }
            _ => point.local,
        };
        self.starts[index] + local.min(utf16::len(text))
    }

    fn restore(&mut self, (anchor, head): (Anchor, Anchor)) {
        let a = self.resolve(&anchor, self.anchor);
        let h = self.resolve(&head, self.head);
        self.anchor = self.snap(a);
        self.head = self.snap(h);
    }
}

struct Anchor {
    key: String,
    local: usize,
    cursor: Option<Cursor>,
}

/// A word segment, as opposed to spaces and punctuation between words.
fn is_word(segment: &str) -> bool {
    segment.chars().any(|c| c.is_alphanumeric() || c == '_')
}

/// Characters (Unicode scalar values) in the first `utf16_offset` units of `text`.
fn char_count(text: &str, utf16_offset: usize) -> usize {
    text[..utf16::to_utf8(text, utf16_offset)].chars().count()
}

/// Inserted text with its marks: `(text, mark bits, link href)`.
type Run = (String, u32, Option<String>);

/// Splits runs at `\n` into lines (each a list of runs).
fn split_lines(runs: &[Run]) -> Vec<Vec<Run>> {
    let mut lines: Vec<Vec<Run>> = vec![vec![]];
    for (text, marks, href) in runs {
        for (i, part) in text.split('\n').enumerate() {
            if i > 0 {
                lines.push(vec![]);
            }
            if !part.is_empty() {
                lines
                    .last_mut()
                    .unwrap()
                    .push((part.to_owned(), *marks, href.clone()));
            }
        }
    }
    lines
}

/// A block's `blockId`, or its view key in files that lack ids.
fn stable_id(block: &ViewBlock) -> String {
    if block.block_id.is_empty() {
        block.key.clone()
    } else {
        block.block_id.clone()
    }
}

/// Marks for text typed at `at` in `piece`, mirroring Loro: inside a run the
/// text joins it; at a run's end only `expand: after` marks continue.
fn typing_marks(piece: &Piece, at: usize) -> (u32, Option<String>) {
    if at == 0 || piece.units.is_empty() {
        return (0, None);
    }
    let before = piece.marks[at - 1];
    let after = piece.marks.get(at).copied().unwrap_or(0);
    let marks = (before & after) | (before & expand_after_mask());
    let href = if marks & LINK_BIT != 0 {
        piece.hrefs[at - 1].clone()
    } else {
        None
    };
    (marks, href)
}
