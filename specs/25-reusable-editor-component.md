# 25 · A reusable editor component for GPUI and egui

## Question

Can the editor we have built (the Rust core under the Flutter build) become one reusable editing component, shipped in two Rust UI toolkits, GPUI and egui? And which ProseMirror and Tiptap features must it gain to stand in for them?

"egui" is read from the request ("EUI / EGPU"): the immediate-mode Rust toolkit, which runs on wgpu or OpenGL through `eframe`. Flutter stays a third host through `collabdoc-ffi`.

## Verdict

**Feasible, and most of it already exists.**
- The document model, every editing command, clipboard formats, undo, history, presence and the CRDT live in `collabdoc-core`. That crate has no UI dependency, and both Rust toolkits can call it directly with no FFI.
- What is not shared today is the view-side logic each host writes for itself:
  - the keymap;
  - moving by visual row;
  - hit-testing;
  - the `@` trigger;
  - decorations such as find hits, carets and claims;
  - IME bookkeeping.

  This is about a third of Flutter's `editor.dart` (~750 of 2,330 lines). The Phase 0 GPUI view has its own smaller copy.
- The component is the move of that logic into a headless crate, behind a small trait each toolkit implements over its own text layout.

**egui was proven with a spike** (`crates/collabdoc-egui`, ~550 lines). The widget draws `ViewBlock`s as egui galleys and sends egui's key, text, clipboard and IME events to the real `Editor`:
- **Headless tests:** 7 tests drive it through `egui::Context::run_ui` with real egui events: typing, Enter, Backspace, Ctrl+B with stored marks, headings and lists from the same chords, undo, and click hit-testing.
- **Row motion:** Shift+click, Up and Down across wrapped rows and blocks.
- **IME and Unicode:** an IME preedit that never reaches the document, then its commit; the platform is told where the caret is. UTF-16 versus character offsets stay right past emoji (the core moves by grapheme).
- **Clipboard:** Markdown paste and cut.
- **Real window:** `cargo run -p collabdoc-egui --example window` (eframe on OpenGL) renders headings, bold, italic, code, strike, highlight, links, nested lists, a quote and a code block. Typing, Enter, a Shift+Home selection and Ctrl+B work there under Xvfb.
- **Speed:** a 2,000-block document in a release build takes 2.9 ms for an idle frame and 13 ms for a typing frame. That is without virtualization (every block is laid out each frame) and with egui's galley cache doing the work. Laying out only the visible blocks brings both well under a frame.

**GPUI:** the `collabdoc-gpui` crate on this branch (Phase 0–1: blocks, marks, IME through `EntityInputHandler`) already calls `Editor` directly. It lacks lists, figures, find, history and presence. It would gain them by moving onto the component rather than by being written a second time.

## What the toolkits give, and what they lack

| Need | egui 0.37 | GPUI 0.2 | Flutter (via FFI) |
| --- | --- | --- | --- |
| Rich text layout, per-run styles | `LayoutJob` sections; bold and italic need their own font faces (Inter's four are bundled) | `TextRun`s on `StyledText` | `TextSpan` |
| Hit test, caret rect | `Galley::cursor_from_pos`, `pos_from_cursor` | `TextLayout::index_for_position`, `position_for_index` | `RenderParagraph` |
| Row up/down, row edges | `cursor_up_one_row`, `cursor_begin_of_row` (character offsets) | layout lines | `getLineBoundary`, `getOffsetForCaret` |
| IME | `Event::Ime(Preedit/Commit)`, `IMEOutput` caret rect | `EntityInputHandler` (marked text) | `TextInputClient` with deltas |
| Inline widgets (chips) | none: draw them over a placeholder run | none: a custom element | `WidgetSpan` |
| Complex scripts | harfrust shaping; **no bidi/RTL yet** | platform shaper; RTL unverified | full |
| Accessibility | AccessKit built in | partial | full |
| Long documents | immediate mode: virtualize to the visible blocks | retained list (`uniform_list`, `list`) | `ListView.builder` |

Offsets: the core counts UTF-16 units (as Dart and JS do) while egui counts characters. The spike's `Laid` converts per block, which is cheap; the component keeps UTF-16 and each host converts at its edge.

## Proposed shape

```
collabdoc-core       document, schema, commands (Editor), Loro, history, presence, clipboard formats
      │
collabdoc-editor     headless component: state + transactions, extensions, keymap, input/paste rules,
      │              suggestions, decorations, node-view contract, events. No pixels.
      ├── collabdoc-editor-egui    a Widget: galleys, painter, egui events → component
      ├── collabdoc-editor-gpui    an Element: text runs, InputHandler, actions → component
      └── collabdoc-ffi            the same component behind the JSON calls (Flutter)
```

The component asks each host for one thing it cannot know, text geometry:

```rust
pub trait TextGeometry {
    /// Global offset under a point; caret rect at an offset.
    fn offset_at(&self, point: Point) -> usize;
    fn caret_rect(&self, offset: usize) -> Rect;
    /// The same column one visual row up/down (None at the edge of a block).
    fn row_step(&self, offset: usize, down: bool, goal_x: Option<f32>) -> Option<(usize, f32)>;
    /// Start and end of the visual row holding `offset` (Home/End).
    fn row_edges(&self, offset: usize) -> (usize, usize);
}
```

The component then implements:
- moving and selecting by row across blocks;
- visual Home and End;
- double- and triple-click selection;
- dragging with autoscroll requests.

It does this once, and the spike's `vertical` becomes host-independent.

Hosts send it neutral input:
- `Key { key, mods }`, `Text`, `ImePreedit`, `ImeCommit`;
- `Paste { text, html, image }`;
- pointer down, drag and up, with a click count.

From the component they read:
- the view (`ViewBlock`s with spans, already);
- decorations;
- the selection;
- suggestion state;
- events.

## Aligning with ProseMirror and Tiptap

✓ we have it · ◐ partly · ✗ missing. "TS app" is what the Electron build's Tiptap configuration uses (`src/renderer/src/editor/schema.ts`, `extensions.ts`), so ✗ there means a parity gap, not a nice-to-have.

### The model

| ProseMirror / Tiptap | Us today | Needed |
| --- | --- | --- |
| **Schema**: node and mark specs, content expressions, attrs, `parseHTML`/`renderHTML` | ◐ `schema.rs` is fixed lists. HTML and Markdown are written by hand per node. | A declarative `Schema`: node specs with content rules, groups, attrs and defaults, and marks with `inclusive`/`excludes`. Parsing and serializing are looked up per spec, so an extension can add a node. |
| **Document and positions**: `ResolvedPos`, `nodeAt`, depth | ◐ global UTF-16 offsets over textblocks (`locate`, `block_start`) plus Loro cursors | A `Pos` that can also address container nodes (list, quote) and atoms, for node selection and drag. |
| **Steps, `Mapping`, `Transaction`** with meta | ◐ each command is a Loro commit, and Loro cursors map positions for remote edits | `Transaction`: several commands as one undo step and one commit, plus `meta`, `selection_after`, `doc_changed`, and a local `Mapping` so decorations follow edits. |
| **Selections**: Text, Node, All, `GapCursor` | ◐ text ✓, all ✓, a figure selected when the caret is on it (◐) | An explicit `NodeSelection` (figure, rule, a whole list item), and `GapCursor` between two figures, where no text position exists today. |
| **Stored marks** | ✓ | |
| **Undo/redo**, grouping | ✓ Loro `UndoManager` per participant, cut at 1 s idle or a block switch | `addToHistory: false` per transaction (remote and system edits already are). |
| **Collaboration** (y-prosemirror / `loro-prosemirror`), collaboration cursors | ✓ Loro, same layout as `loro-prosemirror`; presence with carets and claims ✓ | |

### Commands and input

| ProseMirror / Tiptap | Us today | Needed |
| --- | --- | --- |
| **Commands**: `chain()`, `can()`, `run()` | ◐ ~40 commands on `Editor`, run one at a time | `can()` as a dry run (to grey out buttons), `chain()` building one transaction, and `focus()` as a chain step. |
| `isActive`, `getAttributes` | ◐ `marks_at_cursor`, `kind_at_cursor`, `link_at` | One `is_active(name, attrs)` and `attributes(name)` for toolbars in every host. |
| **Keymap** (`Mod-b`, platform `Mod`) | ◐ per host: `_onKey` in Dart, GPUI actions, the spike's `key` | In the component, per extension, with `Mod` = Cmd on macOS and Ctrl elsewhere. Hosts only translate their key events. |
| **Input rules** (StarterKit: `# `, `- `, `1. `, `[ ] `, `> `, ```` ``` ````, `---`, `**x**`, `*x*`, `` `x` ``, `~~x~~`, `==x==`) | ✗ | **Parity gap**: TS app users type Markdown shortcuts. Rules are a regex on the text before the caret, then a command, and undoing one gives the typed text back (`undoInputRule`). |
| **Typography** (smart quotes, `—`, `…`, `→`, `©`, `½`) | ✗ | **Parity gap** (TS app enables `Typography`): input rules, as above. |
| **Paste rules**, **autolink** (`link: {autolink: true}`) | ◐ HTML and Markdown paste ✓, image paste ✓, Mermaid paste ✓; autolink ✗ | Autolink on typing and paste (URL then space). Paste rules per extension. |
| **Suggestion** (mention `@`, slash `/`) | ◐ `@` opens a picker in Flutter only | In the component: trigger character, active range, query, and the items from the extension (the registry for `@`). Hosts render the popup. `/` slash commands to insert blocks are new. |
| **Clipboard** (`clipboardSerializer`, `transformPasted`) | ✓ Markdown + HTML out; HTML, Markdown, text and images in | |
| **Drag and drop**, drop cursor | ✗ | Drag blocks and figures, and drop files. Needs `NodeSelection` and a drop position from `TextGeometry`. |

### View-side contracts

| ProseMirror / Tiptap | Us today | Needed |
| --- | --- | --- |
| **Decorations**: inline, node, widget | ◐ each host paints find hits, remote carets, claims, the attribution gutter and the version banner its own way | One `decorations()` set with inline (range + style class), node (block + class) and widget (offset + kind) entries, mapped through transactions. Hosts own the look; the component owns which and where. |
| **NodeViews** (figures, task checkbox) | ◐ Flutter's `FigureView`; egui and GPUI draw a label | A node-view contract: the component gives the node, attrs, selected state and actions (set width, align, caption, source); the host draws. Figures already render natively in the core (Mermaid → PNG, images from assets), so every host shows the same bitmap. |
| **Placeholder** | ✗ (TS app has one) | A decoration on the empty document. |
| **BubbleMenu / FloatingMenu** | ✗ | Host UI, fed by the selection rect from `TextGeometry` and `is_active`. |
| **Events**: `update`, `selectionUpdate`, `transaction`, `focus`, `blur` | ◐ hosts poll the view diff after each call | An event list returned from each `dispatch`. |
| `getJSON` / `setContent` / `getHTML` / `getText` | ◐ HTML ✓, Markdown ✓, text ✓, JSON partial (`tree::to_json` for nodes) | ProseMirror JSON for the whole document, in and out, so the TS app and agents can exchange documents in it. |
| **Extensions**: `Node.create`, `Mark.create`, `addCommands`, `addKeyboardShortcuts`, `addInputRules`, `addPasteRules`, `addProseMirrorPlugins`, `addStorage`, `addOptions` | ✗ | An `Extension` trait with the same hooks: schema contribution, commands, keymap, input/paste rules, decorations, node view name, storage. The core's built-ins become extensions (StarterKit = paragraph, headings, lists, task list, quote, code block, rule, hard break, the nine marks). |
| **TextAlign** on headings and paragraphs | ✗ (the attribute survives untouched in Loro but is not shown or set) | **Parity gap**: an attribute plus commands; hosts align rows. |
| **Tables** | ✗ (neither does the TS app) | Not needed for parity; the hardest extension to add later (cell selection, column layout). |

## Plan, if we go ahead

Each step keeps the Flutter build working and the TS parity tests green.

1. **`collabdoc-editor` crate, no behaviour change.**
   - Move the keymap, row motion (behind `TextGeometry`), click-count selection, the `@` trigger and find stepping out of `editor.dart` and the spike into the crate.
   - Flutter calls them through FFI (`cd_call` gains `key`, `pointer` and `ime` ops).
   - Tests: the spike's 7 tests plus Flutter's 33.
2. **Transactions, `can()` and chains, `is_active`, events, decorations.** Hosts drop their own decoration code (find, carets, claims, gutter).
3. **Parity gaps with the TS app:** input rules, Typography, autolink, placeholder, TextAlign. Each is ported with the Tiptap behaviour as the test.
4. **Extensions and schema:** the built-ins re-expressed as extensions; ProseMirror JSON in and out; `NodeSelection`, `GapCursor`, drag and drop.
5. **egui host to parity:**
   - figures as node views;
   - chips drawn over their placeholder;
   - virtualization (`ScrollArea::show_viewport`);
   - AccessKit roles.
6. **GPUI host on the component**, replacing the Phase 0 view.

Steps 1–2 are the component; 3 is parity work owed anyway; 4–6 are what "ship in GPUI and egui" costs on top.

## Risks

- **RTL and bidi in egui.** epaint 0.37 shapes with harfrust but its layout says bidi is not supported yet. Hebrew or Arabic documents would display in logical order. If RTL matters, GPUI or Flutter must be the shipping host until egui adds it.
- **Inline widgets** (mention chips, future inline math) are not a primitive in egui or GPUI. They are drawn over a one-character placeholder run, which the spike shows keeps offsets 1:1. Chips wider than a character need the placeholder to take the chip's width (a sized space or a custom glyph run), which is real work in both toolkits.
- **Two Rust UI toolkits to keep current.** GPUI 0.2 on crates.io trails Zed's own copy, and egui ships a breaking release every few months (0.37 already changed `App::update` to `App::ui`). Keeping hosts thin (steps 1–2) is what makes this affordable.
- **Accessibility.** egui has AccessKit; GPUI's support is partial. Screen-reader parity with the TS app (ProseMirror on the DOM) needs work in either.

## Files

- `crates/collabdoc-egui/src/lib.rs`: the spike widget (`EditorView`, `install_fonts`).
- `crates/collabdoc-egui/tests/headless.rs`: the 7 headless tests and the frame timing.
- `crates/collabdoc-egui/examples/window.rs`: the same widget in an eframe window.
