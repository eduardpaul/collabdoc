# 14 · Writer agent flows

**Phase:** 3 · **Depends on:** 10, 12, 13 · **Status:** not started

## Summary

The three ways a Writer is put to work: **Ask** (free-text instruction from the rail, optionally scoped to the current selection), **Mention** (`@handle instruction` in a paragraph), and **Rewrite selection** (selection bar). All three become runtime jobs whose result lands in the document as attributed, undoable commits, with the writer claiming blocks while it works so humans see where it is.

## Current state (collabdoc)

- Rail "Ask an invited agent" form and per-card "Ask to draft" call the stubbed `askAgent`.

## Reference (lorocollab)

- `server/runtime.ts#invokeWriter` — resolves the mention block, flattens mentions, builds the writer prompt with the block id and instruction, enqueues the run, updates status.
- `server/llm-agent.ts#writerPrompt` — rules: `get_document` first, claim with `set_presence`, prefer `locator.find`, smallest edit, at least one write before finish.
- `client/components/SelectionBar.tsx` — selection → "ask a writer/reviewer" bubble.
- `core/tree.ts#flattenMentions`.

## Review before adopting

- The writer is told "make at least one write"; when it does not, lorocollab reports `writes: 0` and leaves the mention block unchanged. Keep the rule and surface "the writer did not change anything: <its summary>" in the chip/card.
- The mention paragraph itself (`@arch write X`) is left for the writer to overwrite. Decide explicitly: the runtime replaces the mention block with the output (default) or inserts after it (setting). Either way the mention node is removed on success and restored on failure.
- Claims: lorocollab's human session has `enforceClaims: false`, so claims never block a person. Keep — humans always win; the writer gets `conflict` and must re-read.
- No selection-scoped run exists server-side; add `scope: { blockIds, locator? }` to the job so the prompt says exactly which span to change and the runtime rejects writes outside the scope (post-check on the run's tool calls).

## Design

- Job kinds: `ask { instruction, scope? }`, `mention { blockId, mentionId, instruction }`, `rewrite { blockId, locator, instruction }`.
- Prompt context: document outline (`get_document` pre-fetched and injected to save a step), the scoped blocks' full text, open comments on those blocks, and the instruction. Rules generated from 13.
- Scope enforcement: a writer run with a scope may only write to the scoped block ids (plus `insert_blocks` adjacent to them); out-of-scope writes are rejected by the session with `forbidden` and counted as an error in the run record.
- Presence: the runtime calls `set_presence` with claims on the scoped blocks before the model starts and clears them on finish.
- Result surfacing: chip/card state, Activity row with `+added −removed`, and a "Review changes" link that opens the History entry filtered to this run (05).
- Rail ask box: target picker (invited writers), instruction, "Use selection as scope" toggle, Send; keyboard `Mod+Enter`.

## Acceptance criteria

- [ ] AC-14.1 Ask: "Draft a two-paragraph introduction" on an empty document produces new paragraphs inserted at the top, attributed to the writer, in ≤ 3 commits, with the mention-free text; undo by the user does not remove them (only the agent's undo or History restore does).
- [ ] AC-14.2 Mention: `@writer expand this` + Enter on a paragraph replaces that paragraph's text with the writer's output, removes the mention node, and the chip shows `done`; on failure the paragraph and chip are restored with the error.
- [ ] AC-14.3 Rewrite selection: selecting a sentence and choosing "Rewrite with <writer>" + instruction changes only that sentence (the rest of the block is byte-identical) and the run record shows a single `replace_text` with a `find` locator.
- [ ] AC-14.4 Scope enforcement: a mocked model attempting `replace_text` on a block outside the scope gets `forbidden`; the run completes with that error listed and no out-of-scope change.
- [ ] AC-14.5 While working, the scoped blocks show the writer's claim outline (07) and the participant list shows "working · ¶n"; claims clear at the end even on error/cancel.
- [ ] AC-14.6 A human typing inside a claimed block is never blocked; the writer's next write to that block returns `conflict` and the writer re-reads (assert the run record shows `conflict` followed by `get_blocks`).
- [ ] AC-14.7 A run with zero writes ends as `done` with the notice "made no changes: <summary>" rather than as an error.
- [ ] AC-14.8 Each writer commit message names the tool and a ≤ 80-char summary; History filters by the writer and shows the diff for each commit.
- [ ] AC-14.9 The writer's output never contains node types outside `ALLOWED_NODES` or mention nodes; attempts are rejected with `schema` and reported.
- [ ] AC-14.10 End-to-end test with a mocked model covers all three job kinds and runs in CI without network.

## Out of scope

Multi-agent handoffs (writer asking reviewer); streaming partial text into the document (writes land per tool call, which is already incremental).
