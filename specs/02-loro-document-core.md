# 02 · Loro document core and agent tool surface

**Phase:** 1 · **Depends on:** — · **Status:** not started

## Summary

Bring the framework-agnostic document core into `src/core` and `src/shared`: the Loro tree shape that `loro-prosemirror` expects, block/locator resolution, the per-actor `DocumentSession` that exposes the tool surface (`get_document`, `insert_text`, `replace_text`, `add_comment`, …), comment and author sidecars, and change history. This module has no Electron or React dependency and is fully unit-tested. It is the contract everything else builds on.

## Current state (collabdoc)

Nothing. Document content is a string.

## Reference (lorocollab)

- `core/tree.ts` — walking the `doc → children → {nodeName, attributes, children}` tree, `findBlock`, `outline`, `toBlockView`, `createBlock`, `deleteBlock`, `blockAgentText`, `flattenMentions`.
- `core/locators.ts` — `TextLocator` resolution (`find` + `occurrence`, `expected`, `after`/`before`, cursor anchors) with conflict detection.
- `core/session.ts` (958 lines) — `DocumentSession`: per-actor `LoroDoc` fork synced through the hub, `UndoManager`, claims via ephemeral store, `allowedTools`, every tool implementation, `SessionLog`.
- `core/comments.ts`, `core/history.ts`, `core/bootstrap.ts`, `core/hub.ts`.
- `shared/types.ts` — `TOOL_DEFINITIONS`, `REVIEWER_TOOLS`, `WRITER_TOOLS`, `DOCUMENT_WRITE_TOOLS`, `MutationResult` error kinds.
- `shared/constants.ts` — key names, caps (`MAX_INSERT_CHARS`, `MAX_BLOCKS_PER_CALL`, `MAX_SEARCH_RESULTS`, `DEFAULT_CLAIM_SECONDS`), `TEXT_STYLE_CONFIG`.
- Tests: `core/session.test.ts`, `comments.test.ts`, `history.test.ts`, `reconnect.test.ts`, `shared/protocol.test.ts`, `mentions.test.ts`.

## Review before adopting

- `session.ts` is one 958-line class. Split into `session.ts` (lifecycle, sync, undo), `tools/read.ts`, `tools/write.ts`, `tools/presence.ts`, `tools/comments.ts`. Keep the public `DocumentSession` API.
- `bootstrap.ts` seeds "Collaborative canvas" text with fixed ids `b_seedhead01`. CollabDoc must create an **empty** document (one empty paragraph) and take the title from metadata.
- `hub.ts` uses `doc.setPeerId("1")` for the hub and `HUB_ORIGIN = "sys:init"`. Peer id 1 will collide the moment two hosts' documents ever merge (a guest re-hosting). Use random peer ids everywhere and a `meta` map for provenance.
- `actors.ts` hard-codes `HUMAN_ACTOR = { actorId: "you", name: "You" }` and `VOICE_ACTOR`. Replace with an identity passed in by 07; remove voice.
- `history.ts` walks `doc.getAllChanges()` on every settle and forks the doc to diff. Measure on a 5 000-change document; add an incremental cache keyed by frontier if it exceeds 100 ms.
- Claims are advisory and only enforced when `enforceClaims` is on; the human session has it off. Keep that, but document it in the tool description so agents do not rely on claims as locks.
- Tool descriptions mention mermaid/infographic. Remove until those node types exist.
- `MutationErr.error` kinds are fine; make sure every tool path returns one instead of throwing (grep for `throw new Error` inside tool bodies).
- Per-tool caps live in constants; make them configurable per session so 20 can tighten them for external MCP clients.

## Design

- Packages: `src/core/` (Loro-facing), `src/shared/` (types, schemas, constants, protocol). Both compiled for Node (main) and browser (renderer) — no Node imports.
- `DocumentSession` constructor: `(hub, actorProfile, { allowedTools, enforceClaims, limits })`. Each session owns a `LoroDoc` fork and re-exports every local commit to the hub with `origin = actor:<id>` and a `message` describing the tool call.
- Attribution: on first commit each session writes `{actorId, name, color, role}` into the `authors` root map keyed by its peer id (`registerAuthor`). History (05) reads it back.
- Document metadata root map `meta`: `title`, `createdAt`, `schemaVersion`, `docId`.
- Tool surface = exactly the fifteen tools in `shared/types.ts`, role-gated. Everything an agent or MCP client can do to a document goes through `DocumentSession.call(toolName, args)` which returns `MutationResult | ReadResult`; this single choke point is where logging and limits live.
- `TEXT_STYLE_CONFIG` is applied via `doc.configTextStyle` on every `LoroDoc` we create (hub, forks, guests) — never forget the guest side.

## Acceptance criteria

- [ ] AC-02.1 `src/core` and `src/shared` compile under both `tsconfig.node.json` and `tsconfig.web.json` with no Electron/React/Node-only imports (enforced by an ESLint `no-restricted-imports` rule).
- [ ] AC-02.2 A `SyncHub` can be created empty; its document has a `meta` map with `docId`, `title`, `schemaVersion = 1`, and a single empty paragraph with a `blockId`.
- [ ] AC-02.3 Two `DocumentSession`s on the same hub see each other's writes: a `replace_text` in session A is visible in `get_blocks` in session B synchronously after the call returns.
- [ ] AC-02.4 Every tool in `TOOL_DEFINITIONS` is implemented; calling a tool outside a session's `allowedTools` returns `{ ok:false, error:"schema" }` (or a dedicated `forbidden` kind — pick one and document it) and does not change the document.
- [ ] AC-02.5 A reviewer-role session cannot mutate text: `insert_text`, `replace_text`, `insert_blocks`, `update_block`, `delete_blocks`, `apply_marks`, `undo`, `redo` are all rejected; `add_comment` succeeds.
- [ ] AC-02.6 Locator resolution: `find` with `occurrence` picks the nth match; `expected` mismatch returns `conflict` with the current block text; a stale anchor after concurrent edits resolves to the moved position or returns `invalid_locator`, never to a wrong span. Each case has a unit test.
- [ ] AC-02.7 Concurrent edits from two sessions to the same block converge to the same text in both sessions and on the hub (property-style test with random interleavings, ≥ 200 iterations).
- [ ] AC-02.8 Limits: `insert_text` over `MAX_INSERT_CHARS`, `insert_blocks` over `MAX_BLOCKS_PER_CALL`, and `get_blocks` over 50 ids return `limit`; a block type not in `ALLOWED_NODES` returns `schema`.
- [ ] AC-02.9 Every successful mutation is committed with `origin = actor:<actorId>` and a non-empty `message`; `doc.getAllChanges()` shows one change per tool call with a timestamp (`setRecordTimestamp(true)`).
- [ ] AC-02.10 `listHistory(doc)` attributes every change to the author recorded in the `authors` map, falling back to `{ name: "Unknown peer <id>" }` rather than guessing "human".
- [ ] AC-02.11 Unit test coverage for `src/core` and `src/shared` is ≥ 85 % lines (vitest `--coverage`), and `npm test` runs them in under 10 s.
- [ ] AC-02.12 The seed text and fixed seed ids from lorocollab do not exist anywhere in the codebase.

## Out of scope

Transport (03), persistence (04), UI (05/09), agent scheduling (12).

## Open questions

- Should `meta.title` be a `LoroText` (collaboratively editable) or a plain map value (last-writer-wins)? Recommendation: plain value; titles are short and conflicts are rare.
