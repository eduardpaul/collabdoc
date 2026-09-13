# 09 · Comments: threads any participant can open, answer, and resolve

**Phase:** 2 · **Depends on:** 03, 07 · **Status:** not started

## Summary

Anchored comment threads on a text span or a whole block, stored as a Loro sidecar so they sync and persist with the document. **Every participant is a peer here**: the local user, guests, and agents open threads, reply, and resolve through the same model and the same UI; an agent is simply a participant whose replies are produced by a run. Agent-specific behaviour (a reviewer opening threads on its own, "let an agent apply this") is layered on top in 15, not baked into the comment model.

## Current state (collabdoc)

- The "Comment" toolbar button wraps the selection in `«»`. `ActivityKind` includes `comment` but nothing produces it.

## Reference (lorocollab)

- `core/comments.ts` — `comments` root map, `CommentRecord`, `listComments`, `visibleComments`, `writeComment`, `updateComment`, `contentHash`, `hasOpenComment`.
- `shared/types.ts` — `CommentView`, `CommentStatus`, `add_comment` / `list_comments` tool schemas.
- `client/extensions/comments.ts`, `client/comments-plugin.ts` — decorations from comment records resolved via block id + text quote.
- `client/components/CommentCard.tsx` — card with Accept/Reject/reply.
- `server/runtime.ts#applyComment` — the "accept spawns an editor" job (moves to 15).

## Review before adopting

- **lorocollab's model is agent-only**: comments carry `agentId/agentName`, the human's only moves are Accept/Reject/one reply, and the status machine (`open → accepted → applying → applied`) describes an agent _suggestion_, not a conversation. CollabDoc needs a thread model first (author = any participant, replies from anyone, `open | resolved`), and "suggestion handling" as an optional action on a thread.
- Agents can only `add_comment`; they cannot reply or resolve. Add `reply_comment` and `resolve_comment` tools so an agent can answer a question in its own thread and close it (see Tool changes).
- Anchoring is `blockId + quote + start/end`; when the quoted text is edited the decoration falls back to the whole block. Use Loro `Cursor`s for stable positions and keep the quote for display and orphan detection.
- Records are whole JSON values in a `LoroMap` (LWW on the entire record). Store each thread as a nested `LoroMap` with a `replies` `LoroList` so concurrent reply + resolve both land.
- Deleting a block with open threads leaves orphans silently; mark `orphaned` and keep them listed.

## Design

### Model (in `src/core/comments.ts`)

- `comments` root map: `threadId → LoroMap { blockId, quote, anchorStart, anchorEnd, author: { id, name, role: "human" | "agent", color }, body, createdAt, status: "open" | "resolved", resolvedBy?, resolvedAt?, orphaned?: boolean, replies: LoroList<{ id, author, body, at }>, suggestion?: { status: "pending" | "applying" | "applied" | "declined", by?, error? } }`.
- Two things are deliberately separate: the **thread** (`open | resolved`, owned by people and agents alike) and an optional **suggestion** attached to it (15 uses this for "apply with an agent"). Resolving a thread with a pending suggestion declines it.
- Mentions in bodies: `@handle` tokens in `body` and reply bodies are parsed against the participant registry (07) and produce mention events (10). This is text-based on purpose so humans, guests, and agents can all mention anyone in a comment.
- Permissions (enforced in core, same for humans and agents): anyone can open a thread and reply; only the author can edit or delete their own body/reply (soft-delete: `deleted: true`, keeps the thread shape); anyone can resolve or reopen; a reviewer-role session has the comment tools but no text tools (02).

### Tool changes (amends 02's list)

- `add_comment { blockId, body, locator? }` — unchanged.
- `reply_comment { threadId, body }` — new; available to writer and reviewer roles.
- `resolve_comment { threadId, reason? }` — new; available to writer and reviewer roles.
- `list_comments { blockId?, status?, mentioning?: "me" }` — extended to return replies, resolved state and threads that mention the calling agent.
- `DOCUMENT_WRITE_TOOLS` includes the three mutating comment tools.

### UI

- Create: select text → selection bar **Comment** (`Mod+Alt+M`), or block gutter menu → whole-block comment; inline composer with `@` mention picker (10). The action goes through the user's own `DocumentSession` so it is attributed and undoable.
- Render: highlight colored by the thread author; rail tab **Comments** with counts; card = author chip, time, body, replies, reply box (with mentions), Resolve / Reopen, Edit/Delete on own items, and — when a suggestion is attached — Apply with… / Decline (15).
- Filters: open, resolved, mine, mentions me, by participant (people and agents in one list). Unread dot on threads with new replies since you last viewed them (per-user, local).
- Navigation: selecting a card scrolls/flashes the span; selecting a highlight selects the card; `]`/`[` next/previous open thread.
- Export: Markdown export option "include comments as footnotes" (thread + replies).

## Acceptance criteria

- [ ] AC-09.1 The local user, a guest, and an agent (via `add_comment`) can each open a thread on a span; all three appear identically in the Comments tab with the right author chip and color, sync to all peers, and persist through save/reopen.
- [ ] AC-09.2 Any participant can reply to any thread: a guest replies to the host's thread, the host replies to an agent's thread, and an agent replies to a human's thread via `reply_comment`; replies are ordered by time and attributed; each reply is one attributed commit.
- [ ] AC-09.3 Resolve/Reopen work from any participant (human via UI, agent via `resolve_comment`); the state machine in core (`open ↔ resolved`; `suggestion: pending → applying → applied | declined`) rejects illegal transitions with `{ ok:false }` and has unit tests per edge; resolving declines a pending suggestion.
- [ ] AC-09.4 Only the author can edit or delete their body/reply; an agent's attempt to edit a human's body (and vice versa) is rejected by core; deletion is a soft-delete that keeps the thread's structure.
- [ ] AC-09.5 Concurrent changes to different fields of one thread (one peer replies while another resolves) both land with no loss (unit test with two sessions).
- [ ] AC-09.6 Editing text _before_ a span keeps the highlight on the same words; editing _inside_ keeps it on the surviving characters; deleting the span marks the thread `orphaned` and lists it under "Resolved / orphaned" — never silently dropped.
- [ ] AC-09.7 A `@handle` in a comment body or reply is rendered as a mention chip and produces a mention event (10) for that participant — for a person a notification, for an agent a scoped run (14/15); an unknown handle stays plain text.
- [ ] AC-09.8 `list_comments { mentioning: "me" }` returns only threads/replies that mention the calling agent, including replies added since its last run; `list_comments` output includes replies and status so agents do not repeat notes.
- [ ] AC-09.9 Unread indicators: a thread with replies since the user last opened it shows a dot and counts toward the Comments tab badge; opening the card clears it; unread state is per user and not synced.
- [ ] AC-09.10 Whole-block threads (no span) highlight the block edge and behave identically in every flow above.
- [ ] AC-09.11 Markdown export with "include comments" appends footnotes with author, body and replies; without the option the export equals 04's.
- [ ] AC-09.12 Reviewer-role sessions have exactly `add_comment`, `reply_comment`, `resolve_comment`, `list_comments` plus read tools; no text tool (unit test on `REVIEWER_TOOLS`).

## Out of scope

Suggestion mode with tracked text changes (agents edit through attributed commits; humans edit directly); reactions/emoji; comment-level permissions beyond author-owns-body.
