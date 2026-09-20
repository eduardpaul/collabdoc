# 22 · Save As Word (.docx): figures, page layout and document configuration

**Phase:** 1 · **Depends on:** 01, 04 · **Status:** not started

## Summary

Add a **Save As** that targets `.collabdoc`, `.md` or `.docx` by the extension the user picks, and a Word exporter modelled on `../obsidian-docx-builder`: Mermaid and Infographic blocks become sharp PNG figures with a visible caption and alt text, images are embedded from the asset store, the page has explicit A4/Letter geometry and margins, a Word TOC field, heading styles and bookmarks, and the whole build is driven by a small **per-document configuration** stored in the document and shared with collaborators. The document stays `.collabdoc`-backed; `.md` and `.docx` are export targets, exactly as 04 defines Markdown.

Unlike the POC, nothing external is required: no Pandoc, no Puppeteer. CollabDoc already renders both diagram kinds in Chromium (01), and the OpenXML the POC patched after Pandoc is written directly with the `docx` library.

## Current state (collabdoc)

- `File → Save As…` (`documents:saveAs` in `src/main/documents/ipc.ts`) only offers the `CollabDoc` filter and calls `store.saveTo`.
- `File → Export Markdown…` / `…with Comments…` → `useSessionActions.ts#exportMarkdown` → `documents:exportMarkdown` writes the `.md` and `assets/<hash>.<ext>` beside it.
- Figures render to SVG in the renderer (`editor/figures/mermaid-runtime.ts#renderMermaidSvg`, `editor/figures/infographic-runtime.ts#renderInfographic`); `editor/figures/export.ts#exportSelectedFigure` already rasterises one figure to PNG through a canvas (`svgToPng`).
- Images are content-addressed assets (`asset:<sha256>`) held in main by `src/main/persist/assets.ts#DocumentAssets` (`store.getAssets(docId)`), ≤ 2 MB each, ≤ 25 MB per document.
- Main walks the Loro tree for non-editor readers in `src/core/markdown.ts#documentToMarkdown` (MCP resource, 16); document meta is `{ docId, title, schemaVersion, createdAt }` (`src/core/document.ts#readMeta`).
- The schema has no `table` and no callout node (01 out of scope).

## Reference (`../obsidian-docx-builder`)

Read for behaviour; its core library (`scripts/lib/core.mjs`, `scripts/docx-builder.mjs`) is not in the copy, so the README and `test/*.test.mjs` are the contract:

- `README.md` — figure text convention (`accTitle` = caption, `accDescr` = alt text, with fallbacks), full-writable-width centred figures, 4× device scale, A4 with explicit margins, `updateFields`, table style, the `mermaid` and `infographic` config tables, `build-report.json` contents, warning vs fatal policy.
- `test/integration.test.mjs` — the OpenXML assertions worth keeping: `TOC \o "1-3"`, `Heading1` styles, `w:anchor` bookmarks, `wp:docPr descr=` alt text, `w:jc center`, `w:pgSz 11906×16838`, `w:pgMar`, `w:updateFields`, hash-named PNGs and `reused: true` on the second build.
- `test/core.test.mjs` — `mmToDxa` (210 mm = 11906 dxa), `distributeColumnWidths` (for when tables land), `extractMermaidMetadata`, heading validation (`INVALID_H1_COUNT`, `SKIPPED_HEADING_LEVEL`, `DUPLICATE_HEADING_ID`).
- `scripts/render-docx-preview.mjs` — `docx-preview` in headless Chromium for JS-only visual QA; port to Playwright's Chromium (already a dev dependency) as `scripts/docx-preview.mjs`.

## Review before adopting

- **Pandoc + JSZip post-processing → direct construction.** Every patch the POC applied after Pandoc (page geometry, drawing resize, centring, styles, `updateFields`) is a first-class option of the `docx` library. Do not port the regex-over-XML helpers (`applyPageGeometry`, `resizeDrawings`, `formatTableXml`); write the document right the first time and keep JSZip for tests only.
- **Puppeteer → the renderer.** The POC starts a browser to rasterise; we _are_ the browser. Rasterise in the renderer with the existing runtimes and send PNG bytes to main. Chromium draws an SVG `<img>` without fetching external resources: fonts must resolve to installed families (the runtimes already use the app font stack; Mermaid runs `htmlLabels: false`), and the AntV webfont is never fetched (POC `remoteFonts: false`).
- **Fatal on figure failure → degrade with a warning.** The POC stops the build when a Mermaid block fails or an asset is missing, which is right for a CI build and wrong for a person clicking Save: a collaborator's half-typed diagram must not block the export. A failed figure is emitted as its source in a code block plus the caption, a missing asset as a placeholder paragraph, and both appear in the export report and in the notice.
- **Heading rules.** The POC enforces "exactly one H1, no skipped levels" per note. CollabDoc documents are free-form; the exporter never rejects a document for its outline. Skipped levels are exported as-is (Word copes); the report notes them.
- **Pandoc Markdown as intermediate.** Not needed — the builder walks the Loro tree like `core/markdown.ts`, so the export is available to main and to the MCP server without the editor, and is unit-testable without Electron.
- **`referenceDoc` (a `.docx` template for styles).** Not supported by direct construction. Replaced by the typography/page options below; a template import is an open question.
- **Config as a `.mjs` file.** Becomes a validated JSON value in document meta plus a dialog; a document shared by a peer can carry any value, so the schema is enforced with `zod` and anything invalid falls back to defaults — the same rule 01 applies to figure `style`.
- **Tables and callouts.** The POC's banded, fixed-width tables and Obsidian callouts have no source node here. Reserve the `tables` config key; when 01's table node lands, `distributeColumnWidths` and the POC's `ObsidianTable` style are the reference.

## Design

### Save As and menu

- `File → Save As…` (`Mod+Shift+S`) shows one native dialog with filters `CollabDoc (*.collabdoc)`, `Markdown (*.md)`, `Word document (*.docx)`. Main decides by the chosen extension:
  - `.collabdoc` → `store.saveTo` as today (the document's path changes).
  - `.md` / `.docx` → main returns `{ ok: true, exportTo: { format: 'markdown' | 'docx', path } }`; the renderer produces the content (figures need the renderer) and calls the matching export IPC with `path` set, so no second dialog appears. The document's own path and dirty state are untouched; the notice reads "Exported Title.docx".
- `File → Export → Markdown…`, `Markdown with Comments…` (unchanged) and **`Word (.docx)…`**, which opens the **Export to Word** dialog (options below) whose Export button then opens the native save dialog. Save As with `.docx` uses the document's stored configuration (or the defaults) without the dialog.
- Browser mode (no `window.api`, used by Playwright): the same builder runs in the renderer (`Packer.toBlob`) and downloads, like `lib/files.ts#saveDocumentToHost`.

### Configuration

`DocxExportConfig` (`src/shared/docx-config.ts`: zod schema, `DEFAULT_DOCX_CONFIG`, `normalizeDocxConfig`; every field optional in storage, always complete after normalisation):

```ts
{
  version: 1,
  lang: 'en-US',                                        // document language, spellcheck
  page: { size: 'A4' | 'Letter' | 'Legal', orientation: 'portrait' | 'landscape',
          marginsMm: { top: 20, right: 18, bottom: 20, left: 18 } },   // POC defaults
  titleBlock: { enabled: true, author: true, date: true },             // title + by-line above the TOC
  toc: { enabled: true, depth: 1 | 2 | 3 | 4 /* 3 */, title: 'Contents' },
  headings: { chapterPageBreaks: false },               // page break before each H1 (POC)
  footer: { pageNumbers: true },                        // "Page X of Y", centred
  typography: { body: 'Calibri' | 'Arial' | 'Georgia' | 'Times New Roman' | 'Aptos',
                heading: /* same list */, mono: 'Consolas' | 'Courier New',
                baseSizePt: 11 },                       // curated lists, not free text
  figures: { scale: 1 | 2 | 3 | 4 /* 4 */, maxWidthPx: 3000, upscale: false,
             captionAlign: 'center' | 'left', numberCaptions: false,
             mermaidTheme: 'neutral' | 'default' | 'dark' | 'forest',
             infographicTheme: 'light' | 'dark' | 'hand-drawn',
             background: 'white' | 'transparent' }
}
```

- **Per document**: `meta.docxExport` (a JSON value in the `meta` LoroMap; `core/document.ts#readDocxConfig` / `setDocxConfig(doc, config, origin)` next to `setTitle`). Committed with the actor origin and the message `docx export settings`, so it is attributed and syncs to guests like the title. Last-writer-wins on concurrent edits is acceptable for a settings blob.
- **App defaults**: `Persisted.docxDefaults` in `lib/persist.ts`; a new Settings tab **Export** edits them. A document without `meta.docxExport` exports with the defaults; the Export to Word dialog is pre-filled from them and its Export/Save buttons write the document value.
- **Validation**: unknown keys dropped, invalid values replaced field-by-field (a hostile `typography.body` string or a 0 mm margin never reaches the XML); `marginsMm` clamped to 5–50; the page must keep ≥ 60 mm of writable width.

### Pipeline

Three stages, in this order, cancellable through one `AbortSignal`:

1. **Rasterise figures (renderer)** — `src/renderer/src/editor/figures/rasterize.ts#rasterizeFigures(docJson, config, signal)`:
   - For each `mermaidFigure` / `infographicFigure` and each SVG image asset: render SVG with the existing runtimes into an off-screen host sized to the writable width in CSS px (so layout matches the page, not the editor column), rasterise with `svgToPng(svg, { scale, background })` (extend the existing helper with scale and background), and cap the pixel width at `maxWidthPx` by lowering the scale (POC rule). The Mermaid theme is applied by prepending `%%{init: {"theme": …}}%%` unless the source already carries an init directive; the Infographic theme is passed to the renderer constructor and a `theme` line in the source wins (POC rule).
   - Key = `sha256(kind + source + theme + scale + background + widthPct)`. In-memory PNG cache per app session, so the second export of an unchanged document renders nothing (`reused: true` in the report, POC parity); the editor's `render-cache.ts` memoises the SVG stage.
   - Output `RenderedFigure { blockId, key, pngBase64, widthPx, heightPx, alt, error? }`. Alt text: `accDescr` from the Mermaid source or a `# accDescr:` / `// accDescr:` line in the Infographic source, else the caption, else "Mermaid diagram" / "Infographic"; images use `attrs.alt`, then the caption.
   - Libraries stay lazy: a document with no syntax figures never loads `mermaid` or `@antv/infographic` during export (AC-01.16 holds).
   - Progress in the notice bar: "Rendering figure 3 of 12…" with Cancel.
2. **Build (core, isomorphic)** — `src/core/docx/build.ts#buildDocx({ doc, config, figures, assets, author }) → Promise<Uint8Array>` on the `docx` library, walking the Loro tree with the same switch as `core/markdown.ts#renderBlock`. Runs in main for the desktop app and in the renderer in browser mode. Mapping:
   - Document properties: `title`, `creator` (profile name), `created` (`meta.createdAt`), `lastModifiedBy`, `language`. Title block: `Title` style paragraph, optional by-line "Author · date" in `Subtitle`.
   - TOC: `TableOfContents(config.toc.title, { hyperlink: true, headingStyleRange: '1-<depth>' })` and `features.updateFields: true`, so Word fills it on open (POC parity; LibreOffice needs Tools → Update). Then a page break when `titleBlock` or `toc` is enabled.
   - `heading` 1–4 → `Heading1..4` with `keepNext`; a `Bookmark` per heading named `b_<blockId>` (Word: ≤ 40 chars, letters/digits/underscore — sanitise). `chapterPageBreaks` → `pageBreakBefore` on every H1 after the first.
   - `paragraph` → Normal; `textAlign` attr → alignment.
   - `blockquote` → `Quote` paragraph style: left border, 0.5 cm indent, muted colour; nested blocks keep their own style plus the indent.
   - `codeBlock` → `Code` style (mono font, `baseSizePt − 1.5`, light shading, `keepLines`), one run per line separated by breaks; no highlighting.
   - `horizontalRule` → empty paragraph with a bottom border.
   - `bulletList` / `orderedList` / `taskList` → `numbering` config with one bullet and one decimal definition, nesting by level, a fresh numbering instance per ordered list so numbers restart; task items as bullet-less paragraphs prefixed `☐ ` / `☑ ` with a hanging indent (Word numbering has no checkbox — Pandoc does the same).
   - Marks: `bold`, `italics`, `underline`, `strike`, `code` → `CodeChar` character style, `link` → `ExternalHyperlink` for `http(s)` only (other schemes → plain text + `LINK_UNSUPPORTED_SCHEME` warning), `highlight` → nearest of Word's fixed highlight palette (default `yellow`), `superScript`, `subScript`. `mention` → plain `@handle` like Markdown export.
   - Figures → a centred/left/right paragraph (`attrs.align`) holding one `ImageRun` (`type: 'png'` for rasterised figures and SVG assets; the asset's own type for PNG/JPEG/GIF) with `altText { title: caption, description: alt, name: blockId }`. Display width = writable width × (`attrs.width` ?? 100) %, but not more than the natural CSS width unless `figures.upscale`; height by aspect ratio, capped at the writable height (downscale + `FIGURE_DOWNSCALED` warning). Then the caption paragraph in `Caption` style aligned per `captionAlign`, prefixed by a `SEQ Figure` field ("Figure 3: ") when `numberCaptions`. Caption text goes through the same mark mapping.
   - Failures: `RenderedFigure.error` → a `Code` block with the source and the caption, plus `FIGURE_RENDER_FAILED`; `asset:` hash not found → "[missing image: caption]" paragraph plus `ASSET_MISSING`.
   - Page: `page.size` → `pgSz` (A4 11906×16838 dxa via `convertMillimetersToTwip`), orientation, `pgMar` from `marginsMm`; footer with `Page <PageNumber.CURRENT> of <PageNumber.TOTAL_PAGES>` when enabled; default run font/size from `typography`.
   - Determinism: the same document, assets and configuration produce an identical `word/document.xml`; only `docProps/core.xml` timestamps differ.
3. **Write (main)** — `documents:exportDocx({ docId, path?, config, figures })`: validates the payload (`figures[].pngBase64` ≤ 8 MB each, ≤ 64 MB total; `config` through the zod schema), shows the save dialog when `path` is absent (filter `Word document`, default `<title>.docx`), builds with the hub's `LoroDoc` and `store.getAssets(docId)`, writes with `src/main/persist/atomic.ts` (tmp → fsync → rename), and returns `{ ok, path, name, report }`.

### Export report

`DocxExportReport { durationMs, figures: [{ blockId, kind, reused, widthPx, heightPx }], warnings: [{ code, blockId?, message }] }` with codes `FIGURE_RENDER_FAILED`, `ASSET_MISSING`, `FIGURE_DOWNSCALED`, `LINK_UNSUPPORTED_SCHEME`, `HEADING_LEVEL_SKIPPED`. Zero warnings → notice "Exported Title.docx"; otherwise "Exported with 2 warnings — Details" opening a list that focuses the offending block on click. One activity row per export (19) with the warning count. No `build-report.json` on disk.

### UI

- **Export to Word dialog** (`components/DocxExportDialog.tsx`, reusing `ui.tsx` primitives): sections Page, Title & contents, Typography, Figures; a live one-line summary ("A4 portrait · 20/18 mm · TOC to H3 · figures 4×"); buttons Cancel, Save settings (writes meta, no export), Export.
- **Settings → Export tab**: the same form bound to `Persisted.docxDefaults`, plus "Use as defaults for new documents".
- Guests (08) see the document's settings read-only until they have the write role; changing them is an ordinary attributed edit.

### Dependencies

`docx` 9.x (pin exact at implementation; pure JS, works in Node and the browser, bundles its own JSZip). Test-only: `jszip` to unpack the package in vitest. No new native modules, no external binaries.

## Acceptance criteria

Save As and formats:

- [ ] AC-22.1 `File → Save As…` offers CollabDoc, Markdown and Word filters; choosing `.collabdoc` behaves exactly as before (04), choosing `.md` writes the same file and `assets/` as Export Markdown, choosing `.docx` writes a Word file — in every case without a second dialog. The document's path and dirty state are unchanged after a `.md`/`.docx` Save As.
- [ ] AC-22.2 `File → Export → Word (.docx)…` opens the Export to Word dialog; Export saves the chosen options to the document and writes the file; Save settings stores them without exporting; Cancel changes nothing.
- [ ] AC-22.3 The written file opens without repair prompts in Word (Windows/macOS) and LibreOffice ≥ 7, and `docx-preview` renders it in the QA script.

Layout and structure (assert on the unpacked OpenXML, as the POC tests do):

- [ ] AC-22.4 Page geometry follows the configuration: A4 portrait with 20/18/20/18 mm margins yields `w:pgSz w:w="11906" w:h="16838"` and `w:pgMar` top/bottom 1134, left/right 1020; Letter landscape and custom margins are honoured; margins outside 5–50 mm are clamped.
- [ ] AC-22.5 With `toc.enabled`, `document.xml` contains a `TOC \o "1-<depth>"` field with hyperlinks and `settings.xml` has `w:updateFields w:val="true"`; with it off, neither is present. The title block and by-line appear only when enabled.
- [ ] AC-22.6 Headings 1–4 use `Heading1..4`; each carries a bookmark derived from its block id; `chapterPageBreaks` inserts a page break before every H1 but the first; a skipped level exports as-is and produces `HEADING_LEVEL_SKIPPED`.
- [ ] AC-22.7 Every node in `ALLOWED_NODES` and mark in `ALLOWED_MARKS` has a mapping: a corpus document using all of them (nested lists, task items checked/unchecked, code block with blank lines, blockquote with a list inside, links with marks, mentions) exports with no warning and the text content of `document.xml` equals the document's plain text in order.
- [ ] AC-22.8 Footer page numbers render "Page X of Y" when enabled and nothing otherwise; the default font and size follow `typography`; a value outside the curated font lists falls back to the default.

Figures:

- [ ] AC-22.9 A Mermaid figure and an Infographic figure export as PNG `ImageRun`s at `figures.scale` (a 600 px-wide diagram at 4× yields a ≥ 2400 px PNG), displayed at the writable width × `attrs.width` %, centred/left/right per `attrs.align`, never upscaled beyond natural size unless `upscale`; `wp:docPr` carries `descr` = `accDescr` when the source has one, else the caption.
- [ ] AC-22.10 Captions export in the `Caption` style with the configured alignment; with `numberCaptions` they read "Figure N: …" through a `SEQ Figure` field; a figure without a caption has no caption paragraph.
- [ ] AC-22.11 Image figures embed the asset bytes (PNG/JPEG/GIF as-is, SVG rasterised) with `alt` then caption as `descr`; the same asset used twice is embedded once (one `word/media/` entry); a missing asset yields a placeholder paragraph and `ASSET_MISSING`.
- [ ] AC-22.12 A figure whose source fails to render exports as a code block with its source plus the caption and `FIGURE_RENDER_FAILED`; the export still succeeds. A figure taller than the writable height is downscaled with `FIGURE_DOWNSCALED`.
- [ ] AC-22.13 Rendering is cached: exporting the same document twice renders each figure once (report `reused: true` for all figures the second time); changing one figure's source re-renders only that figure. `mermaid` / `@antv/infographic` are not loaded when exporting a document without syntax figures.
- [ ] AC-22.14 Mermaid and Infographic themes from the configuration change the PNGs (pixel hash differs between `neutral` and `dark`); a source with its own init directive / `theme` line wins.

Configuration:

- [ ] AC-22.15 The configuration is stored in `meta.docxExport`, survives save → reopen of the `.collabdoc`, and a guest (08) sees the host's values in the dialog within one sync round-trip; the change is attributed to the actor in history (05).
- [ ] AC-22.16 A document carrying a hostile or malformed configuration (unknown keys, `typography.body: "<script>"`, `marginsMm.left: -5`, `figures.scale: 99`) exports with the defaults for the invalid fields and no crash; the XML contains no unexpected font name.
- [ ] AC-22.17 Settings → Export defaults pre-fill the dialog for a document without stored settings and are used by Save As `.docx`; they never overwrite a document's stored value.

Quality:

- [ ] AC-22.18 Determinism: two consecutive exports of an unchanged document and configuration produce identical `word/document.xml`, `styles.xml` and `word/media/*`.
- [ ] AC-22.19 A 200 KB document with 20 figures (the AC-01.8 corpus) exports in under 15 s on the CI runner, with the editor staying responsive (figure rendering yields between figures; typing latency < 50 ms while exporting).
- [ ] AC-22.20 Cancel during rendering stops within one figure, writes nothing, and leaves no partial file (atomic write); a write error (read-only folder) shows a readable notice.
- [ ] AC-22.21 Tests: `src/core/docx/build.test.ts` (vitest, unpacks with JSZip, covers AC-22.4–22.8, 22.11 with stub figures, 22.16, 22.18); `src/renderer/src/editor/figures/rasterize.test.ts` (stub renderers, caching, alt-text extraction, cancel); `e2e/docx.spec.ts` in browser mode (dialog, Save As routing, real Mermaid/Infographic rasterisation, AC-22.9/22.13); `scripts/docx-preview.mjs` renders the e2e output with `docx-preview` for manual review.

## Out of scope

Native Word comments (a later revision mirrors "Export Markdown with Comments"); tables and callouts (no source nodes yet — `tables` config key reserved); a `.docx` style template (`referenceDoc`); PDF export; numbered headings; syntax highlighting in code blocks; a cover page image; exporting a selection or a single block; Markdown export changes.

## Open questions

- Should the TOC also be emitted as a static list of internal hyperlinks (no page numbers) for viewers that never update fields, or is the Word field enough?
- Import a user `.docx` as a style template (the POC's `referenceDoc`): worth a small "Styles from file…" option later, or leave to typography settings?
- Should the export configuration be part of the Markdown front matter on Export Markdown, so a `.md` → `.docx` pipeline outside the app can reuse it?
