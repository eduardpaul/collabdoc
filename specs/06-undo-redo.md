# 06 · Per-actor undo/redo

**Phase:** 1 · **Depends on:** 03 · **Status:** not started

## Summary

Undo/redo backed by Loro's `UndoManager`, scoped to the acting participant: a human's `Mod+Z` reverts their own last change and never an agent's or a guest's; an agent's `undo` tool reverts only that agent's last step. Selection is restored sensibly, and undo survives remote edits interleaved with local ones.

## Current state (collabdoc)

- The `<textarea>` gives native undo of the raw string. It will disappear with 01.

## Reference (lorocollab)

- `client/extensions/loro-collab.ts` — `LoroUndoPlugin({ doc })`, keymap for `Mod-z/Mod-y/Mod-Shift-z`, `undo`/`redo` commands.
- `core/session.ts` — per-session `UndoManager` with `excludeOriginPrefixes` so a session's manager ignores other actors' commits; `undo`/`redo` tools return the resulting blocks.
- `shared/types.ts` — `UndoState { canUndo, canRedo }` returned with every mutation.

## Review before adopting

- lorocollab's `UndoManager` options were tuned for one peer per session; verify `mergeInterval` and `maxUndoSteps` explicitly and set them (current defaults are implicit).
- Verify that undoing a text insert that a remote peer has since typed *inside* keeps the peer's text (Loro guarantees this, but write the test).
- The client and the human `DocumentSession` in the runtime (lorocollab creates a server-side "human" session for the voice agent) must not both manage undo for the same actor. In CollabDoc the human's undo lives only in the renderer.
- Comment status changes and checkpoint creation are commits too; decide whether they are undoable (recommend: comment open/reply/resolve yes, checkpoints no — use `excludeOriginPrefixes` for `sys:`).

## Design

- Renderer: `LoroUndoPlugin` configured with `excludeOriginPrefixes: ["sys:"]` — each participant's own `LoroDoc` only records *local* ops, so other actors' `actor:<id>` commits arrive as imports and are never undo candidates; only the app's own `sys:` bookkeeping (author registration, hub init) has to be excluded explicitly; toolbar Undo/Redo buttons reflect `canUndo/canRedo` via the plugin state.
- Agents: each `DocumentSession` gets its own `UndoManager` with the same exclusion rule, exposed as the `undo`/`redo` tools (already in the tool list).
- Selection restore: on undo, place the caret at the end of the reverted range (Loro cursors stored with the undo step — use `UndoManager.setOnPush/OnPop` to stash `Cursor`s).
- Grouping matches history (05): idle ≤ 1 s or block change starts a new undo step for humans; every tool call is a step for agents.

## Acceptance criteria

- [ ] AC-06.1 Typing "hello world" then `Mod+Z` removes the whole burst typed within 1 s; a second `Mod+Z` removes the previous burst; `Mod+Shift+Z` / `Mod+Y` redo them in order.
- [ ] AC-06.2 With an agent (or a test harness peer) editing block B while the user edits block A, the user's `Mod+Z` reverts only block A; block B keeps the agent's text; the History panel shows the undo as a new commit by the user.
- [ ] AC-06.3 If a remote peer inserts text inside the span the user is about to undo, undo removes only the user's characters and the peer's text remains contiguous and intact (unit test at the core level, and a Playwright test at the UI level).
- [ ] AC-06.4 Toolbar Undo/Redo buttons are disabled exactly when `canUndo`/`canRedo` are false; state updates immediately after each edit, undo, or remote import.
- [ ] AC-06.5 After undo the caret sits at the end of the reverted range and the editor is scrolled so it is visible.
- [ ] AC-06.6 Agent `undo` tool reverts only that agent's last successful write and returns the affected blocks and the new `UndoState`; calling `undo` with nothing to undo returns `ok:true` with `applied: "nothing to undo"` (not an error).
- [ ] AC-06.7 Opening, replying to, or resolving a comment thread (09) is undoable by the participant who did it (human via `Mod+Z`, agent via its `undo` tool); checkpoint creation (05) is not undoable and is skipped by undo.
- [ ] AC-06.8 Undo history is bounded (`maxUndoSteps = 200`) and does not grow main/renderer memory beyond that bound in a 10 000-edit stress test.

## Out of scope

Cross-session undo (undo someone else's change — use History → Restore instead); undo of document metadata like title (title edits are LWW and go through history only).
