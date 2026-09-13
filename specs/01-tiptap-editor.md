# 01 · Tiptap rich-text editor

**Phase:** 1 · **Depends on:** — · **Status:** not started

## Summary

Replace the `<textarea>` in `Workspace.tsx` with a Tiptap 3 editor that supports the block types and marks agents will later be allowed to produce, exposes stable block ids, and keeps the current CollabDoc toolbar/rail look. This feature is editor-only: content still lives in React state as a serialised document until 03 connects it to Loro.

## Current state (collabdoc)

- `screens/Workspace.tsx` renders `<TextArea className="page__body">`; the toolbar inserts Markdown syntax around the selection (`applyWrap`).
- "@ mention" inserts a literal `@`; "Comment" wraps the selection in `«»`.
- `DocumentSession.content` is a Markdown string; `lib/document-file.ts` parses a `# Title` header.

## Reference (lorocollab)

- `client/editor/schema-extensions.ts` — the exact extension list (StarterKit subset, Heading 1–4, lists, task list, Highlight, Link, Underline, Subscript/Superscript, TextAlign, Typography).
- `client/extensions/block-id.ts`, `client/block-id-plugin.ts` — assigns `blockId` attrs to block nodes on creation/split; this is the id agents and comments address.
- `client/components/EditorToolbar.tsx` (682 lines), `SearchReplace.tsx`, `SelectionBar.tsx` — behaviour to keep; markup to redo.
- `shared/constants.ts` — `ALLOWED_NODES`, `ALLOWED_MARKS`, `BLOCK_ID_TYPES`, `HEADING_LEVELS`, `TEXT_STYLE_CONFIG`.
- `client/editor/text-style-parity.ts` + `.test.ts` — asserts the Tiptap mark inclusivity matches Loro's text style config. Keep this idea; it prevents a class of "same edit, different marks" bugs.

## Review before adopting

- `EditorToolbar.tsx` is one 680-line component with its own icon set and inline styles. Rebuild it with `components/ui.tsx` primitives (`Button`, `Icon`); do not import lorocollab CSS.
- `MermaidFigure`, `InfographicFigure`, `ImageResizeWithCaption` pull in mermaid (~2 MB) and AntV. Defer all three; the schema should be extensible so they can be added later without migrating documents.
- `block-id-plugin.ts` regenerates ids on paste in some paths; verify ids are unique after paste-of-self and after list split/join, and that a copy/paste inside the same document yields a *new* id (comments must not follow the copy).
- `schema-extensions.ts` disables Tiptap `History` because Loro owns undo. Until 03 lands, keep Tiptap History enabled behind a flag so 01 is usable on its own.
- Link mark has `autolink: true`; decide whether autolink should also `openOnClick` inside Electron (it should not — links must go through `openExternalUrl` in main).

## Design

- New `src/renderer/src/editor/` with `extensions.ts` (schema), `block-id.ts`, `useCollabEditor.ts`.
- New `components/EditorToolbar.tsx` using the existing `.toolbar` styles: Undo/Redo, block type select (Paragraph, H1–H4, Quote, Code), Bold/Italic/Underline/Strike/Code/Highlight, Link, lists (bullet, ordered, task), align, Find & replace, and the two AI affordances (`@` mention, Comment) left disabled until 10 and 09.
- Document title stays a separate input (`page__title`) — it is metadata, not a block.
- `DocumentSession.content` becomes ProseMirror JSON during this feature; `lib/document-file.ts` gains `markdownToDoc` / `docToMarkdown` (use `@tiptap/markdown` or `prosemirror-markdown`; pick one and record it) so Open/Save keep working.
- Selection bar (floating on text selection) shows Bold/Italic/Link/Comment/Ask-agent; the last two are stubs until 09/14.
- Keyboard: standard Tiptap keymaps plus `Mod+F` for find/replace; `Mod+S/O/N/,` continue to be handled in `App.tsx`.

## Acceptance criteria

- [ ] AC-01.1 The workspace shows a Tiptap editor; typing, Enter, Backspace, and paste of plain text behave as in a standard rich-text editor. The `<textarea>` is gone.
- [ ] AC-01.2 Supported blocks: paragraph, heading 1–4, blockquote, code block, bullet/ordered/task lists, horizontal rule. Supported marks: bold, italic, underline, strike, code, link, highlight, superscript, subscript. Nothing else can be produced via UI or paste (unknown HTML is stripped, not preserved).
- [ ] AC-01.3 Every block node listed in `BLOCK_ID_TYPES` carries a `blockId` attribute that is present in the editor JSON, unique within the document, stable across edits inside the block, and regenerated for pasted/duplicated blocks.
- [ ] AC-01.4 The toolbar reflects the active state of the selection (e.g. Bold pressed when the cursor is in bold text) and every button is keyboard reachable and has an `aria-label`.
- [ ] AC-01.5 Find & replace (`Mod+F`) finds matches across the document with a count, highlights them, supports next/previous, replace one, replace all, and is case-insensitive by default.
- [ ] AC-01.6 Opening an existing `.md` file renders headings, lists, emphasis, links and code blocks as rich content; saving it back produces Markdown that round-trips through open → save → open with no structural change for the supported node set.
- [ ] AC-01.7 Clicking a link in the editor does not navigate the Electron window; it opens in the system browser via the existing `openExternalUrl` guard (http/https only).
- [ ] AC-01.8 Rendering a 200 KB document (≈ 2 000 paragraphs) stays responsive: typing latency under 50 ms as measured by a Playwright test.
- [ ] AC-01.9 A `text-style-parity` unit test exists and passes, asserting that mark inclusivity in the Tiptap schema matches the `TEXT_STYLE_CONFIG` table that 02 will hand to Loro.
- [ ] AC-01.10 The document title input, dirty indicator, window title and unsaved-changes dialog keep working exactly as before.

## Out of scope

Mermaid / infographic / image figures with captions; tables; collaborative cursors (07); comments (09); mentions (10).

## Open questions

- Markdown library: `@tiptap/markdown` (Tiptap 3, maintained) vs `prosemirror-markdown` (battle-tested). Decide during implementation; the constraint is task-list and highlight support.
