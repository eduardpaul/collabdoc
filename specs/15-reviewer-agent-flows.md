# 15 · Reviewer agent flows

**Phase:** 3 · **Depends on:** 09, 12, 13 · **Status:** not started

## Summary

Reviewers watch the document and open or answer comment threads; they never edit. They use the same thread model as people (09): a reviewer's note is an ordinary thread that anyone can reply to or resolve, and a reviewer can answer questions asked in threads that mention it. Triggers: **on request** (rail "Ask to review", selection bar), **on mention** (`@reviewer …` in a paragraph or thread, 10), **on idle** (opt-in), and **on invite** (a bounded sweep). Any thread — opened by a person or an agent — can carry a **suggestion**; "Apply with <writer>" spawns a one-shot writer run scoped to that block (14).

## Current state (collabdoc)

- The Reviewer default persona exists; "Ask to review" is stubbed.

## Reference (lorocollab)

- `server/runtime.ts#addReviewer / onDocumentChange / scheduleReview / sweep` — idle timers per block, `REVIEW_COALESCE_MS`, `MAX_INITIAL_REVIEWS`, `contentHash` to skip unchanged blocks, `hasOpenComment` to avoid stacking.
- `core/comments.ts#shouldReview / reviewDelayMs / MIN_REVIEW_CHARS`.
- `server/runtime.ts#applyComment` — accept → one-shot writer session with `applyPrompt`, `applying → applied` only if a write happened, otherwise `applyError` and back to `open`.
- `server/llm-agent.ts#reviewerPrompt` — "must call add_comment at least once; do not say the writing is fine; do not repeat open comments".

## Review before adopting

- "Must add at least one comment" causes noise on good text. Replace with: the reviewer may finish with no comment; the UI shows "Reviewed ¶n — no notes" in Activity so silence is visible.
- Idle review fires per block after `idleSeconds`; on a document with many edited blocks it queues one run per block. Batch: one run per idle window covering all changed blocks (up to 5), with `contentHash` dedupe.
- Initial sweep of 3 most recent blocks was a demo heuristic. Make "review on invite" an explicit choice in the invite dialog (`none | last 5 blocks | whole document`) with a cost warning for whole-document.
- Reviewers running automatically on every pause can be expensive and distracting. Default **idle review off**; on-request only until the user turns it on per agent, with a visible "auto" badge.
- Apply job reuses the writer prompt with the comment body as instruction; keep, but scope it (14) to the comment's block and pass the quote so the writer edits the right span.

## Design

- Job kinds: `review { blockIds, reason: "ask" | "idle" | "invite" | "selection" | "mention" }`, `thread { requestId, threadId, blockId, text }` (answer in-thread with `reply_comment`, may `resolve_comment` if the question is settled), `apply { threadId, writerId }` (writer-role run; see 14).
- Idle policy per agent: `{ enabled, idleSeconds (3–120), maxBlocksPerRun 5, minChars 20 }`; the runtime coalesces document changes (150 ms) and schedules one review after `idleSeconds` of no changes, covering changed blocks whose hash differs from the last reviewed hash and that have no open comment by this reviewer.
- Reviewer prompt: goal/skills, the blocks with ids, open comments list, rule "comment only on concrete issues; quote the exact phrase; at most 2 comments per block".
- Suggestions: any open thread has "Apply with…" listing invited writers (plus a built-in "Editor" persona with writer tools when none is invited). Choosing one sets `suggestion.status = applying`, runs a writer job scoped to the block with instruction = thread body + replies + quote, and on success sets `applied` and posts a reply summarising the change; if the writer makes no write, `suggestion.status` returns to `pending` with `error` and Retry. This works identically for threads opened by people and by reviewers.
- Comments authored by agents carry the agent's id/color (09).

## Acceptance criteria

- [ ] AC-15.1 "Ask to review" on a document produces 0–n comments anchored to exact phrases via `locator.find`; each is attributed to the reviewer and visible to guests; the run record shows only read tools + `add_comment`.
- [ ] AC-15.2 A reviewer that finds nothing ends `done` with an Activity row "Reviewed ¶1–¶4 · no notes"; no empty or generic comment ("looks good") is created (mocked model test + prompt assertion).
- [ ] AC-15.3 Idle review (enabled, 8 s): editing two paragraphs and pausing 8 s triggers exactly one run covering both blocks; editing again within 8 s resets the timer; unchanged blocks and blocks with an open comment by the same reviewer are excluded.
- [ ] AC-15.4 Invite-time sweep options work: `none` runs nothing; `last 5` reviews the 5 most recently changed blocks; `whole document` shows a confirmation with block count and then runs in batches of 5.
- [ ] AC-15.5 "Apply with <writer>" on a thread opened by a **person** and on one opened by a **reviewer** both go `pending → applying → applied`, change the block via an attributed writer commit scoped to it, post a summary reply in the thread, and link the card to the History entry.
- [ ] AC-15.6 Apply where the writer makes no write: `suggestion.status` returns to `pending` with `error = "editor made no changes: …"`, Retry is offered, the thread stays open and the document is unchanged.
- [ ] AC-15.7 Resolving a reviewer's thread (by anyone) declines its suggestion; the reviewer's next run on that block does not repeat the same note (resolved threads are in `list_comments` context and the prompt says not to repeat them).
- [ ] AC-15.11 Mention in a thread: a person replies `@reviewer which claim do you mean?` under the reviewer's note; the reviewer run answers with `reply_comment` in that thread, quoting the phrase, and does not open a new thread.
- [ ] AC-15.8 Per-agent idle review is off by default; enabling it shows an "auto" badge on the card and in the participant list; disabling it cancels pending timers.
- [ ] AC-15.9 Cost guard: a review run covers at most `maxBlocksPerRun` blocks and the reviewer's per-run limits (12) apply; the run record includes the number of blocks reviewed.
- [ ] AC-15.10 All flows have mocked-model tests; the coalescing/idle logic has unit tests with fake timers.

## Out of scope

Reviewers that suggest concrete replacement text as tracked changes (they comment; apply jobs edit); cross-document review.
