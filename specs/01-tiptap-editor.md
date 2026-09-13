# 01 · Tiptap rich-text editor with Markdown and illustrations

**Phase:** 1 · **Depends on:** — · **Status:** not started

## Summary

Replace the `<textarea>` in `Workspace.tsx` with a Tiptap 3 editor that supports the block types and marks agents will later be allowed to produce, exposes stable block ids, and keeps the current CollabDoc toolbar/rail look. Two capabilities are **must-haves in this feature**, not later polish:

1. **Markdown** as a first-class import/export format (open `.md`, save `.md`, paste Markdown, copy as Markdown) with a lossless mapping for every supported node — including figures.
2. **Illustrations**: Mermaid diagrams, AntV Infographics, and images — each a block with an optional caption, editable in place, rendered offline, and addressable by agents as *source text* so a Writer can draw and a Reviewer can comment on a diagram.

This feature is editor-only: content still lives in React state as ProseMirror JSON until 03 connects it to Loro.

## Current state (collabdoc)

- `screens/Workspace.tsx` renders `<TextArea className="page__body">`; the toolbar inserts Markdown syntax around the selection (`applyWrap`).
- "@ mention" inserts a literal `@`; "Comment" wraps the selection in `«»`.
- `DocumentSession.content` is a Markdown string; `lib/document-file.ts` parses a `# Title` header. No Markdown library is installed.

## Reference (lorocollab)

Editor core:
- `client/editor/schema-extensions.ts` — the extension list (StarterKit subset, Heading 1–4, lists, task list, Highlight, Link, Underline, Subscript/Superscript, TextAlign, Typography).
- `client/extensions/block-id.ts`, `client/block-id-plugin.ts` — `blockId` attrs on block nodes.
- `client/components/EditorToolbar.tsx` (682 lines), `SearchReplace.tsx`, `SelectionBar.tsx` — behaviour to keep, markup to redo.
- `shared/constants.ts` — `ALLOWED_NODES` (already lists `image`, `imageFigure`, `mermaidFigure`, `infographicFigure`), `ALLOWED_MARKS`, `BLOCK_ID_TYPES`, `TEXT_STYLE_CONFIG`.
- `client/editor/text-style-parity.ts` + test.

Illustrations (port after review):
- `client/extensions/mermaid-figure.ts` — `mermaidFigure` node: `attrs { source, style }`, caption as inline content, node view with lazy render, error state, source textarea, caption toggle; `Mod-Alt-m`.
- `client/extensions/infographic-figure.ts` — `infographicFigure`, same shape over `@antv/infographic`.
- `client/extensions/figure-caption.ts` — caption chrome, pointer guards, `SyntaxFigureCaptionKeys` (typing into a selected figure goes to the caption).
- `core/tree.ts#isSyntaxFigure / syntaxSourceOf / setSyntaxSource / blockAgentText` — agents read/edit the *source* of a figure; `caption` is exposed as `attrs.caption` in block views. This is what makes diagrams part of the agent tool surface for free.
- `server/llm-agent.ts` writer prompt — the `insert_blocks { type: mermaidFigure, text: "flowchart LR …" }` convention.
- `EditorToolbar.tsx#insertImage` — `readAsDataURL` with a 2 MB cap; `@pentestpad/tiptap-extension-figure` (`imageFigure` with resize + caption).

Markdown: **nothing to port** — lorocollab has no Markdown support.

## Review before adopting

Editor core:
- `EditorToolbar.tsx` is one 680-line component with its own icon set and inline styles. Rebuild with `components/ui.tsx` primitives; do not import lorocollab CSS.
- `block-id-plugin.ts`: verify ids are unique after paste-of-self and list split/join, and that copy/paste inside the same document yields a *new* id (comments must not follow the copy).
- `schema-extensions.ts` disables Tiptap `History` because Loro owns undo. Keep History enabled behind a flag until 03.
- Link `autolink: true`; `openOnClick` must be off — links go through `openExternalUrl` in main.

Illustrations:
- **Images are base64 data URIs in node attrs.** In a CRDT that means every 2 MB image is in the document, every snapshot, every history diff, and every guest's initial sync. Change to **assets**: `imageFigure.attrs.src = "asset:<sha256>"`; bytes live in the document's asset store (04 amends the `.collabdoc` container; 08 transfers assets to guests on demand). Data URIs are accepted on paste/import and converted to assets immediately. Keep the 2 MB per-image cap and add a 25 MB per-document cap for v1.
- `mermaid` is 84 MB on disk / several MB bundled and `@antv/infographic` ~14 MB. Both must be **dynamically imported** on first figure render; the editor must be interactive before either loads, and a document with no figures must never load them.
- `@antv/infographic` is **0.2.x** with a custom DSL. Pin an exact version, wrap render in a try/catch that shows the source with the error, and isolate it behind `SyntaxFigure` so removing it later needs no document migration (the node type and source string stay; only the renderer changes).
- `securityLevel: "strict"` for Mermaid is right and must stay — diagram source arrives from agents and guests. Also verify Mermaid's injected `<style>` and any `foreignObject` labels render under the renderer CSP (`style-src 'unsafe-inline'` is allowed; `htmlLabels: false` if needed).
- `style` is a free-form attr string rendered as inline CSS and accepted from remote peers. Replace with `width: number | null` and `align: "left" | "center" | "right"`; never render arbitrary CSS from document data.
- Node views register `document.addEventListener("click", …)` per instance and use a module-level `renderSeq`; ensure `destroy()` removes listeners and abandons in-flight renders (render after destroy must not touch the DOM).
- Source is edited in a `<textarea>` inside the node view. Keep in-place editing but move it to a proper **source panel** (split view: source / live preview, error line highlighted, Apply/Cancel, `Esc` cancels) shared by Mermaid and Infographic.
- `@pentestpad/tiptap-extension-figure` is a small third-party package for one node. Decide during implementation: keep it, or implement `imageFigure` ourselves on `@tiptap/extension-image` with the **same node name and attrs** (`src`, `alt`, `width`, `align`, caption as content) so agent tool docs and Loro shape are unchanged either way.
- Fonts: Mermaid is initialised with `"Source Sans 3"`; use the app's font stack and ship it locally (no network fetch).

## Design

### Schema

- `src/renderer/src/editor/extensions.ts` — core set as in lorocollab plus `ImageFigure`, `MermaidFigure`, `InfographicFigure`, `FigureCaptionKeys`, `Markdown`.
- Figure nodes share one shape: `group: block`, `content: inline*` (caption), `draggable`, `isolating`, `attrs { source | src, width, align }`, `blockId`. A generic `SyntaxFigure` factory builds Mermaid and Infographic from a `{ name, defaultSource, render(source, el): Promise<void> }` descriptor.
- Node ids, `ALLOWED_NODES`, `BLOCK_ID_TYPES` remain the lorocollab names so 02's agent tools and prompts work unchanged.

### Illustration UX

- Toolbar **Insert** menu: Image (file picker), Mermaid diagram, Infographic; slash-less for now. Keyboard `Mod+Alt+M` (Mermaid), `Mod+Alt+I` (Infographic), `Mod+Alt+P` (image).
- Paste/drop: image files and image data from the clipboard become `imageFigure` (converted to assets); pasted text starting with `flowchart|graph|sequenceDiagram|classDiagram|stateDiagram|erDiagram|gantt|pie|mindmap|timeline` becomes a Mermaid figure on confirm (small popover "Insert as diagram?").
- Selected figure shows controls: Edit source (Mermaid/Infographic), Replace (image), Caption +/−, width presets (50/75/100 %), align, Copy source, Delete.
- Source panel: split source/preview with 300 ms debounced render; syntax errors show the message and line; Apply commits one transaction; Cancel restores.
- Rendering is client-side and offline; renders are cached per `(type, source, width)` in memory; the same source in two places renders once.
- Export a figure as SVG/PNG to a file (context menu) — Mermaid via `mermaid.render` SVG, Infographic via its export API, image as the stored asset.

### Markdown

- Library: `@tiptap/markdown` (Tiptap 3) with custom serializer/parser rules registered per node:
  - `mermaidFigure` ↔ fenced ```` ```mermaid ```` block with the caption in the fence **info string** (` ```mermaid caption="Release flow" `). Alternatives considered: a trailing `<!-- caption -->` comment (invisible on GitHub, easy to orphan) and a following italic line (ambiguous on parse). The info string survives GitHub rendering, is one line, and parses back unambiguously.
  - `infographicFigure` ↔ ```` ```infographic caption="…" ```` fence with the DSL as body.
  - `imageFigure` ↔ `![alt](path "caption")` where `path` is `assets/<sha256>.<ext>` on export (the exporter writes the asset files next to the `.md`; the importer reads relative paths and embeds them as assets) and a data URI when exporting "single file".
  - `taskItem` ↔ `- [ ] / - [x]`; `highlight` ↔ `==text==`; `underline` ↔ `<u>` (no Markdown syntax; documented); `superscript/subscript` ↔ `^x^` / `~x~`; `mention` (10) ↔ `@handle`.
- Surfaces: Open `.md` (import), Save as `.md` / Export Markdown (04 keeps `.collabdoc` as the storage format), **Paste Markdown** (clipboard text that parses as Markdown with ≥ 1 block construct is offered as rich content; plain text otherwise), **Copy as Markdown** on any selection, and a read-only **Markdown source** view in the rail for the current block (agents and humans then speak the same language when comparing).
- Round-trip is a hard requirement (AC-01.6/01.13): for every supported node/mark, `parse(serialize(doc)) ≡ doc` up to block ids and asset hashes.
- Title stays metadata; on export it is written as the first `# Heading` only if the document does not already start with an H1 (current `document-file.ts` convention, kept).

### Everything else

- Toolbar: Undo/Redo, block type select, marks, Link, lists, align, Insert menu, Find & replace, and the AI affordances (`@` mention, Comment) disabled until 10 and 09.
- Selection bar: Bold/Italic/Link/Comment/Ask-agent (last two stubbed).
- Keyboard: Tiptap defaults, `Mod+F`, the figure shortcuts above; `Mod+S/O/N/,` stay in `App.tsx`.

## Acceptance criteria

Editor core:
- [ ] AC-01.1 The workspace shows a Tiptap editor; typing, Enter, Backspace and plain-text paste behave as a standard rich-text editor. The `<textarea>` is gone.
- [ ] AC-01.2 Supported blocks: paragraph, heading 1–4, blockquote, code block, bullet/ordered/task lists, horizontal rule, image figure, Mermaid figure, Infographic figure. Marks: bold, italic, underline, strike, code, link, highlight, superscript, subscript. Nothing else can be produced via UI, paste or import (unknown HTML is stripped, not preserved).
- [ ] AC-01.3 Every block node in `BLOCK_ID_TYPES` (figures included) carries a `blockId` that is unique, stable across in-block edits, and regenerated for pasted/duplicated blocks.
- [ ] AC-01.4 Toolbar reflects the active state of the selection; every control is keyboard reachable with an `aria-label`.
- [ ] AC-01.5 Find & replace (`Mod+F`) with count, highlight, next/previous, replace one/all, case-insensitive by default; matches inside figure captions are included, figure sources are not.
- [ ] AC-01.7 Clicking a link does not navigate the window; it opens externally via `openExternalUrl` (http/https only).
- [ ] AC-01.8 A 200 KB document (≈ 2 000 paragraphs, 20 figures) stays responsive: typing latency < 50 ms (Playwright); figure renders never block typing (rendered off the main transaction path).
- [ ] AC-01.9 `text-style-parity` test passes against `TEXT_STYLE_CONFIG`.
- [ ] AC-01.10 Title input, dirty indicator, window title and unsaved dialog keep working.

Markdown:
- [ ] AC-01.6 Opening an existing `.md` renders headings, lists (incl. task lists), emphasis, links, code blocks, images and ```` ```mermaid ```` fences as rich content; saving back produces Markdown that round-trips open → save → open with no structural change for the supported set.
- [ ] AC-01.11 Round-trip property test: for a generated corpus covering every node/mark (including all three figure types with and without captions, nested lists, marks spanning links), `parse(serialize(doc))` equals `doc` modulo block ids and asset hashes; ≥ 500 random documents, runs in CI.
- [ ] AC-01.12 Figures serialise as fences with the caption in the info string (` ```mermaid caption="…" `, ` ```infographic caption="…" `) and images as `![alt](assets/<hash>.<ext> "caption")` with asset files written beside the `.md`; the "single file" export embeds data URIs instead; both re-import to identical documents.
- [ ] AC-01.13 Paste Markdown: pasting text with at least one block construct (heading, list, fence, image) inserts rich content; plain prose pastes as paragraphs; a paste can be forced to plain text with `Mod+Shift+V`.
- [ ] AC-01.14 Copy as Markdown on a selection puts Markdown on the clipboard (`text/plain`) alongside HTML; copying a figure yields its fence.
- [ ] AC-01.15 The rail "Markdown source" view shows the current block's Markdown, updating live, and is read-only.

Illustrations:
- [ ] AC-01.16 Insert Mermaid → a default flowchart renders inline within 1 s on first use (library loads lazily; the editor was interactive before) and within 100 ms for subsequent figures; a document without figures never loads `mermaid` or `@antv/infographic` (assert on loaded chunks).
- [ ] AC-01.17 Edit source: changing the source in the panel live-previews; a syntax error shows the message and line and does not replace the last good render; Apply commits exactly one transaction; Cancel/`Esc` restores; the Loro/JSON shape after Apply is `attrs.source` = new text.
- [ ] AC-01.18 Captions: Caption +/− toggles an inline-editable caption; typing while a figure is selected goes to the caption, never replaces the figure; captions appear in `get_blocks` as `attrs.caption` (verified once 02 lands, stubbed test until then).
- [ ] AC-01.19 Infographic: the default DSL renders; the same source panel, error handling and caption behaviour apply; the renderer is behind `SyntaxFigure` so the node type/source survive if the library is swapped (unit test renders a `infographicFigure` with a stub renderer).
- [ ] AC-01.20 Images: file picker, paste from clipboard, and drag-drop all produce an `imageFigure`; the bytes are stored as an asset (`src = "asset:<sha256>"`), not a data URI, and a data URI pasted/imported is converted; > 2 MB is refused with a notice; the same image inserted twice stores one asset.
- [ ] AC-01.21 Figure controls: width presets and align update `attrs.width/align` (numbers/enums only — a document containing an arbitrary `style` string renders with defaults and the string is dropped); Replace swaps the asset; Delete removes the block.
- [ ] AC-01.22 Security: Mermaid runs with `securityLevel: "strict"`; a diagram containing `click A href "javascript:…"` or HTML labels renders without executing or navigating (Playwright asserts no navigation and no dialog); Infographic render errors are contained to the figure.
- [ ] AC-01.23 Export figure: SVG and PNG export of a Mermaid figure and an Infographic, and "Save image" for an image figure, write files via the native save dialog.
- [ ] AC-01.24 Renders are memoised: two figures with identical source and width trigger one render; re-rendering after `destroy()` (figure deleted mid-render) does not throw or touch the DOM (unit test with a delayed stub renderer).

## Out of scope

Tables; slash-command menu; collaborative cursors (07); comments (09); mentions (10); assets larger than 2 MB / per-document > 25 MB (raise caps once 04/08 measure sync cost); video/audio embeds; Excalidraw-style freehand drawing.

## Open questions

- Keep `@pentestpad/tiptap-extension-figure` or own `imageFigure`? Decide on maintenance signal at implementation; the schema contract above holds either way.
- `@antv/infographic` API stability: pin exact; re-evaluate at each minor.
