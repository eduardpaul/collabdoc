# 04 · Document persistence: `.collabdoc` format, autosave, Markdown, recents

**Phase:** 1 · **Depends on:** 03 · **Status:** not started

## Summary

Persist the Loro document — history included — as a `.collabdoc` file, autosave it, and keep Markdown as an import/export format rather than the storage format. Recents become a small index on disk instead of full document copies in `localStorage`.

## Current state (collabdoc)

- `src/main/documents.ts` reads/writes UTF-8 text; the renderer serialises `# Title\n\n<markdown>`.
- `RecentDocument` stores the **entire document content** in `localStorage` (`collabdoc.v1`), capped at 20 entries — this will not scale and leaks documents into the browser profile.
- "Save" is manual (`Mod+S`); the unsaved-changes dialog guards navigation.

## Reference (lorocollab)

- `core/hub.ts#snapshot()` — `doc.export({ mode: "snapshot" })`.
- No persistence exists in lorocollab (server restart loses the document). This feature is new.

## Review before adopting

- Nothing to port. Note that lorocollab's reconnect logic relies on "the server document is the same document"; the `docId` in `meta` (02) is what lets us detect "this file is a different document" on re-open.

## Design

- **File format** `.collabdoc`: a small container — 8-byte magic `CLBDOC01`, then a JSON header (`{ docId, title, schemaVersion, savedAt, app: "collabdoc/0.x" }`, length-prefixed), then the Loro snapshot bytes. Header lets the start screen list files without loading Loro. Version the magic; refuse newer versions with a clear error.
- **Where**: user chooses on first save (native dialog, default `~/Documents/CollabDoc/<title>.collabdoc`). Untitled new documents autosave to `app.getPath('userData')/drafts/<docId>.collabdoc` until saved elsewhere, so nothing is ever only in memory.
- **Autosave**: main debounces hub commits (2 s idle, max 30 s) and writes atomically (`write tmp → fsync → rename`). Also on window close, before quit, and before sharing (08). Manual `Mod+S` forces a write and, for drafts, opens Save As.
- **Dirty state**: `savedVersion` (Loro version vector) per hub; `dirty = !doc.version().equals(savedVersion)`. Main pushes `documents:state` events; the reducer mirrors it.
- **Markdown**: `File → Import Markdown` creates a new document from `.md`; `File → Export → Markdown` writes `.md` (uses the converter from 01). Opening a `.md` directly still works and is treated as import (the `.collabdoc` twin is created next to it on first save; the original `.md` is never silently rewritten).
- **Recents**: `userData/recents.json` with `{ docId, title, path, updatedAt, preview }`; preview is the first 120 chars, computed at save time. Missing files show as "moved or deleted" with a remove action.
- **Crash recovery**: on startup, drafts newer than their recents entry are offered for recovery.
- **Migration**: on first run with the new code, `collabdoc.v1` recents with inline content are converted to drafts, then the key is deleted.

## Acceptance criteria

- [ ] AC-04.1 Saving produces a file starting with `CLBDOC01` whose header parses without loading Loro and whose body imports into a fresh `LoroDoc` yielding identical text, block ids, `authors`, `comments`, and change count to the in-memory hub.
- [ ] AC-04.2 Reopening a `.collabdoc` restores full history: `listHistory` shows the same entries with the same authors and timestamps as before the save (05 depends on this).
- [ ] AC-04.3 Autosave writes within 2 s of the last edit and never more than 30 s after the first unsaved edit; killing the process (`SIGKILL`) 3 s after typing loses nothing (Playwright + process kill test).
- [ ] AC-04.4 Writes are atomic: interrupting a write never leaves a truncated `.collabdoc`; the previous file remains valid (test by simulating a failure between tmp write and rename).
- [ ] AC-04.5 The dirty indicator (topbar "Unsaved", window title `•`) reflects hub version vs saved version and clears after autosave without user action.
- [ ] AC-04.6 New untitled documents are recoverable: create, type, force-quit, relaunch → the start screen offers "Recover 'Untitled'"; accepting restores the content.
- [ ] AC-04.7 Importing a `.md` creates a new `.collabdoc`-backed document; the source `.md` file's bytes are unchanged afterwards; exporting to Markdown produces the same round-trip guarantees as AC-01.6.
- [ ] AC-04.8 `localStorage` no longer contains document content; `recents.json` entries are ≤ 1 KB each; the start screen lists up to 50 recents sorted by `updatedAt`.
- [ ] AC-04.9 Opening a file that was moved/deleted shows a non-blocking notice with "Locate…" and "Remove from recents"; it does not create an empty document.
- [ ] AC-04.10 Opening a `.collabdoc` with a newer `schemaVersion` or unknown magic fails with a readable error and does not overwrite the file.
- [ ] AC-04.11 The unsaved-changes dialog only appears for drafts that have no chosen path (where "discard" means deleting the draft); documents with a path never prompt because they are autosaved.
- [ ] AC-04.12 Existing `collabdoc.v1` recents are migrated to drafts on first launch and the old key is removed; migration is idempotent.

## Out of scope

Cloud/sync storage; multiple files per document (assets); encryption at rest.

## Open questions

- Should Markdown export include comments as footnotes or HTML comments? Default: omit; add an "include comments" checkbox later (09).
