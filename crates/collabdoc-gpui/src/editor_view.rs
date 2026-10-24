//! The document editor: draws [`ViewBlock`]s with GPUI text runs and turns
//! keys, mouse and platform text input into [`Editor`] calls.
//!
//! All editing rules live in `collabdoc_core::editing`; this file only maps
//! between pixels and the editor's global UTF-16 offsets.

use std::ops::Range;
use std::path::PathBuf;

use collabdoc_core::schema::mark_bit;
use collabdoc_core::utf16;
use collabdoc_core::{BlockKind, Document, Editor, ListKind, ViewBlock};
use gpui::{
    App, Bounds, ClipboardItem, Context, CursorStyle, ElementInputHandler, Entity,
    EntityInputHandler, FocusHandle, Focusable, KeyBinding, MouseButton, MouseDownEvent,
    MouseMoveEvent, MouseUpEvent, PathPromptOptions, Pixels, Point, ScrollHandle, SharedString,
    StrikethroughStyle, StyledText, TextLayout, TextRun, UTF16Selection, UnderlineStyle, Window,
    actions, canvas, div, fill, point, prelude::*, px, size,
};

use crate::theme::{self, MONO_FONT, UI_FONT, hsla};
use crate::workspace::{self, Workspace};

actions!(
    editor,
    [
        Backspace,
        Delete,
        Newline,
        Left,
        Right,
        Up,
        Down,
        SelectLeft,
        SelectRight,
        SelectUp,
        SelectDown,
        Home,
        End,
        SelectHome,
        SelectEnd,
        DocStart,
        DocEnd,
        SelectAll,
        Copy,
        Cut,
        Paste,
        Undo,
        Redo,
        Bold,
        Italic,
        Underline,
        Strike,
        InlineCode,
        Highlight,
        Paragraph,
        Heading1,
        Heading2,
        Heading3,
        CodeBlock,
        NewPeerWindow,
        Save,
        Open,
        Quit,
    ]
);

const CONTEXT: &str = "CollabDocEditor";

pub fn bind_keys(cx: &mut App) {
    let c = Some(CONTEXT);
    cx.bind_keys([
        KeyBinding::new("backspace", Backspace, c),
        KeyBinding::new("shift-backspace", Backspace, c),
        KeyBinding::new("delete", Delete, c),
        KeyBinding::new("enter", Newline, c),
        KeyBinding::new("shift-enter", Newline, c),
        KeyBinding::new("left", Left, c),
        KeyBinding::new("right", Right, c),
        KeyBinding::new("up", Up, c),
        KeyBinding::new("down", Down, c),
        KeyBinding::new("shift-left", SelectLeft, c),
        KeyBinding::new("shift-right", SelectRight, c),
        KeyBinding::new("shift-up", SelectUp, c),
        KeyBinding::new("shift-down", SelectDown, c),
        KeyBinding::new("home", Home, c),
        KeyBinding::new("end", End, c),
        KeyBinding::new("shift-home", SelectHome, c),
        KeyBinding::new("shift-end", SelectEnd, c),
        KeyBinding::new("secondary-home", DocStart, c),
        KeyBinding::new("secondary-end", DocEnd, c),
        KeyBinding::new("secondary-a", SelectAll, c),
        KeyBinding::new("secondary-c", Copy, c),
        KeyBinding::new("secondary-x", Cut, c),
        KeyBinding::new("secondary-v", Paste, c),
        KeyBinding::new("secondary-z", Undo, c),
        KeyBinding::new("secondary-shift-z", Redo, c),
        KeyBinding::new("ctrl-y", Redo, c),
        KeyBinding::new("secondary-b", Bold, c),
        KeyBinding::new("secondary-i", Italic, c),
        KeyBinding::new("secondary-u", Underline, c),
        KeyBinding::new("secondary-shift-x", Strike, c),
        KeyBinding::new("secondary-e", InlineCode, c),
        KeyBinding::new("secondary-shift-h", Highlight, c),
        KeyBinding::new("secondary-alt-0", Paragraph, c),
        KeyBinding::new("secondary-alt-1", Heading1, c),
        KeyBinding::new("secondary-alt-2", Heading2, c),
        KeyBinding::new("secondary-alt-3", Heading3, c),
        KeyBinding::new("secondary-alt-c", CodeBlock, c),
        KeyBinding::new("secondary-shift-n", NewPeerWindow, c),
        KeyBinding::new("secondary-s", Save, c),
        KeyBinding::new("secondary-o", Open, c),
        KeyBinding::new("secondary-q", Quit, None),
    ]);
}

fn bit(name: &str) -> u32 {
    mark_bit(name).expect("known mark")
}

/// One block as painted last frame.
#[derive(Clone)]
struct Painted {
    layout: TextLayout,
    bounds: Bounds<Pixels>,
}

pub struct EditorView {
    pub editor: Editor,
    pub participant: String,
    focus_handle: FocusHandle,
    painted: Vec<Option<Painted>>,
    caret_bounds: Option<Bounds<Pixels>>,
    /// IME composition range (global UTF-16).
    marked: Option<Range<usize>>,
    selecting: bool,
    /// Column kept across consecutive Up/Down presses.
    goal_x: Option<Pixels>,
    scroll: ScrollHandle,
    dirty: bool,
    status: SharedString,
}

impl Focusable for EditorView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

/// Opens a window with its own participant on `doc`.
pub fn open_window(doc: Document, participant: String, cx: &mut App) {
    let title = format!("{} — {} · CollabDoc", doc.title(), participant);
    let options = gpui::WindowOptions {
        titlebar: Some(gpui::TitlebarOptions {
            title: Some(title.into()),
            ..Default::default()
        }),
        window_bounds: Some(gpui::WindowBounds::Windowed(Bounds::centered(
            None,
            size(px(960.), px(720.)),
            cx,
        ))),
        ..Default::default()
    };
    let opened = cx.open_window(options, |window, cx| {
        let view = cx.new(|cx| EditorView::new(Editor::new(doc), participant, cx));
        window.focus(&view.focus_handle(cx));
        view
    });
    if let Err(error) = opened {
        log::error!("could not open a window: {error}");
    }
}

impl EditorView {
    /// A participant view on `editor`, registered with the [`Workspace`] for sync.
    pub fn new(editor: Editor, participant: String, cx: &mut Context<Self>) -> Self {
        let weak = cx.entity().downgrade();
        cx.global_mut::<Workspace>().editors.push(weak);
        Self {
            editor,
            participant,
            focus_handle: cx.focus_handle(),
            painted: Vec::new(),
            caret_bounds: None,
            marked: None,
            selecting: false,
            goal_x: None,
            scroll: ScrollHandle::new(),
            dirty: false,
            status: SharedString::default(),
        }
    }

    // ── Sync ────────────────────────────────────────────────────────────

    /// After a local edit: send it to the hub and every other window.
    fn changed(&mut self, cx: &mut Context<Self>) {
        self.dirty = true;
        self.goal_x = None;
        self.marked = self.marked.take().filter(|m| m.end <= self.editor.len());
        self.reveal_caret();
        let me = cx.entity_id();
        if let Err(error) = cx.global::<Workspace>().hub.push(self.editor.document()) {
            log::error!("sync push failed: {error}");
        }
        let others: Vec<Entity<EditorView>> = cx
            .global::<Workspace>()
            .editors
            .iter()
            .filter(|e| e.entity_id() != me)
            .filter_map(|e| e.upgrade())
            .collect();
        for other in others {
            other.update(cx, |view, cx| view.pull(cx));
        }
        cx.notify();
    }

    /// Takes a collaborator's edits from the hub.
    pub fn pull(&mut self, cx: &mut Context<Self>) {
        let hub = &cx.global::<Workspace>().hub;
        match self.editor.remote_change(|doc| hub.pull(doc)) {
            Ok(true) => {
                self.dirty = true;
                cx.notify();
            }
            Ok(false) => {}
            Err(error) => log::error!("sync pull failed: {error}"),
        }
    }

    fn moved(&mut self, cx: &mut Context<Self>) {
        self.goal_x = None;
        self.reveal_caret();
        cx.notify();
    }

    fn reveal_caret(&self) {
        let (block, _) = self.editor.locate(self.editor.head());
        // Child 0 of the scroll area is the title.
        self.scroll.scroll_to_item(block + 1);
    }

    // ── Geometry ────────────────────────────────────────────────────────

    /// The global offset under `p`. With `up`, a point between blocks
    /// belongs to the block above (for the Up key), otherwise to the one below.
    fn offset_for_point(&self, p: Point<Pixels>, up: bool) -> usize {
        let painted: Vec<(usize, &Painted)> = self
            .painted
            .iter()
            .enumerate()
            .filter_map(|(i, p)| p.as_ref().map(|p| (i, p)))
            .collect();
        let Some(&(first, first_p)) = painted.first() else {
            return 0;
        };
        if p.y < first_p.bounds.top() {
            return self.editor.block_start(first);
        }
        let chosen = if up {
            painted.iter().rev().find(|(_, b)| b.bounds.top() <= p.y)
        } else {
            painted.iter().find(|(_, b)| p.y <= b.bounds.bottom())
        };
        let Some(&(index, block)) = chosen.or(painted.last()) else {
            return 0;
        };
        let y =
            p.y.clamp(block.bounds.top() + px(1.), block.bounds.bottom() - px(1.));
        let byte = match block.layout.index_for_position(point(p.x, y)) {
            Ok(i) | Err(i) => i,
        };
        let text = &self.editor.blocks()[index].text;
        self.editor.block_start(index) + utf16::from_utf8(text, byte.min(text.len()))
    }

    fn caret_point(&self, offset: usize) -> Option<(Point<Pixels>, Pixels)> {
        let (index, local) = self.editor.locate(offset);
        let painted = self.painted.get(index)?.as_ref()?;
        let text = &self.editor.blocks()[index].text;
        let p = painted
            .layout
            .position_for_index(utf16::to_utf8(text, local))
            .unwrap_or(painted.bounds.origin);
        Some((p, painted.layout.line_height()))
    }

    fn vertical(&mut self, down: bool, extend: bool, cx: &mut Context<Self>) {
        let Some((p, line_height)) = self.caret_point(self.editor.head()) else {
            return;
        };
        let x = self.goal_x.unwrap_or(p.x);
        let y = if down {
            p.y + line_height * 1.5
        } else {
            p.y - line_height * 0.5
        };
        let last = self.painted.iter().rev().find_map(|p| p.as_ref());
        let first = self.painted.iter().find_map(|p| p.as_ref());
        let target = match (first, last) {
            (Some(f), _) if y < f.bounds.top() => 0,
            (_, Some(l)) if y > l.bounds.bottom() => self.editor.len(),
            _ => self.offset_for_point(point(x, y), !down),
        };
        if extend {
            self.editor.select_to(target)
        } else {
            self.editor.move_to(target)
        }
        self.goal_x = Some(x);
        self.reveal_caret();
        cx.notify();
    }

    // ── Actions ─────────────────────────────────────────────────────────

    fn backspace(&mut self, _: &Backspace, _: &mut Window, cx: &mut Context<Self>) {
        if self.editor.backspace() {
            self.changed(cx);
        } else {
            self.moved(cx);
        }
    }

    fn delete(&mut self, _: &Delete, _: &mut Window, cx: &mut Context<Self>) {
        if self.editor.delete_forward() {
            self.changed(cx);
        }
    }

    fn newline(&mut self, _: &Newline, _: &mut Window, cx: &mut Context<Self>) {
        if self.editor.newline() {
            self.changed(cx);
        }
    }

    fn left(&mut self, _: &Left, _: &mut Window, cx: &mut Context<Self>) {
        self.editor.move_left(false);
        self.moved(cx);
    }

    fn right(&mut self, _: &Right, _: &mut Window, cx: &mut Context<Self>) {
        self.editor.move_right(false);
        self.moved(cx);
    }

    fn select_left(&mut self, _: &SelectLeft, _: &mut Window, cx: &mut Context<Self>) {
        self.editor.move_left(true);
        self.moved(cx);
    }

    fn select_right(&mut self, _: &SelectRight, _: &mut Window, cx: &mut Context<Self>) {
        self.editor.move_right(true);
        self.moved(cx);
    }

    fn up(&mut self, _: &Up, _: &mut Window, cx: &mut Context<Self>) {
        self.vertical(false, false, cx);
    }

    fn down(&mut self, _: &Down, _: &mut Window, cx: &mut Context<Self>) {
        self.vertical(true, false, cx);
    }

    fn select_up(&mut self, _: &SelectUp, _: &mut Window, cx: &mut Context<Self>) {
        self.vertical(false, true, cx);
    }

    fn select_down(&mut self, _: &SelectDown, _: &mut Window, cx: &mut Context<Self>) {
        self.vertical(true, true, cx);
    }

    fn home(&mut self, _: &Home, _: &mut Window, cx: &mut Context<Self>) {
        self.editor.move_home(false);
        self.moved(cx);
    }

    fn end(&mut self, _: &End, _: &mut Window, cx: &mut Context<Self>) {
        self.editor.move_end(false);
        self.moved(cx);
    }

    fn select_home(&mut self, _: &SelectHome, _: &mut Window, cx: &mut Context<Self>) {
        self.editor.move_home(true);
        self.moved(cx);
    }

    fn select_end(&mut self, _: &SelectEnd, _: &mut Window, cx: &mut Context<Self>) {
        self.editor.move_end(true);
        self.moved(cx);
    }

    fn doc_start(&mut self, _: &DocStart, _: &mut Window, cx: &mut Context<Self>) {
        self.editor.move_to(0);
        self.moved(cx);
    }

    fn doc_end(&mut self, _: &DocEnd, _: &mut Window, cx: &mut Context<Self>) {
        let len = self.editor.len();
        self.editor.move_to(len);
        self.moved(cx);
    }

    fn select_all(&mut self, _: &SelectAll, _: &mut Window, cx: &mut Context<Self>) {
        self.editor.select_all();
        cx.notify();
    }

    fn copy(&mut self, _: &Copy, _: &mut Window, cx: &mut Context<Self>) {
        let range = self.editor.selection();
        if !range.is_empty() {
            cx.write_to_clipboard(ClipboardItem::new_string(self.editor.text_in(range)));
        }
    }

    fn cut(&mut self, _: &Cut, _: &mut Window, cx: &mut Context<Self>) {
        let range = self.editor.selection();
        if !range.is_empty() {
            cx.write_to_clipboard(ClipboardItem::new_string(self.editor.text_in(range)));
            if self.editor.insert_text("") {
                self.changed(cx);
            }
        }
    }

    fn paste(&mut self, _: &Paste, _: &mut Window, cx: &mut Context<Self>) {
        if let Some(text) = cx.read_from_clipboard().and_then(|item| item.text())
            && self.editor.insert_text(&text.replace("\r\n", "\n"))
        {
            self.changed(cx);
        }
    }

    fn undo(&mut self, _: &Undo, _: &mut Window, cx: &mut Context<Self>) {
        if self.editor.undo() {
            self.changed(cx);
        }
    }

    fn redo(&mut self, _: &Redo, _: &mut Window, cx: &mut Context<Self>) {
        if self.editor.redo() {
            self.changed(cx);
        }
    }

    fn toggle(&mut self, name: &str, cx: &mut Context<Self>) {
        if self.editor.toggle_mark(bit(name)) {
            self.changed(cx);
        } else {
            cx.notify();
        }
    }

    fn bold(&mut self, _: &Bold, _: &mut Window, cx: &mut Context<Self>) {
        self.toggle("bold", cx);
    }

    fn italic(&mut self, _: &Italic, _: &mut Window, cx: &mut Context<Self>) {
        self.toggle("italic", cx);
    }

    fn underline(&mut self, _: &Underline, _: &mut Window, cx: &mut Context<Self>) {
        self.toggle("underline", cx);
    }

    fn strike(&mut self, _: &Strike, _: &mut Window, cx: &mut Context<Self>) {
        self.toggle("strike", cx);
    }

    fn inline_code(&mut self, _: &InlineCode, _: &mut Window, cx: &mut Context<Self>) {
        self.toggle("code", cx);
    }

    fn highlight(&mut self, _: &Highlight, _: &mut Window, cx: &mut Context<Self>) {
        self.toggle("highlight", cx);
    }

    fn set_kind(&mut self, kind: BlockKind, cx: &mut Context<Self>) {
        if self.editor.set_kind(kind) {
            self.changed(cx);
        }
    }

    fn paragraph(&mut self, _: &Paragraph, _: &mut Window, cx: &mut Context<Self>) {
        self.set_kind(BlockKind::Paragraph, cx);
    }

    fn heading1(&mut self, _: &Heading1, _: &mut Window, cx: &mut Context<Self>) {
        self.set_kind(BlockKind::Heading(1), cx);
    }

    fn heading2(&mut self, _: &Heading2, _: &mut Window, cx: &mut Context<Self>) {
        self.set_kind(BlockKind::Heading(2), cx);
    }

    fn heading3(&mut self, _: &Heading3, _: &mut Window, cx: &mut Context<Self>) {
        self.set_kind(BlockKind::Heading(3), cx);
    }

    fn code_block(&mut self, _: &CodeBlock, _: &mut Window, cx: &mut Context<Self>) {
        self.set_kind(BlockKind::CodeBlock, cx);
    }

    fn new_peer_window(&mut self, _: &NewPeerWindow, _: &mut Window, cx: &mut Context<Self>) {
        let participant = cx.global_mut::<Workspace>().next_participant();
        let actor = collabdoc_core::ids::new_actor_id();
        let doc = self.editor.document().fork(&actor);
        open_window(doc, participant, cx);
    }

    fn save(&mut self, _: &Save, _: &mut Window, cx: &mut Context<Self>) {
        let path = cx
            .global::<Workspace>()
            .path
            .clone()
            .unwrap_or_else(|| workspace::default_path(&self.editor.document().title()));
        match workspace::save_file(&path, self.editor.document()) {
            Ok(()) => {
                cx.global_mut::<Workspace>().path = Some(path.clone());
                self.status = format!("Saved {}", path.display()).into();
                let editors: Vec<_> = cx
                    .global::<Workspace>()
                    .editors
                    .iter()
                    .filter_map(|e| e.upgrade())
                    .collect();
                self.dirty = false;
                for editor in editors {
                    if editor.entity_id() != cx.entity_id() {
                        editor.update(cx, |view, cx| {
                            view.dirty = false;
                            cx.notify();
                        });
                    }
                }
            }
            Err(error) => self.status = format!("Save failed: {error}").into(),
        }
        cx.notify();
    }

    fn open(&mut self, _: &Open, window: &mut Window, cx: &mut Context<Self>) {
        let picked = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: false,
            prompt: Some("Open".into()),
        });
        cx.spawn_in(window, async move |this, cx| {
            let path = match picked.await {
                Ok(Ok(Some(paths))) => paths.into_iter().next(),
                Ok(Err(error)) => {
                    let message =
                        format!("No file dialog: {error}. Pass a path on the command line.");
                    this.update(cx, |view, cx| {
                        view.status = message.into();
                        cx.notify();
                    })
                    .ok();
                    None
                }
                _ => None,
            };
            if let Some(path) = path {
                this.update(cx, |view, cx| view.open_path(path, cx)).ok();
            }
        })
        .detach();
    }

    /// Replaces the workspace's document; every window becomes a participant on it.
    fn open_path(&mut self, path: PathBuf, cx: &mut Context<Self>) {
        let actor = collabdoc_core::ids::new_actor_id();
        let doc = match workspace::open_file(&path, &actor) {
            Ok(doc) => doc,
            Err(error) => {
                self.status = error.into();
                cx.notify();
                return;
            }
        };
        let others: Vec<_> = cx
            .global::<Workspace>()
            .editors
            .iter()
            .filter(|e| e.entity_id() != cx.entity_id())
            .filter_map(|e| e.upgrade())
            .collect();
        for other in others {
            let fork = doc.fork(&collabdoc_core::ids::new_actor_id());
            other.update(cx, |view, cx| {
                view.editor = Editor::new(fork);
                view.dirty = false;
                cx.notify();
            });
        }
        {
            let ws = cx.global_mut::<Workspace>();
            ws.hub = collabdoc_core::sync::Hub::new(&doc);
            ws.path = Some(path.clone());
        }
        self.editor = Editor::new(doc);
        self.dirty = false;
        self.status = format!("Opened {}", path.display()).into();
        cx.notify();
    }

    // ── Mouse ───────────────────────────────────────────────────────────

    fn on_mouse_down(
        &mut self,
        event: &MouseDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        window.focus(&self.focus_handle);
        let offset = self.offset_for_point(event.position, false);
        if event.modifiers.shift {
            self.editor.select_to(offset);
        } else if event.click_count >= 3 {
            let (index, _) = self.editor.locate(offset);
            let start = self.editor.block_start(index);
            let len = utf16::len(&self.editor.blocks()[index].text);
            self.editor.set_selection(start, start + len);
        } else if event.click_count == 2 {
            let (start, end) = self.word_at(offset);
            self.editor.set_selection(start, end);
        } else {
            self.editor.move_to(offset);
        }
        self.selecting = event.click_count == 1;
        self.goal_x = None;
        cx.notify();
    }

    fn on_mouse_move(&mut self, event: &MouseMoveEvent, _: &mut Window, cx: &mut Context<Self>) {
        if self.selecting && event.pressed_button == Some(MouseButton::Left) {
            let offset = self.offset_for_point(event.position, false);
            self.editor.select_to(offset);
            cx.notify();
        }
    }

    fn on_mouse_up(&mut self, _: &MouseUpEvent, _: &mut Window, _: &mut Context<Self>) {
        self.selecting = false;
    }

    fn word_at(&self, offset: usize) -> (usize, usize) {
        let (index, local) = self.editor.locate(offset);
        let text = &self.editor.blocks()[index].text;
        let start = self.editor.block_start(index);
        let byte = utf16::to_utf8(text, local);
        unicode_words(text)
            .find(|(i, word)| *i <= byte && byte <= i + word.len())
            .map(|(i, word)| {
                (
                    start + utf16::from_utf8(text, i),
                    start + utf16::from_utf8(text, i + word.len()),
                )
            })
            .unwrap_or((offset, offset))
    }

    // ── Rendering ───────────────────────────────────────────────────────

    fn tool(
        &self,
        id: &'static str,
        label: &'static str,
        active: bool,
        cx: &mut Context<Self>,
        run: fn(&mut EditorView, &mut Window, &mut Context<EditorView>),
    ) -> impl IntoElement {
        div()
            .id(id)
            .px_2()
            .py_1()
            .rounded_md()
            .cursor_pointer()
            .text_color(if active {
                theme::accent()
            } else {
                theme::text()
            })
            .when(active, |d| d.bg(theme::button_active()))
            .hover(|d| d.bg(theme::button_hover()))
            .child(label)
            .on_click(cx.listener(move |this, _, window, cx| {
                window.focus(&this.focus_handle);
                run(this, window, cx);
            }))
    }

    fn toolbar(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let marks = self.editor.marks_at_cursor();
        let kind = self.editor.kind_at_cursor();
        let on = |name: &str| marks & bit(name) != 0;
        let sep = || div().w(px(1.)).h(px(18.)).mx_1().bg(theme::border());
        div()
            .flex()
            .flex_row()
            .items_center()
            .gap_1()
            .px_3()
            .py_1()
            .bg(theme::panel())
            .border_b_1()
            .border_color(theme::border())
            .text_size(px(13.))
            .child(
                self.tool("t-p", "¶", kind == BlockKind::Paragraph, cx, |v, w, cx| {
                    v.paragraph(&Paragraph, w, cx)
                }),
            )
            .child(self.tool(
                "t-h1",
                "H1",
                kind == BlockKind::Heading(1),
                cx,
                |v, w, cx| v.heading1(&Heading1, w, cx),
            ))
            .child(self.tool(
                "t-h2",
                "H2",
                kind == BlockKind::Heading(2),
                cx,
                |v, w, cx| v.heading2(&Heading2, w, cx),
            ))
            .child(self.tool(
                "t-h3",
                "H3",
                kind == BlockKind::Heading(3),
                cx,
                |v, w, cx| v.heading3(&Heading3, w, cx),
            ))
            .child(self.tool(
                "t-code-block",
                "{ }",
                kind == BlockKind::CodeBlock,
                cx,
                |v, w, cx| v.code_block(&CodeBlock, w, cx),
            ))
            .child(sep())
            .child(self.tool("t-b", "B", on("bold"), cx, |v, w, cx| v.bold(&Bold, w, cx)))
            .child(self.tool("t-i", "I", on("italic"), cx, |v, w, cx| {
                v.italic(&Italic, w, cx)
            }))
            .child(self.tool("t-u", "U", on("underline"), cx, |v, w, cx| {
                v.underline(&Underline, w, cx)
            }))
            .child(self.tool("t-s", "S", on("strike"), cx, |v, w, cx| {
                v.strike(&Strike, w, cx)
            }))
            .child(self.tool("t-code", "</>", on("code"), cx, |v, w, cx| {
                v.inline_code(&InlineCode, w, cx)
            }))
            .child(self.tool("t-hl", "Mark", on("highlight"), cx, |v, w, cx| {
                v.highlight(&Highlight, w, cx)
            }))
            .child(sep())
            .child(self.tool("t-undo", "Undo", false, cx, |v, w, cx| v.undo(&Undo, w, cx)))
            .child(self.tool("t-redo", "Redo", false, cx, |v, w, cx| v.redo(&Redo, w, cx)))
            .child(div().flex_1())
            .child(self.tool("t-peer", "+ Peer window", false, cx, |v, w, cx| {
                v.new_peer_window(&NewPeerWindow, w, cx)
            }))
            .child(self.tool("t-open", "Open", false, cx, |v, w, cx| v.open(&Open, w, cx)))
            .child(self.tool("t-save", "Save", false, cx, |v, w, cx| v.save(&Save, w, cx)))
    }

    fn status_bar(&self, cx: &App) -> impl IntoElement {
        let ws = cx.global::<Workspace>();
        let saved = match (&ws.path, self.dirty) {
            (_, true) => "● unsaved".to_owned(),
            (Some(p), false) => p.display().to_string(),
            (None, false) => "not saved yet".to_owned(),
        };
        div()
            .flex()
            .flex_row()
            .gap_4()
            .px_3()
            .py_1()
            .bg(theme::panel())
            .border_t_1()
            .border_color(theme::border())
            .text_size(px(12.))
            .text_color(theme::muted())
            .child(
                div()
                    .text_color(theme::accent())
                    .child(format!("● {}", self.participant)),
            )
            .child(match ws.live_editors() {
                1 => "1 participant".to_owned(),
                n => format!("{n} participants"),
            })
            .child(format!("{} blocks", self.editor.blocks().len()))
            .child(saved)
            .child(div().flex_1())
            .child(self.status.clone())
    }
}

fn unicode_words(text: &str) -> impl Iterator<Item = (usize, &str)> {
    use unicode_segmentation::UnicodeSegmentation;
    text.split_word_bound_indices()
        .filter(|(_, w)| w.chars().any(char::is_alphanumeric))
}

/// Text runs (UTF-8 lengths) for a block's marks.
fn runs_for(block: &ViewBlock, base_family: &str, base_bold: bool) -> Vec<TextRun> {
    let text = &block.text;
    if text.is_empty() {
        return vec![];
    }
    let muted = !block.editable;
    let units = utf16::len(text);
    let mut marks = vec![0u32; units];
    for span in &block.spans {
        for m in &mut marks[(span.start as usize).min(units)..(span.end as usize).min(units)] {
            *m |= span.marks;
        }
    }
    let mut runs = Vec::new();
    let mut start16 = 0;
    while start16 < units {
        let m = marks[start16];
        let mut end16 = start16 + 1;
        while end16 < units && marks[end16] == m {
            end16 += 1;
        }
        let len = utf16::to_utf8(text, end16) - utf16::to_utf8(text, start16);
        let is = |name: &str| m & bit(name) != 0;
        let code = is("code");
        let link = is("link");
        let color = if muted {
            theme::muted()
        } else if link {
            theme::link()
        } else if code {
            theme::code_text()
        } else {
            theme::text()
        };
        let background = if code {
            Some(hsla(theme::code_bg()))
        } else if is("highlight") {
            Some(hsla(theme::highlight_mark()))
        } else {
            None
        };
        runs.push(TextRun {
            len,
            font: theme::font(
                if code { MONO_FONT } else { base_family },
                base_bold || is("bold"),
                muted || is("italic"),
            ),
            color: hsla(color),
            background_color: background,
            underline: (is("underline") || link).then(|| UnderlineStyle {
                color: Some(hsla(color)),
                thickness: px(1.),
                wavy: false,
            }),
            strikethrough: is("strike").then(|| StrikethroughStyle {
                color: Some(hsla(color)),
                thickness: px(1.),
            }),
        });
        start16 = end16;
    }
    runs
}

impl Render for EditorView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let blocks = self.editor.blocks().to_vec();
        let mut layouts: Vec<TextLayout> = Vec::with_capacity(blocks.len());
        let mut rows = Vec::with_capacity(blocks.len());
        let mut counters: Vec<usize> = Vec::new();
        for block in &blocks {
            // Ordered-list numbering per depth, restarting after other content.
            let depth = block.list_depth as usize;
            counters.truncate(depth);
            while counters.len() < depth {
                counters.push(0);
            }
            if depth > 0 {
                counters[depth - 1] += 1;
            }
            let (font_size, family, bold) = match block.kind {
                BlockKind::Heading(1) => (28., UI_FONT, true),
                BlockKind::Heading(2) => (22., UI_FONT, true),
                BlockKind::Heading(3) => (18., UI_FONT, true),
                BlockKind::Heading(_) => (16., UI_FONT, true),
                BlockKind::CodeBlock => (14., MONO_FONT, false),
                _ => (15., UI_FONT, false),
            };
            let styled = StyledText::new(SharedString::from(block.text.clone()))
                .with_runs(runs_for(block, family, bold));
            layouts.push(styled.layout().clone());

            let marker = match block.list {
                Some(ListKind::Bullet) => Some(
                    div()
                        .child(if depth % 2 == 1 { "•" } else { "◦" })
                        .into_any_element(),
                ),
                Some(ListKind::Ordered) => Some(
                    div()
                        .child(format!("{}.", counters[depth - 1]))
                        .into_any_element(),
                ),
                Some(ListKind::Task) => Some(
                    div()
                        .mt(px(5.))
                        .size(px(12.))
                        .rounded_sm()
                        .border_1()
                        .border_color(theme::muted())
                        .when(block.checked, |d| d.bg(theme::accent()))
                        .into_any_element(),
                ),
                None => None,
            };
            let text = div()
                .flex_1()
                .min_w_0()
                .text_size(px(font_size))
                .line_height(px((font_size * 1.55_f32).round()))
                .font_family(family)
                .child(styled);
            let mut row = div()
                .w_full()
                .flex()
                .flex_row()
                .gap_2()
                .pl(px(26. * depth as f32))
                .text_color(theme::text());
            row = match block.kind {
                BlockKind::Heading(1) => row.mt_4().mb_1(),
                BlockKind::Heading(_) => row.mt_3().mb_1(),
                BlockKind::CodeBlock => row.my_1().px_3().py_2().rounded_md().bg(theme::code_bg()),
                BlockKind::Atom => row
                    .my_1()
                    .px_3()
                    .py_2()
                    .rounded_md()
                    .border_1()
                    .border_color(theme::border()),
                BlockKind::Paragraph => row.my(px(3.)),
            };
            if block.quote_depth > 0 {
                row = row
                    .border_l_2()
                    .border_color(theme::muted())
                    .pl(px(12.))
                    .text_color(theme::muted());
            }
            if let Some(marker) = marker {
                row = row.child(
                    div()
                        .w(px(18.))
                        .flex_none()
                        .text_size(px(font_size))
                        .line_height(px((font_size * 1.55_f32).round()))
                        .text_color(theme::muted())
                        .child(marker),
                );
            }
            rows.push(row.child(text));
        }

        // Selection, caret and the platform text-input hook, painted over the text.
        let entity = cx.entity();
        let focus = self.focus_handle.clone();
        let focused = focus.is_focused(window);
        let selection = self.editor.selection();
        let head = self.editor.head();
        let texts: Vec<String> = blocks.iter().map(|b| b.text.clone()).collect();
        let starts: Vec<usize> = (0..blocks.len())
            .map(|i| self.editor.block_start(i))
            .collect();
        let overlay_layouts = layouts.clone();
        let overlay = canvas(
            |_, _, _| (),
            move |bounds, (), window, cx| {
                window.handle_input(&focus, ElementInputHandler::new(bounds, entity.clone()), cx);
                let mut painted = Vec::with_capacity(overlay_layouts.len());
                let mut caret = None;
                for (i, layout) in overlay_layouts.iter().enumerate() {
                    let block_bounds = layout.bounds();
                    let line_height = layout.line_height();
                    let text = &texts[i];
                    let start = starts[i];
                    let len = utf16::len(text);
                    let pos = |local: usize| {
                        layout
                            .position_for_index(utf16::to_utf8(text, local))
                            .unwrap_or(block_bounds.origin)
                    };
                    let from = selection.start.max(start);
                    let to = selection.end.min(start + len);
                    let covers_break =
                        selection.start <= start + len && selection.end > start + len;
                    if !selection.is_empty() && (from < to || covers_break) {
                        let a = pos(from - start);
                        let b = pos(to.max(from) - start);
                        let extra = if covers_break { px(6.) } else { px(0.) };
                        paint_selection(window, block_bounds, line_height, a, b, extra);
                    }
                    if (start..=start + len).contains(&head) && caret.is_none() {
                        let p = pos(head - start);
                        caret = Some(Bounds::new(p, size(px(2.), line_height)));
                    }
                    painted.push(Some(Painted {
                        layout: layout.clone(),
                        bounds: block_bounds,
                    }));
                }
                if focused && let Some(c) = caret {
                    window.paint_quad(fill(c, theme::accent()));
                }
                entity.update(cx, |view, _| {
                    view.painted = painted;
                    view.caret_bounds = caret;
                });
            },
        )
        .absolute()
        .top_0()
        .left_0()
        .size_full();

        let title = self.editor.document().title();
        div()
            .key_context(CONTEXT)
            .track_focus(&self.focus_handle)
            .on_action(cx.listener(Self::backspace))
            .on_action(cx.listener(Self::delete))
            .on_action(cx.listener(Self::newline))
            .on_action(cx.listener(Self::left))
            .on_action(cx.listener(Self::right))
            .on_action(cx.listener(Self::up))
            .on_action(cx.listener(Self::down))
            .on_action(cx.listener(Self::select_left))
            .on_action(cx.listener(Self::select_right))
            .on_action(cx.listener(Self::select_up))
            .on_action(cx.listener(Self::select_down))
            .on_action(cx.listener(Self::home))
            .on_action(cx.listener(Self::end))
            .on_action(cx.listener(Self::select_home))
            .on_action(cx.listener(Self::select_end))
            .on_action(cx.listener(Self::doc_start))
            .on_action(cx.listener(Self::doc_end))
            .on_action(cx.listener(Self::select_all))
            .on_action(cx.listener(Self::copy))
            .on_action(cx.listener(Self::cut))
            .on_action(cx.listener(Self::paste))
            .on_action(cx.listener(Self::undo))
            .on_action(cx.listener(Self::redo))
            .on_action(cx.listener(Self::bold))
            .on_action(cx.listener(Self::italic))
            .on_action(cx.listener(Self::underline))
            .on_action(cx.listener(Self::strike))
            .on_action(cx.listener(Self::inline_code))
            .on_action(cx.listener(Self::highlight))
            .on_action(cx.listener(Self::paragraph))
            .on_action(cx.listener(Self::heading1))
            .on_action(cx.listener(Self::heading2))
            .on_action(cx.listener(Self::heading3))
            .on_action(cx.listener(Self::code_block))
            .on_action(cx.listener(Self::new_peer_window))
            .on_action(cx.listener(Self::save))
            .on_action(cx.listener(Self::open))
            .flex()
            .flex_col()
            .size_full()
            .bg(theme::bg())
            .text_color(theme::text())
            .font_family(UI_FONT)
            .child(self.toolbar(cx))
            .child(
                div()
                    .id("document")
                    .flex_1()
                    .overflow_y_scroll()
                    .track_scroll(&self.scroll)
                    .cursor(CursorStyle::IBeam)
                    .on_mouse_down(MouseButton::Left, cx.listener(Self::on_mouse_down))
                    .on_mouse_move(cx.listener(Self::on_mouse_move))
                    .on_mouse_up(MouseButton::Left, cx.listener(Self::on_mouse_up))
                    .on_mouse_up_out(MouseButton::Left, cx.listener(Self::on_mouse_up))
                    .relative()
                    // Title, then one child per block (so `scroll_to_item(block + 1)`
                    // reveals the caret), room to scroll past the end, and the overlay.
                    .child(page_column(
                        div()
                            .pt_6()
                            .pb_2()
                            .text_size(px(12.))
                            .text_color(theme::muted())
                            .child(if title.is_empty() {
                                "Untitled".to_owned()
                            } else {
                                title
                            }),
                    ))
                    .children(rows.into_iter().map(page_column))
                    .child(div().h(px(240.)))
                    .child(overlay),
            )
            .child(self.status_bar(cx))
    }
}

/// Centres page content at reading width.
fn page_column(content: impl IntoElement) -> impl IntoElement {
    div()
        .w_full()
        .flex()
        .justify_center()
        .child(div().w_full().max_w(px(760.)).px_8().child(content))
}

/// Selection from `a` to `b` inside one block, line by line.
fn paint_selection(
    window: &mut Window,
    bounds: Bounds<Pixels>,
    line_height: Pixels,
    a: Point<Pixels>,
    b: Point<Pixels>,
    extra: Pixels,
) {
    let color = theme::selection();
    if a.y == b.y {
        let width = (b.x - a.x).max(px(0.)) + extra;
        window.paint_quad(fill(Bounds::new(a, size(width, line_height)), color));
        return;
    }
    window.paint_quad(fill(
        Bounds::new(a, size(bounds.right() - a.x, line_height)),
        color,
    ));
    let middle_top = a.y + line_height;
    if b.y > middle_top {
        window.paint_quad(fill(
            Bounds::new(
                point(bounds.left(), middle_top),
                size(bounds.size.width, b.y - middle_top),
            ),
            color,
        ));
    }
    window.paint_quad(fill(
        Bounds::new(
            point(bounds.left(), b.y),
            size(b.x - bounds.left() + extra, line_height),
        ),
        color,
    ));
}

impl EntityInputHandler for EditorView {
    fn text_for_range(
        &mut self,
        range: Range<usize>,
        actual_range: &mut Option<Range<usize>>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<String> {
        let len = self.editor.len();
        let range = range.start.min(len)..range.end.min(len);
        actual_range.replace(range.clone());
        Some(self.editor.text_in(range))
    }

    fn selected_text_range(
        &mut self,
        _ignore_disabled_input: bool,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<UTF16Selection> {
        Some(UTF16Selection {
            range: self.editor.selection(),
            reversed: self.editor.is_reversed(),
        })
    }

    fn marked_text_range(&self, _: &mut Window, _: &mut Context<Self>) -> Option<Range<usize>> {
        self.marked.clone()
    }

    fn unmark_text(&mut self, _: &mut Window, _: &mut Context<Self>) {
        self.marked = None;
    }

    fn replace_text_in_range(
        &mut self,
        range: Option<Range<usize>>,
        text: &str,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let range = range
            .or(self.marked.take())
            .unwrap_or_else(|| self.editor.selection());
        self.marked = None;
        if self.editor.replace(range, text) {
            self.changed(cx);
        }
    }

    fn replace_and_mark_text_in_range(
        &mut self,
        range: Option<Range<usize>>,
        text: &str,
        selected: Option<Range<usize>>,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let range = range
            .or(self.marked.clone())
            .unwrap_or_else(|| self.editor.selection());
        let start = range.start;
        self.editor.replace(range, text);
        let len = utf16::len(text);
        self.marked = (len > 0).then(|| start..start + len);
        if let Some(sel) = selected {
            self.editor
                .set_selection(start + sel.start, start + sel.end);
        }
        self.changed(cx);
    }

    fn bounds_for_range(
        &mut self,
        _: Range<usize>,
        _: Bounds<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<Bounds<Pixels>> {
        self.caret_bounds
    }

    fn character_index_for_point(
        &mut self,
        p: Point<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<usize> {
        Some(self.offset_for_point(p, false))
    }
}
