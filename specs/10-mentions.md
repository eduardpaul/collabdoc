# 10 · `@` mentions: requests to any participant

**Phase:** 2 · **Depends on:** 01, 07, 09 · **Status:** not started

## Summary

Typing `@` in the document or in a comment opens a picker of participants — people and agents in one list, each with a handle. A mention is a **request addressed to a participant**: a person gets a notification in their inbox (persisted, so it is there when they come back); an agent gets a run (14/15). Same node, same picker, same chip; only the handler differs. Mentions are document content (synced, persisted, attributed) and are flattened to `@handle` text before agents read the block.

## Current state (collabdoc)

- Toolbar "@ mention" inserts a literal `@`; the hint reads "@mentions and comments are placeholders".

## Reference (lorocollab)

- `client/extensions/writer-mention.ts` — Tiptap `Mention` with `startOfLine: true`, roster-driven suggestions, `parseWriterCommand`, idle auto-invoke after 8 s.
- `shared/mentions.ts` + test — `normalizeHandle`, `isValidHandle`, `commandFromMention`, `parseMentionCommand` (text fallback).
- `core/tree.ts#flattenMentions`, `mentionHandleOf`.
- `client/App.tsx` — in-memory `invokedMentions` guard.

## Review before adopting

- **Writer-only by design**: handles exist only for writers, the picker lists only writers, and a mention exists only to fire a run. CollabDoc needs one participant registry (07) where people and agents both have handles, and one mention node whose target may be either.
- `startOfLine: true` + "fire after 8 s idle" were POC ergonomics. Requests are sent explicitly (Enter / Send chip); idle auto-send is an opt-in setting for agents only.
- The in-memory invoked guard does not survive reload. Persist request state on the node (`requestId`, `sentAt`) and let main dedupe by `requestId`.
- Node stores `id = handle`; store `{ kind, id, label }` so renames do not break old mentions.
- `flattenMentions` must keep locators valid: test that an agent's `replace_text` on `"@arch write X"` preserves the chip.

## Design

### Registry and handles (07)

- Every participant has a `handle` (`[a-z0-9_-]{2,20}`, unique per document): people from their profile (default derived from name, editable), agents from their persona (13). The registry lists everyone recorded in `authors` for this document plus currently invited agents — **not only who is connected now**, so an offline collaborator can be mentioned and will find it on return.

### Node

- Tiptap `Mention` with `char: "@"`; items grouped **People / Agents** with role badges and presence dots; keyboard navigation; `@` + space inserts a literal `@`; not active in code blocks or links.
- Node attrs `{ kind: "person" | "agent", id, handle, label, requestId?, sentAt?, state? }`; rendered as a chip in the target's color.

### Requests

- **Sending**: a paragraph whose first child is a mention, plus text, is a request. Enter (or the chip's Send) marks the node `sentAt` and emits `mentions:request { requestId, docId, blockId, target, text, origin: "document" | "comment", threadId? }` to main; main dedupes by `requestId` and routes:
  - target **person** → notification record in that person's inbox (below); the chip shows `sent` and later `seen` when the person opens it.
  - target **agent** → `agents:invoke` (14 for writers, 15 for reviewers); the chip shows `queued → working → done | failed`, with Retry on failure.
- A mention without text (e.g. mid-sentence "as @ana said") is not a request: no run, but still a notification for a person and no-op for an agent.
- **In comments** (09): `@handle` in a body/reply resolves through the same registry and emits the same request with `origin: "comment"`; agents answer **in the thread** (`reply_comment`) rather than editing, unless the thread has a suggestion being applied (15).
- Settings (agents only): "Auto-send agent requests after N s idle" — off by default.

### Inbox (people)

- `userData/inbox/<userId>.json` on each install: `{ id, docId, blockId | threadId, from, text, at, read }` — written by main when a request targets the local user (host and guests each keep their own; a guest's inbox is fed over the sync connection through a `notify` control frame, and by scanning mention nodes/comment bodies on rejoin for anything newer than `lastSeenAt`).
- UI: bell in the topbar with unread count; list with jump-to; marking read notifies the sender's chip (`seen`) via ephemeral presence when both are online.
- Agents' "inbox" is `list_comments { mentioning: "me" }` plus the run queue — no separate store.

### Agents reading/writing mentions

- `get_blocks` flattens mention nodes to `@handle`; the `mention` node type is not in `ALLOWED_NODES`, so agents cannot insert chips into the document; in comment bodies they may write `@handle` text, which renders as a chip for humans.

## Acceptance criteria

- [ ] AC-10.1 Typing `@` shows People and Agents groups with handles, names, role badges and presence; the list includes a collaborator who is currently offline but has edited this document before; arrows + Enter insert a chip; Escape cancels; `@` + space is literal; no picker inside code blocks or links.
- [ ] AC-10.2 A chip is a synced, persisted document node rendered in the target's color; `get_blocks` returns it flattened as `@handle`; agents cannot create mention nodes (attempt → `schema`).
- [ ] AC-10.3 Person request: `@ana please check the numbers` + Enter creates one inbox entry for Ana (host or guest) with the block text and a jump link; the sender's chip shows `sent`, then `seen` when Ana opens it; nothing is created twice after a renderer reload.
- [ ] AC-10.4 Offline recipient: Ana is disconnected when mentioned; on rejoining (08) her inbox shows the mention and the topbar badge counts it.
- [ ] AC-10.5 Agent request: `@writer draft an intro` + Enter dispatches exactly one `agents:invoke` with `requestId`, `blockId`, `handle`, `instruction = "draft an intro"`; Enter again does not re-send; the guard survives reload; chip states follow runtime events and Failed offers Retry.
- [ ] AC-10.6 Comment mentions: `@reviewer is this claim supported?` in a reply produces a reviewer run scoped to the thread's block whose answer arrives as a reply in the same thread; `@ana` in a reply produces an inbox entry pointing at the thread.
- [ ] AC-10.7 A block `"@arch write X"` edited by the agent via `replace_text { find: "write X" }` becomes `"@arch <new text>"` with the chip preserved.
- [ ] AC-10.8 Removing an agent or a collaborator leaving leaves chips intact (label kept) but greyed; Send is disabled for removed agents; mentions of a person who left still land in their inbox on return.
- [ ] AC-10.9 Handles are unique per document; renaming a person or agent updates chip labels everywhere while old mentions keep resolving by `id`.
- [ ] AC-10.10 Inbox: unread count in the topbar, list sorted newest first, jump-to opens the document/block/thread, mark-read individually or all; inbox is per install and never synced to other users.
- [ ] AC-10.11 With idle auto-send enabled, an agent request paragraph left untouched for N seconds is sent once; typing resets the timer; the setting never applies to person mentions.

## Out of scope

Mentioning documents/blocks (`#block`); email/push notifications; group handles (`@everyone`); mention-based permissions.
