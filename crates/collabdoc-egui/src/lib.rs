//! Feasibility spike (spec 25): the CollabDoc editor as an egui widget.
//!
//! The question is whether egui can host the same editor the Flutter and GPUI
//! builds draw, with every editing rule left in `collabdoc_core::Editor`. The
//! widget lays each [`ViewBlock`] out as a galley, maps pointer positions and
//! caret rows through it, turns egui's key, text, clipboard and IME events
//! into editor calls, and paints selection and caret itself. It is
//! deliberately small: what it leaves out (figures drawn, chips, lists'
//! numbers, find, presence) is listed in spec 25, not solved here.
//!
//! Offsets: the core counts UTF-16 units, egui's cursors count characters;
//! [`Laid`] converts between them per block.

use std::sync::Arc;

use collabdoc_core::model::INLINE_CHAR;
use collabdoc_core::schema::mark_bit;
use collabdoc_core::{BlockKind, Editor, ListKind, ViewBlock, utf16};
use egui::text::{CCursor, LayoutJob, TextFormat};
use egui::{
    Color32, EventFilter, FontData, FontDefinitions, FontFamily, FontId, Galley, Id, Key,
    Modifiers, Pos2, Rect, Response, Sense, Stroke, Ui, Vec2, pos2, vec2,
};

const TEXT: Color32 = Color32::from_rgb(0xE8, 0xE8, 0xEA);
const MUTED: Color32 = Color32::from_rgb(0x8B, 0x8B, 0x93);
const ACCENT: Color32 = Color32::from_rgb(0xC4, 0x5C, 0x26);
const SELECTION: Color32 = Color32::from_rgba_premultiplied(0x43, 0x1F, 0x0D, 0x55);
const CODE_BG: Color32 = Color32::from_rgb(0x1C, 0x1C, 0x20);
const LINK: Color32 = Color32::from_rgb(0x7A, 0xA2, 0xF7);
const HIGHLIGHT: Color32 = Color32::from_rgba_premultiplied(0x39, 0x30, 0x1E, 0x40);

const BLOCK_GAP: f32 = 6.0;
const INDENT: f32 = 22.0;

/// Inter in its four faces and JetBrains Mono, as the other builds use.
pub fn install_fonts(ctx: &egui::Context) {
    let mut fonts = FontDefinitions::default();
    let faces: [(&str, &'static [u8]); 5] = [
        (
            "Inter",
            include_bytes!("../../collabdoc-gpui/assets/fonts/Inter-Regular.otf"),
        ),
        (
            "Inter Bold",
            include_bytes!("../../collabdoc-gpui/assets/fonts/Inter-Bold.otf"),
        ),
        (
            "Inter Italic",
            include_bytes!("../../collabdoc-gpui/assets/fonts/Inter-Italic.otf"),
        ),
        (
            "Inter Bold Italic",
            include_bytes!("../../collabdoc-gpui/assets/fonts/Inter-BoldItalic.otf"),
        ),
        (
            "JetBrains Mono",
            include_bytes!("../../collabdoc-gpui/assets/fonts/JetBrainsMono-Regular.ttf"),
        ),
    ];
    for (name, bytes) in faces {
        fonts
            .font_data
            .insert(name.to_owned(), Arc::new(FontData::from_static(bytes)));
        // Each face is its own family, with egui's fonts behind it for
        // symbols Inter lacks.
        let mut chain = vec![name.to_owned()];
        chain.extend(fonts.families[&FontFamily::Proportional].iter().cloned());
        fonts.families.insert(FontFamily::Name(name.into()), chain);
    }
    ctx.set_fonts(fonts);
}

/// One block as laid out this frame.
struct Laid {
    /// Top-left in the widget's coordinates.
    origin: Vec2,
    galley: Arc<Galley>,
    /// The block's first global offset (UTF-16).
    start: usize,
    /// The text the galley shows: the block's text, one character per
    /// inline node, so offsets match.
    text: String,
    /// A figure or rule: one unit in the document, a longer label on screen.
    atom: bool,
}

impl Laid {
    fn char_of(&self, utf16_offset: usize) -> usize {
        if self.atom {
            return if utf16_offset == 0 {
                0
            } else {
                self.galley.end().index.0
            };
        }
        let byte = utf16::to_utf8(&self.text, utf16_offset);
        self.text[..byte].chars().count()
    }

    fn utf16_of(&self, char_index: usize) -> usize {
        if self.atom {
            return usize::from(char_index * 2 > self.galley.end().index.0);
        }
        let byte = self
            .text
            .char_indices()
            .nth(char_index)
            .map_or(self.text.len(), |(b, _)| b);
        utf16::from_utf8(&self.text, byte)
    }

    fn caret_rect(&self, local: usize) -> Rect {
        self.galley
            .pos_from_cursor(CCursor::new(self.char_of(local)))
            .translate(self.origin)
    }
}

/// The editor widget: owns the core editor; the host keeps it across frames.
pub struct EditorView {
    pub editor: Editor,
    laid: Vec<Laid>,
    /// IME composition, shown at the caret and never in the document until
    /// committed.
    pub preedit: String,
    /// The x kept while moving up and down through short lines.
    goal_x: Option<f32>,
    height: f32,
}

impl EditorView {
    pub fn new(editor: Editor) -> Self {
        Self {
            editor,
            laid: Vec::new(),
            preedit: String::new(),
            goal_x: None,
            height: 0.0,
        }
    }

    /// Draws the document and handles this frame's input.
    pub fn ui(&mut self, ui: &mut Ui) -> Response {
        let id = editor_id(ui);
        let width = ui.available_width().max(100.0);
        self.layout(ui, width);
        let (rect, _) = ui.allocate_exact_size(vec2(width, self.height.max(40.0)), Sense::hover());
        let response = ui.interact(rect, id, Sense::click_and_drag());

        if response.clicked() || response.drag_started() {
            response.request_focus();
        }
        if let Some(pointer) = response.interact_pointer_pos() {
            let offset = self.offset_at(pointer - rect.min.to_vec2());
            if response.drag_started() || response.clicked() {
                if ui.input(|i| i.modifiers.shift) {
                    self.editor.select_to(offset);
                } else {
                    self.editor.move_to(offset);
                }
            } else if response.dragged() {
                self.editor.select_to(offset);
            }
            self.goal_x = None;
        }

        if response.has_focus() {
            // Arrows and Tab are the editor's, not egui's focus moves.
            ui.memory_mut(|m| {
                m.set_focus_lock_filter(
                    id,
                    EventFilter {
                        tab: true,
                        horizontal_arrows: true,
                        vertical_arrows: true,
                        escape: false,
                    },
                )
            });
            let events = ui.input(|i| i.events.clone());
            let mut changed = false;
            for event in events {
                changed |= self.handle(ui, event);
            }
            if changed {
                self.layout(ui, width);
            }
        }

        self.paint(ui, rect, response.has_focus());
        response
    }

    /// Applies one input event; true when the layout must be redone.
    fn handle(&mut self, ui: &Ui, event: egui::Event) -> bool {
        use egui::{Event, ImeEvent};
        let e = &mut self.editor;
        match event {
            Event::Text(text) => {
                self.goal_x = None;
                e.insert_text(&text)
            }
            Event::Paste(text) => e.paste(&text),
            Event::Copy | Event::Cut => {
                let text = e.selection_markdown();
                if !text.is_empty() {
                    ui.ctx().copy_text(text);
                }
                matches!(event, Event::Cut) && e.backspace()
            }
            Event::Ime(ImeEvent::Preedit { text, .. }) => {
                self.preedit = text;
                true
            }
            Event::Ime(ImeEvent::Commit(text)) => {
                self.preedit.clear();
                e.insert_text(&text)
            }
            Event::Key {
                key,
                pressed: true,
                modifiers,
                ..
            } => self.key(key, modifiers),
            _ => false,
        }
    }

    /// The keymap: the same chords as the Flutter and Tiptap editors.
    fn key(&mut self, key: Key, m: Modifiers) -> bool {
        let e = &mut self.editor;
        let shift = m.shift;
        if !matches!(key, Key::ArrowUp | Key::ArrowDown) {
            self.goal_x = None;
        }
        if m.command && m.alt {
            return match key {
                Key::Num0 => e.set_kind(BlockKind::Paragraph),
                Key::Num1 => e.set_kind(BlockKind::Heading(1)),
                Key::Num2 => e.set_kind(BlockKind::Heading(2)),
                Key::Num3 => e.set_kind(BlockKind::Heading(3)),
                Key::C => e.set_kind(BlockKind::CodeBlock),
                _ => false,
            };
        }
        if m.command {
            let mark = |name| mark_bit(name).expect("a mark");
            return match key {
                Key::B => e.toggle_mark(mark("bold")),
                Key::I => e.toggle_mark(mark("italic")),
                Key::U => e.toggle_mark(mark("underline")),
                Key::E => e.toggle_mark(mark("code")),
                Key::X if shift => e.toggle_mark(mark("strike")),
                Key::Z if shift => e.redo(),
                Key::Z => e.undo(),
                Key::Y => e.redo(),
                Key::A => {
                    e.select_all();
                    false
                }
                Key::Num8 if shift => e.toggle_list(ListKind::Bullet),
                Key::Num7 if shift => e.toggle_list(ListKind::Ordered),
                Key::ArrowLeft => {
                    e.move_word_left(shift);
                    false
                }
                Key::Backspace => e.delete_word_backward(),
                _ => false,
            };
        }
        match key {
            Key::Enter if shift => e.hard_break(),
            Key::Enter => e.newline(),
            Key::Backspace => e.backspace(),
            Key::Delete => e.delete_forward(),
            Key::ArrowLeft => {
                e.move_left(shift);
                false
            }
            Key::ArrowRight => {
                e.move_right(shift);
                false
            }
            Key::Home => {
                e.move_home(shift);
                false
            }
            Key::End => {
                e.move_end(shift);
                false
            }
            Key::ArrowUp | Key::ArrowDown => {
                self.vertical(key == Key::ArrowDown, shift);
                false
            }
            _ => false,
        }
    }

    /// Up/Down by visual row, across blocks, keeping the column.
    fn vertical(&mut self, down: bool, extend: bool) {
        let head = self.editor.head();
        let (index, local) = self.editor.locate(head);
        let Some(laid) = self.laid.get(index) else {
            return;
        };
        let here = CCursor::new(laid.char_of(local));
        let (moved, x) = if down {
            laid.galley.cursor_down_one_row(&here, self.goal_x)
        } else {
            laid.galley.cursor_up_one_row(&here, self.goal_x)
        };
        let x = x.unwrap_or_else(|| laid.galley.pos_from_cursor(here).center().x);
        self.goal_x = Some(x);
        let row = |c: CCursor| laid.galley.layout_from_cursor(c).row;
        let target = if row(moved) != row(here) {
            laid.start + laid.utf16_of(moved.index.0)
        } else {
            // First or last row: into the next block, at the same x.
            let next = if down {
                index + 1
            } else {
                index.wrapping_sub(1)
            };
            match self.laid.get(next) {
                None => {
                    if down {
                        self.editor.len()
                    } else {
                        0
                    }
                }
                Some(other) => {
                    let rows = &other.galley.rows;
                    let y = if down {
                        rows.first().map_or(0.0, |r| r.rect().center().y)
                    } else {
                        rows.last().map_or(0.0, |r| r.rect().center().y)
                    };
                    let c = other.galley.cursor_from_pos(vec2(x, y));
                    other.start + other.utf16_of(c.index.0)
                }
            }
        };
        if extend {
            self.editor.select_to(target);
        } else {
            self.editor.move_to(target);
        }
    }

    /// The global offset under `pos` (widget coordinates).
    pub fn offset_at(&self, pos: Pos2) -> usize {
        let Some(laid) = self
            .laid
            .iter()
            .take_while(|l| l.origin.y <= pos.y)
            .last()
            .or(self.laid.first())
        else {
            return 0;
        };
        let c = laid.galley.cursor_from_pos(pos.to_vec2() - laid.origin);
        laid.start + laid.utf16_of(c.index.0)
    }

    /// Where the caret is drawn, in widget coordinates.
    pub fn caret_rect(&self) -> Option<Rect> {
        let (index, local) = self.editor.locate(self.editor.head());
        self.laid.get(index).map(|l| l.caret_rect(local))
    }

    fn layout(&mut self, ui: &Ui, width: f32) {
        let blocks = self.editor.blocks().to_vec();
        let mut y = 0.0;
        self.laid.clear();
        for (i, block) in blocks.iter().enumerate() {
            let indent = INDENT * f32::from(block.list_depth + block.quote_depth);
            let (text, job) = block_job(block, width - indent);
            let galley = ui.fonts_mut(|f| f.layout_job(job));
            let height = galley.size().y;
            self.laid.push(Laid {
                origin: vec2(indent, y),
                galley,
                start: self.editor.block_start(i),
                text,
                atom: block.kind == BlockKind::Atom,
            });
            y += height + BLOCK_GAP;
        }
        self.height = y;
    }

    fn paint(&self, ui: &Ui, rect: Rect, focused: bool) {
        let painter = ui.painter_at(rect.expand(2.0));
        let at = |r: Rect| r.translate(rect.min.to_vec2());
        let blocks = self.editor.blocks();
        let selection = self.editor.selection();
        for (laid, block) in self.laid.iter().zip(blocks) {
            let size = laid.galley.size();
            let block_rect = at(Rect::from_min_size(Pos2::ZERO + laid.origin, size));
            if block.kind == BlockKind::CodeBlock {
                painter.rect_filled(block_rect.expand(4.0), 4.0, CODE_BG);
            }
            if block.quote_depth > 0 {
                let x = block_rect.left() - INDENT * 0.6;
                painter.line_segment(
                    [pos2(x, block_rect.top()), pos2(x, block_rect.bottom())],
                    Stroke::new(2.0, MUTED),
                );
            }
            if let Some(list) = block.list {
                let marker = match list {
                    ListKind::Bullet => "•",
                    ListKind::Ordered => "1.",
                    ListKind::Task => {
                        if block.checked {
                            "☑"
                        } else {
                            "☐"
                        }
                    }
                };
                painter.text(
                    block_rect.left_top() - vec2(INDENT * 0.8, 0.0),
                    egui::Align2::LEFT_TOP,
                    marker,
                    FontId::proportional(15.0),
                    MUTED,
                );
            }
            // The selection, row by row.
            let end = laid.start + utf16::len(&laid.text);
            if selection.start < selection.end
                && selection.start <= end
                && selection.end >= laid.start
            {
                let from = selection.start.max(laid.start) - laid.start;
                let to = selection.end.min(end) - laid.start;
                let (a, b) = (laid.char_of(from), laid.char_of(to));
                let (ra, rb) = (
                    laid.galley.layout_from_cursor(CCursor::new(a)).row,
                    laid.galley.layout_from_cursor(CCursor::new(b)).row,
                );
                for r in ra..=rb {
                    let row = laid.galley.rows[r].rect();
                    let left = if r == ra {
                        laid.galley.pos_from_cursor(CCursor::new(a)).left()
                    } else {
                        row.left()
                    };
                    let right = if r == rb {
                        laid.galley.pos_from_cursor(CCursor::new(b)).left()
                    } else {
                        row.right() + 4.0
                    };
                    let sel =
                        Rect::from_x_y_ranges(left..=right, row.y_range()).translate(laid.origin);
                    painter.rect_filled(at(sel), 0.0, SELECTION);
                }
            }
            painter.galley(block_rect.min, laid.galley.clone(), TEXT);
        }
        if focused && let Some(caret) = self.caret_rect() {
            let caret = at(caret);
            if !self.preedit.is_empty() {
                painter.text(
                    caret.left_top(),
                    egui::Align2::LEFT_TOP,
                    &self.preedit,
                    FontId::new(16.0, FontFamily::Name("Inter".into())),
                    ACCENT,
                );
            }
            painter.line_segment(
                [caret.center_top(), caret.center_bottom()],
                Stroke::new(2.0, ACCENT),
            );
            // Where the platform should put the IME candidate window.
            ui.ctx().output_mut(|o| {
                o.ime = Some(egui::output::IMEOutput {
                    purpose: Default::default(),
                    rect,
                    cursor_rect: caret,
                    should_interrupt_composition: false,
                })
            });
        }
    }
}

/// The galley text and formatting for a block: its runs with their marks.
fn block_job(block: &ViewBlock, width: f32) -> (String, LayoutJob) {
    // Inline nodes are one unit each, as in the core: a hard break is a
    // real line break, anything else a placeholder of the same length.
    let text: String = block
        .text
        .chars()
        .enumerate()
        .map(|(i, c)| {
            if c != INLINE_CHAR {
                return c;
            }
            let at = utf16::from_utf8(&block.text, block.text.char_indices().nth(i).unwrap().0);
            match block.inline_at(at).map(|n| n.name.as_str()) {
                Some("hardBreak") => '\n',
                _ => '@',
            }
        })
        .collect();
    let mut job = LayoutJob::default();
    job.wrap.max_width = width;
    let (size, mono) = match block.kind {
        BlockKind::Heading(1) => (28.0, false),
        BlockKind::Heading(2) => (22.0, false),
        BlockKind::Heading(_) => (18.0, false),
        BlockKind::CodeBlock => (14.0, true),
        _ => (16.0, false),
    };
    if block.kind == BlockKind::Atom {
        job.append(
            &block.label(),
            0.0,
            TextFormat {
                font_id: FontId::new(size, FontFamily::Name("Inter Italic".into())),
                color: MUTED,
                ..Default::default()
            },
        );
        // An atom is one unit of text; its label is longer, so the caret
        // maps to its start or end only.
        return (INLINE_CHAR.to_string(), job);
    }
    let heading = matches!(block.kind, BlockKind::Heading(_));
    let mut add = |range: std::ops::Range<usize>, marks: u32| {
        let piece = &text[utf16::to_utf8(&text, range.start)..utf16::to_utf8(&text, range.end)];
        let has = |name| marks & mark_bit(name).unwrap_or(0) != 0;
        let code = mono || has("code");
        let family = match (code, has("bold") || heading, has("italic")) {
            (true, _, _) => "JetBrains Mono",
            (_, true, true) => "Inter Bold Italic",
            (_, true, false) => "Inter Bold",
            (_, false, true) => "Inter Italic",
            _ => "Inter",
        };
        let stroke = |on| {
            if on {
                Stroke::new(1.0, TEXT)
            } else {
                Stroke::NONE
            }
        };
        job.append(
            piece,
            0.0,
            TextFormat {
                font_id: FontId::new(
                    if code && !mono { size - 1.0 } else { size },
                    FontFamily::Name(family.into()),
                ),
                color: if has("link") { LINK } else { TEXT },
                background: if has("highlight") {
                    HIGHLIGHT
                } else if code && !mono {
                    CODE_BG
                } else {
                    Color32::TRANSPARENT
                },
                underline: stroke(has("underline") || has("link")),
                strikethrough: stroke(has("strike")),
                line_height: Some((size * 1.5).round()),
                ..Default::default()
            },
        );
    };
    let mut at = 0;
    for span in &block.spans {
        let (start, end) = (span.start as usize, span.end as usize);
        if start > at {
            add(at..start, 0);
        }
        add(start..end, span.marks);
        at = end;
    }
    let len = utf16::len(&text);
    if at < len || len == 0 {
        add(at..len, 0);
    }
    (text, job)
}

/// The id the widget takes its focus under, for hosts that move focus.
pub fn editor_id(ui: &Ui) -> Id {
    ui.make_persistent_id("collabdoc-editor")
}
