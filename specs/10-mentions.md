# 10 · `@` mentions of agents and people

**Phase:** 2 · **Depends on:** 01, 09 · **Status:** not started

## Summary

Typing `@` opens a picker listing invited agents (by handle) and session participants. Mentioning an agent at the start of a paragraph followed by an instruction invokes that agent on that block (14); mentioning a person notifies them. Mentions are real nodes in the document, synced like any other content, and are flattened to plain text before agents read the block.

## Current state (collabdoc)

- Toolbar "@ mention" inserts a literal `@`; the hint reads "@mentions and comments are placeholders".

## Reference (lorocollab)

- `client/extensions/writer-mention.ts` — Tiptap `Mention` with `startOfLine: true`, suggestion items from the writer roster, `parseWriterCommand(node, handles)`, the plugin that fires `onInvoke(blockId, handle, instruction)` after `MENTION_IDLE_MS = 8000` of idle.
- `shared/mentions.ts` + test — `normalizeHandle`, `isValidHandle`, `commandFromMention`, `parseMentionCommand` (text fallback for `@handle instruction` typed without the node).
- `core/tree.ts#flattenMentions`, `mentionHandleOf` — host flattens mention nodes to `@handle` text before the writer sees the block.
- `client/App.tsx` — `invokedMentions` set so the same block is not invoked twice.

## Review before adopting

- `startOfLine: true` and "8 s idle then fire" were POC ergonomics. Replace with an explicit trigger: pressing **Enter** or a "Send" chip on the mention paragraph invokes; idle auto-fire is off by default (setting).
- `invokedMentions` is in-memory in the browser — after reload the same block would be re-invoked. Store `invokedAt` on the mention node's attrs (synced), and have the runtime (14) treat a mention as a one-shot job keyed by `(blockId, mentionId)`.
- Handles are only for writers. Extend the picker to reviewers ("@reviewer look at this") and to people (notification only).
- The mention node stores `id = handle`. Store `{ kind: "agent" | "person", id, label }` so renames do not break old mentions.
- `flattenMentions` mutates a cloned block text for the agent; ensure the agent's `replace_text` locators computed on flattened text still resolve on the real block (write the test: block `"@arch write X"` → agent replaces `"write X"`).

## Design

- `Mention` extension configured with `char: "@"`, `allowSpaces: false`, items = invited agents (handle, name, role) + participants (name), grouped in the popup with role badges; keyboard navigation.
- Node attrs: `{ kind, id, label, mentionId, invokedAt? }`. Rendered as a chip in the agent's color.
- Agent invocation: when a block's first child is an agent mention and the user presses Enter (or clicks the chip's "Run"), the renderer emits `agents:invoke { blockId, mentionId, handle, instruction }` to main; the runtime (14) takes over and updates the chip state (`queued → working → done | failed`).
- Person mention: emits an activity event and a badge for that participant (19); no document mutation beyond the node.
- Agents reading blocks get mentions flattened to `@handle` text; agents writing text cannot create mention nodes (not in `ALLOWED_NODES`).
- Settings toggle "Auto-run agent mentions after N seconds idle" (off by default).

## Acceptance criteria

- [ ] AC-10.1 Typing `@` shows a picker with invited agents and connected participants; arrow keys + Enter insert a mention chip; Escape closes without inserting; `@` followed by a space inserts a literal `@`.
- [ ] AC-10.2 A mention chip is a document node synced to guests and persisted; it renders with the target's color and label and is flattened to `@handle` in `get_blocks` output for agents.
- [ ] AC-10.3 `@writer draft an intro` + Enter dispatches exactly one `agents:invoke` with `blockId`, `mentionId`, `handle`, `instruction = "draft an intro"`; pressing Enter again on the same block does not re-invoke (chip shows state); the guard survives renderer reload.
- [ ] AC-10.4 The chip shows `queued / working / done / failed` states driven by runtime events; failed shows the reason on hover and offers Retry.
- [ ] AC-10.5 Mentioning a person adds an activity row "You mentioned Ana in ¶4" on all sides and a badge on Ana's participant row; clicking it scrolls to the block.
- [ ] AC-10.6 Removing an agent from the session leaves existing mention chips intact (label preserved) but greys them out and disables Run.
- [ ] AC-10.7 A block `"@arch write X"` edited by the agent via `replace_text { locator: { find: "write X" } }` results in `"@arch <new text>"` with the mention chip preserved (locator resolution accounts for the flattened prefix).
- [ ] AC-10.8 With the idle auto-run setting enabled, a mention paragraph left untouched for N seconds invokes once; typing again before N seconds resets the timer.
- [ ] AC-10.9 The picker is not shown, and `@` is a literal character, inside code blocks and inside links.

## Out of scope

Mentioning documents or blocks (`#block`); email/push notifications for mentioned people who are offline.
