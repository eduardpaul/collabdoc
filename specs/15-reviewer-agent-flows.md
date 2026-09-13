# 15 · Reviewer agent flows

**Phase:** 3 · **Depends on:** 09, 12, 13 · **Status:** not started

## Summary

Reviewers watch the document and leave anchored comments; they never edit. Triggers: **on request** (rail "Ask to review", selection bar), **on idle** (a block changed and the user paused for N seconds), and **on invite** (a bounded sweep of recent blocks). Accepting a reviewer comment can spawn a one-shot **apply job** — a writer-role run scoped to that block that carries out the suggestion.

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

- Job kinds: `review { blockIds, reason: "ask" | "idle" | "invite" | "selection" }`, `apply { commentId }`.
- Idle policy per agent: `{ enabled, idleSeconds (3–120), maxBlocksPerRun 5, minChars 20 }`; the runtime coalesces document changes (150 ms) and schedules one review after `idleSeconds` of no changes, covering changed blocks whose hash differs from the last reviewed hash and that have no open comment by this reviewer.
- Reviewer prompt: goal/skills, the blocks with ids, open comments list, rule "comment only on concrete issues; quote the exact phrase; at most 2 comments per block".
- Apply job: on Accept with "Apply" on, create a writer-role run (using the reviewer's provider or the default writer? — use the **default writer persona if invited, else a built-in "Editor"** with writer tools) scoped to the block, instruction = comment body + quote; on success set `applied`, else `open` with `applyError` and a Retry action.
- Comments authored by agents carry the agent's id/color (09).

## Acceptance criteria

- [ ] AC-15.1 "Ask to review" on a document produces 0–n comments anchored to exact phrases via `locator.find`; each is attributed to the reviewer and visible to guests; the run record shows only read tools + `add_comment`.
- [ ] AC-15.2 A reviewer that finds nothing ends `done` with an Activity row "Reviewed ¶1–¶4 · no notes"; no empty or generic comment ("looks good") is created (mocked model test + prompt assertion).
- [ ] AC-15.3 Idle review (enabled, 8 s): editing two paragraphs and pausing 8 s triggers exactly one run covering both blocks; editing again within 8 s resets the timer; unchanged blocks and blocks with an open comment by the same reviewer are excluded.
- [ ] AC-15.4 Invite-time sweep options work: `none` runs nothing; `last 5` reviews the 5 most recently changed blocks; `whole document` shows a confirmation with block count and then runs in batches of 5.
- [ ] AC-15.5 Accept with Apply: the comment goes `accepted → applying → applied`, the block changes via an attributed writer commit scoped to the block, and the comment card links to the History entry.
- [ ] AC-15.6 Accept with Apply where the model makes no write: the comment returns to `open` with `applyError = "editor made no changes: …"` and Retry is offered; the document is unchanged.
- [ ] AC-15.7 Reject marks the comment `rejected`; the reviewer's next run on that block does not repeat the same note (the rejected comment is included in `list_comments` context and the prompt says not to repeat it).
- [ ] AC-15.8 Per-agent idle review is off by default; enabling it shows an "auto" badge on the card and in the participant list; disabling it cancels pending timers.
- [ ] AC-15.9 Cost guard: a review run covers at most `maxBlocksPerRun` blocks and the reviewer's per-run limits (12) apply; the run record includes the number of blocks reviewed.
- [ ] AC-15.10 All flows have mocked-model tests; the coalescing/idle logic has unit tests with fake timers.

## Out of scope

Reviewers that suggest concrete replacement text as tracked changes (they comment; apply jobs edit); cross-document review.
