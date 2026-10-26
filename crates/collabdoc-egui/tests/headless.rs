//! The egui spike driven headless: egui's own input events, no window, no
//! GPU. What reaches the core document is what a real egui app would make.

use collabdoc_core::schema::mark_bit;
use collabdoc_core::{BlockKind, Document, Editor, ListKind};
use collabdoc_egui::{EditorView, install_fonts};
use egui::{Event, ImeEvent, Key, Modifiers, PointerButton, Pos2, RawInput, Rect, pos2, vec2};

struct Harness {
    ctx: egui::Context,
    view: EditorView,
    size: egui::Vec2,
    /// Where the widget sits on screen (run_ui's margin).
    origin: Pos2,
    /// What the last frame told the platform (clipboard, IME).
    output: egui::PlatformOutput,
}

impl Harness {
    fn new(width: f32) -> Self {
        let ctx = egui::Context::default();
        install_fonts(&ctx);
        let mut h = Self {
            ctx,
            view: EditorView::new(Editor::new(Document::create("t", "spike"))),
            size: vec2(width, 600.0),
            origin: Pos2::ZERO,
            output: Default::default(),
        };
        h.frame(vec![]);
        // Focus: click into the editor.
        h.click(pos2(5.0, 5.0));
        h
    }

    fn frame(&mut self, events: Vec<Event>) {
        let input = RawInput {
            screen_rect: Some(Rect::from_min_size(Pos2::ZERO, self.size)),
            events,
            ..Default::default()
        };
        let view = &mut self.view;
        let mut origin = Pos2::ZERO;
        let mut out = self.ctx.run_ui(input, |ui| {
            origin = ui.cursor().min;
            view.ui(ui);
        });
        // No renderer here to take the font atlas.
        out.textures_delta.clear();
        self.origin = origin;
        self.output = out.platform_output;
    }

    /// A click at `at` in the widget's coordinates.
    fn click(&mut self, at: Pos2) {
        let pos = at + self.origin.to_vec2();
        let button = |pressed| Event::PointerButton {
            pos,
            button: PointerButton::Primary,
            pressed,
            modifiers: Modifiers::NONE,
        };
        self.frame(vec![Event::PointerMoved(pos), button(true)]);
        self.frame(vec![button(false)]);
        self.frame(vec![]);
    }

    fn typed(&mut self, text: &str) {
        self.frame(vec![Event::Text(text.into())]);
    }

    fn key(&mut self, key: Key, modifiers: Modifiers) {
        let event = |pressed| Event::Key {
            key,
            physical_key: None,
            pressed,
            repeat: false,
            modifiers,
        };
        self.frame(vec![event(true), event(false)]);
    }

    fn texts(&self) -> Vec<String> {
        self.view
            .editor
            .blocks()
            .iter()
            .map(|b| b.text.clone())
            .collect()
    }
}

#[test]
fn typing_enter_backspace_marks_and_undo_reach_the_core() {
    let mut h = Harness::new(800.0);
    h.typed("Hello world");
    h.key(Key::Enter, Modifiers::NONE);
    h.typed("Second");
    assert_eq!(h.texts(), ["Hello world", "Second"]);
    h.key(Key::Backspace, Modifiers::NONE);
    assert_eq!(h.texts(), ["Hello world", "Secon"]);

    // Ctrl+B with nothing selected marks what is typed next.
    h.key(Key::B, Modifiers::COMMAND);
    h.typed("d!");
    let span = h.view.editor.blocks()[1].spans.last().unwrap().clone();
    assert_eq!((span.start, span.end), (5, 7));
    assert_ne!(span.marks & mark_bit("bold").unwrap(), 0);

    // Headings and lists through the same chords as the other builds.
    h.key(Key::Num1, Modifiers::COMMAND | Modifiers::ALT);
    assert_eq!(h.view.editor.blocks()[1].kind, BlockKind::Heading(1));
    h.key(Key::Num8, Modifiers::COMMAND | Modifiers::SHIFT);
    assert_eq!(h.view.editor.blocks()[1].list, Some(ListKind::Bullet));

    h.key(Key::Z, Modifiers::COMMAND);
    assert_eq!(h.view.editor.blocks()[1].list, None);
}

#[test]
fn a_click_lands_on_the_character_under_the_pointer() {
    let mut h = Harness::new(800.0);
    h.typed("first line");
    h.key(Key::Enter, Modifiers::NONE);
    h.typed("second line");
    // Where offset 3 of the second block is drawn, from the layout itself.
    let target = h.view.editor.block_start(1) + 3;
    h.view.editor.move_to(target);
    h.frame(vec![]);
    let caret = h.view.caret_rect().unwrap();
    h.view.editor.move_to(0);
    h.click(caret.center() + vec2(1.0, 0.0));
    assert_eq!(h.view.editor.head(), target);
    // Shift+click extends.
    let end = h.view.editor.len();
    h.view.editor.move_to(end);
    h.frame(vec![]);
    let caret = h.view.caret_rect().unwrap();
    h.view.editor.move_to(target);
    let pos = caret.center() + h.origin.to_vec2();
    let button = |pressed| Event::PointerButton {
        pos,
        button: PointerButton::Primary,
        pressed,
        modifiers: Modifiers::SHIFT,
    };
    h.frame(vec![
        Event::ModifiersChanged(Modifiers::SHIFT),
        Event::PointerMoved(pos),
        button(true),
    ]);
    h.frame(vec![button(false)]);
    h.frame(vec![Event::ModifiersChanged(Modifiers::NONE)]);
    assert_eq!(h.view.editor.selection(), target..end);
}

#[test]
fn up_and_down_follow_wrapped_rows_and_cross_blocks() {
    let mut h = Harness::new(220.0);
    h.typed("short");
    h.key(Key::Enter, Modifiers::NONE);
    h.typed("a much longer paragraph that wraps over several rows here");
    h.key(Key::Enter, Modifiers::NONE);
    h.typed("end");
    let long = h.view.editor.block_start(1);
    let rows = |h: &Harness| {
        let c = h.view.caret_rect().unwrap();
        (c.top() * 10.0).round() as i32
    };
    // From the last block up into the wrapped one: its last row.
    let y0 = rows(&h);
    h.key(Key::ArrowUp, Modifiers::NONE);
    let (index, _) = h.view.editor.locate(h.view.editor.head());
    assert_eq!(index, 1);
    let y1 = rows(&h);
    assert!(y1 < y0);
    // Up again stays in the same block, one row higher.
    h.key(Key::ArrowUp, Modifiers::NONE);
    assert_eq!(h.view.editor.locate(h.view.editor.head()).0, 1);
    assert!(rows(&h) < y1);
    // Shift+Down selects back down.
    h.key(Key::ArrowDown, Modifiers::SHIFT);
    assert!(h.view.editor.selection().start >= long);
    assert!(!h.view.editor.selection().is_empty());
}

#[test]
fn ime_composition_shows_but_only_the_commit_is_written() {
    let mut h = Harness::new(800.0);
    h.typed("日本");
    h.frame(vec![Event::Ime(ImeEvent::Preedit {
        text: "ご".into(),
        active_range_chars: None,
    })]);
    assert_eq!(h.view.preedit, "ご");
    assert_eq!(h.texts(), ["日本"]);
    h.frame(vec![Event::Ime(ImeEvent::Commit("語".into()))]);
    assert_eq!(h.texts(), ["日本語"]);
    assert!(h.view.preedit.is_empty());
    // The platform is told where the caret is, for the candidate window.
    assert!(h.output.ime.is_some());
}

#[test]
fn offsets_stay_right_past_characters_utf16_counts_twice() {
    let mut h = Harness::new(800.0);
    h.typed("a👍🏽b");
    assert_eq!(h.view.editor.head(), 6, "UTF-16 units");
    h.key(Key::ArrowLeft, Modifiers::NONE);
    h.key(Key::ArrowLeft, Modifiers::NONE);
    // The core moves by grapheme: the thumb and its skin tone are one step.
    assert_eq!(h.view.editor.head(), 1);
    let before = h.view.caret_rect().unwrap();
    h.key(Key::ArrowRight, Modifiers::NONE);
    assert_eq!(h.view.editor.head(), 5);
    let after = h.view.caret_rect().unwrap();
    assert!(after.left() > before.left() + 8.0, "the emoji has width");
    h.click(before.center());
    assert_eq!(h.view.editor.head(), 1);
    h.click(after.center());
    assert_eq!(h.view.editor.head(), 5);
}

#[test]
fn copy_paste_and_cut_go_through_markdown() {
    let mut h = Harness::new(800.0);
    h.frame(vec![Event::Paste("# Title\n\n- one\n- two".into())]);
    assert_eq!(h.texts(), ["Title", "one", "two"]);
    assert_eq!(h.view.editor.blocks()[0].kind, BlockKind::Heading(1));
    h.key(Key::A, Modifiers::COMMAND);
    h.frame(vec![Event::Cut]);
    assert_eq!(h.texts(), [""]);
    let copied = h.output.commands.clone();
    assert!(format!("{copied:?}").contains("# Title"), "{copied:?}");
}

/// Immediate mode lays out every frame; egui caches galleys by content, so
/// an idle frame over a long document is cheap. Printed, not asserted (the
/// numbers depend on the build); spec 25 quotes a release run.
#[test]
fn frame_time_on_a_long_document() {
    let mut h = Harness::new(900.0);
    let para = "A paragraph of ordinary prose, long enough to wrap once or twice in a window. ";
    let text: String = (0..2000).map(|i| format!("{i}. {para}\n\n")).collect();
    h.frame(vec![Event::Paste(text)]);
    assert_eq!(h.view.editor.blocks().len(), 2000);
    let time = |h: &mut Harness, events: Vec<Event>| {
        let start = std::time::Instant::now();
        h.frame(events);
        start.elapsed()
    };
    let idle = time(&mut h, vec![]);
    let typing = time(&mut h, vec![Event::Text("x".into())]);
    eprintln!("2000 blocks: idle frame {idle:?}, typing frame {typing:?}");
}

#[test]
fn the_input_method_rewrites_around_the_caret_and_text_ends_a_composition() {
    let mut h = Harness::new(800.0);
    h.typed("teh");
    // Autocorrect: three characters before the caret become "the".
    h.frame(vec![
        Event::Ime(ImeEvent::DeleteSurrounding {
            before_chars: 3,
            after_chars: 0,
        }),
        Event::Text("the".into()),
    ]);
    assert_eq!(h.texts(), ["the"]);
    // Counts are characters: one emoji is one, though UTF-16 counts two.
    h.typed(" 👍");
    h.frame(vec![Event::Ime(ImeEvent::DeleteSurrounding {
        before_chars: 1,
        after_chars: 0,
    })]);
    assert_eq!(h.texts(), ["the "]);

    // A browser finishes a composition with plain text: the preview goes.
    h.frame(vec![Event::Ime(ImeEvent::Preedit {
        text: "ご".into(),
        active_range_chars: None,
    })]);
    h.typed("語");
    assert!(h.view.preedit.is_empty());
    assert_eq!(h.texts(), ["the 語"]);
}
