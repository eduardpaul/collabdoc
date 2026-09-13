# 09 · Inline comments and review workflow

**Phase:** 2 · **Depends on:** 03 · **Status:** not started

## Summary

Anchored comments on a text span or a whole block, stored as a Loro sidecar so they sync and persist with the document. Humans and reviewer agents can comment; comments have a lifecycle (`open → accepted/rejected → applying → applied`), replies, and are rendered as highlights plus cards.

## Current state (collabdoc)

- The "Comment" toolbar button wraps the selection in `«»`. `ActivityKind` includes `comment` but nothing produces it.

## Reference (lorocollab)

- `core/comments.ts` — `comments` root map, `CommentRecord`, `listComments`, `visibleComments`, `writeComment`, `updateComment`, `contentHash`, `hasOpenComment`, `shouldReview`.
- `shared/types.ts` — `CommentView`, `CommentStatus`, `add_comment` / `list_comments` tool schemas.
- `client/extensions/comments.ts`, `client/comments-plugin.ts` — decorations from comment records resolved to current positions via block id + text quote.
- `client/components/CommentCard.tsx` — card with Accept (with "Apply" toggle), Reject, reply text, `applyError` display.
- `server/runtime.ts` — the *apply job*: accepting spawns a one-shot writer session that rewrites the block per the comment; "applied" only if the block actually changed.

## Review before adopting

- Comment anchoring is `blockId + quote + start/end`. When the quoted text is edited the decoration falls back to the whole block. Improve with Loro `Cursor`s (stable positions) stored alongside the quote; keep the quote as the human-readable fallback and for "orphaned" detection.
- Records are stored as whole JSON values in a `LoroMap` — a status update from two peers is LWW on the *whole record*. Store each comment as a nested `LoroMap` so `status`, `userReply`, and `replies` merge per field.
- Only agents author comments in lorocollab (`agentId/agentName`). Generalise to `authorId/authorName/authorRole`.
- Replies are a single `userReply` string. Use a `replies` `LoroList` of `{ authorId, body, at }`.
- The apply job is defined in the runtime; here we only need the **status protocol** it relies on. Keep `applying`/`applied`/`applyError` so 15 can plug in.
- Deleting a block with open comments: lorocollab leaves orphans. Mark them `orphaned` and show them in a "Resolved / orphaned" section, never silently drop.

## Design

- Storage: `comments` root map of `commentId → LoroMap { blockId, quote, anchorStart, anchorEnd, body, authorId, authorName, authorRole, color, status, createdAt, resolvedBy?, applyError?, replies: LoroList }`.
- Creating: select text → selection bar "Comment" → inline composer → `add_comment` through the user's session (so it is attributed and undoable). Whole-block comment from the block gutter menu.
- Rendering: highlight mark colored by author; a comments gutter/sidebar aligned to blocks (rail tab **Comments** with counts); clicking a highlight selects the card and vice-versa.
- Card actions: Reply, Resolve (human), Accept / Reject (for agent suggestions — Accept optionally triggers the apply job from 15), Reopen. Show `applyError` with Retry.
- Filters: open / resolved / mine / by author. Keyboard: `Mod+Alt+M` new comment.
- Export: Markdown export gets an "include comments as footnotes" option.

## Acceptance criteria

- [ ] AC-09.1 Selecting text and adding a comment creates one record in the `comments` map with the current user as author; the span is highlighted and a card appears in the Comments tab; the action is one attributed commit and is undoable.
- [ ] AC-09.2 Comments sync to guests and agents (`list_comments` returns them with correct spans) and persist through save/reopen.
- [ ] AC-09.3 Editing text *before* a commented span keeps the highlight on the same words; editing *inside* the span keeps the highlight covering the surviving characters; deleting the whole span marks the comment `orphaned` and keeps it listed under "Resolved / orphaned".
- [ ] AC-09.4 Two participants changing different fields of the same comment concurrently (one replies, one resolves) both land; neither change is lost (unit test with two sessions).
- [ ] AC-09.5 Replies are threaded under the card with author and time; a reply notifies the original author's activity feed (19) and, for agent authors, is available to the agent via `list_comments`.
- [ ] AC-09.6 Accept/Reject/Resolve/Reopen transitions are enforced by a state machine in `src/core/comments.ts` (`open → accepted | rejected | resolved`, `accepted → applying → applied | open(with applyError)`); illegal transitions return `{ ok:false }` and unit tests cover each edge.
- [ ] AC-09.7 The Comments tab shows counts per filter; selecting a card scrolls the editor to the span and flashes it; selecting a highlight selects the card.
- [ ] AC-09.8 A reviewer-role session can `add_comment` and `list_comments` but cannot change another author's comment body; anyone can resolve.
- [ ] AC-09.9 Markdown export with "include comments" appends footnotes `[^c1]` at the span end with author and body; without the option the export is unchanged from 04.
- [ ] AC-09.10 Whole-block comments (no span) highlight the block's left edge and behave identically in all flows above.

## Out of scope

Suggestion mode (tracked changes with accept/reject of text edits) — agents already edit through attributed commits; mention notifications in comments (10); comment-triggered apply job implementation (15).
