# 02 · Loro document core and agent tool surface

**Phase:** 1 · **Depends on:** — · **Status:** implemented (2026-09-13)

## Summary

Bring the framework-agnostic document core into `src/core` and `src/shared`: the Loro tree shape that `loro-prosemirror` expects, block/locator resolution, the per-actor `DocumentSession` that exposes the tool surface (`get_document`, `insert_text`, `replace_text`, `add_comment`, …), comment and author sidecars, and change history. This module has no Electron or React dependency and is fully unit-tested. It is the contract everything else builds on.

## Current state (collabdoc)

Implemented in `src/shared` (constants, types, tool definitions, ids, handles, base64) and `src/core` (`document.ts`, `hub.ts`, `tree.ts`, `locators.ts`, `anchors.ts`, `authors.ts`, `comments.ts`, `history.ts`, `session.ts`, `tools/{read,write,presence,comments}.ts`). The renderer's `editor/constants.ts` re-exports from `@shared/constants` so the Tiptap schema and the core vocabulary cannot drift. `src/renderer/src/editor/core-parity.test.ts` proves both directions: a tree built through the tools becomes a valid ProseMirror doc under the real editor schema, and a tree written by `loro-prosemirror` reads back through `get_blocks`. The hub is not yet wired into main or the renderer (03).

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
- Tool descriptions mention mermaid/infographic. Keep them — 01 ships those node types — but move the figure conventions (`text` = diagram source, `attrs.caption`) into one shared paragraph reused by every tool description instead of repeating it.
- `MutationErr.error` kinds are fine; make sure every tool path returns one instead of throwing (grep for `throw new Error` inside tool bodies).
- Per-tool caps live in constants; make them configurable per session so 20 can tighten them for external MCP clients.

## Decisions made while implementing

- **`forbidden` is its own error kind.** A tool outside `allowedTools` returns `{ ok:false, error:"forbidden" }`; `schema` is reserved for bad arguments and disallowed node/mark types. An MCP client or agent can tell "you may not" from "you asked wrong".
- **Author registration is a separate `sys:author` commit** issued right before a session's first real commit, not `subscribeFirstCommitFromPeer`: ops written in that callback land in the *next* pending transaction, so the first exported update would carry no attribution. `sys:` origins are excluded from undo, so undoing the first edit cannot drop the author entry. History hides the registration (no message, no details).
- **An empty paragraph has no `LoroText` child** — the same shape `loro-prosemirror` writes for `<p></p>`. `ensureText` adds one on first write from a tool.
- **`imageFigure` has no agent text** (`text: ""`): the caption is `attrs.caption` for every figure type; `insert_text`/`replace_text` on an image return `schema`. Syntax figures expose the source as `text`.
- **Reviewers get `get_presence` but not `set_presence`**: they can see who is where, they never claim blocks.
- **Comment threads are `LoroMap`s with a `LoroList` of replies** (not a plain LWW value as in lorocollab) so two participants replying at once both land; verified by an offline-merge test.
- **`update_block` refuses type changes to/from figures and atoms** (different child shape) and container↔text retyping when the block has content; the message tells the agent to delete and re-insert instead.
- **Figure attrs are validated in core** (`width ∈ {50,75,100}`, `align ∈ {left,center,right}`, no `style`, `src` must match `^asset:[a-f0-9]{64}$`) so a remote peer or an agent cannot write attrs the renderer would have to sanitise.
- `search` and `get_document` cover figure sources but not image captions; use `get_blocks` for captions.

## Design

- Packages: `src/core/` (Loro-facing), `src/shared/` (types, schemas, constants, protocol). Both compiled for Node (main) and browser (renderer) — no Node imports.
- `DocumentSession` constructor: `(hub, actorProfile, { allowedTools, enforceClaims, limits })`. Each session owns a `LoroDoc` fork and re-exports every local commit to the hub with `origin = actor:<id>` and a `message` describing the tool call.
- Attribution: on first commit each session writes `{actorId, name, color, role}` into the `authors` root map keyed by its peer id (`registerAuthor`). History (05) reads it back.
- Document metadata root map `meta`: `title`, `createdAt`, `schemaVersion`, `docId`.
- Tool surface = the fifteen tools in `shared/types.ts` plus the thread tools added by 09 (`reply_comment`, `resolve_comment`), role-gated. Everything an agent or MCP client can do to a document goes through `DocumentSession.call(toolName, args)` which returns `MutationResult | ReadResult`; this single choke point is where logging and limits live.
- `TEXT_STYLE_CONFIG` is applied via `doc.configTextStyle` on every `LoroDoc` we create (hub, forks, guests) — never forget the guest side.
- Figures: `blockAgentText` returns the diagram source for `mermaidFigure`/`infographicFigure` and the caption is exposed as `attrs.caption`; `imageFigure.src` is an asset reference (`asset:<sha256>`), and the core exposes `listAssets(doc)` so persistence (04) and sync (08) know which assets a document references.

## Acceptance criteria

- [x] AC-02.1 `src/core` and `src/shared` compile under both `tsconfig.node.json` and `tsconfig.web.json` with no Electron/React/Node-only imports (enforced by an ESLint `no-restricted-imports` rule).
- [x] AC-02.2 A `SyncHub` can be created empty; its document has a `meta` map with `docId`, `title`, `schemaVersion = 1`, and a single empty paragraph with a `blockId`.
- [x] AC-02.3 Two `DocumentSession`s on the same hub see each other's writes: a `replace_text` in session A is visible in `get_blocks` in session B synchronously after the call returns.
- [x] AC-02.4 Every tool in `TOOL_DEFINITIONS` is implemented; calling a tool outside a session's `allowedTools` returns `{ ok:false, error:"forbidden" }` and does not change the document.
- [x] AC-02.5 A reviewer-role session cannot mutate text: `insert_text`, `replace_text`, `insert_blocks`, `update_block`, `delete_blocks`, `apply_marks`, `undo`, `redo` are all rejected; `add_comment`, `reply_comment`, `resolve_comment` succeed.
- [x] AC-02.6 Locator resolution: `find` with `occurrence` picks the nth match; `expected` mismatch returns `conflict` with the current block text; a stale anchor after concurrent edits resolves to the moved position or returns `invalid_locator`, never to a wrong span. Each case has a unit test.
- [x] AC-02.7 Concurrent edits from two sessions to the same block converge to the same text in both sessions and on the hub (property-style test with random interleavings, ≥ 200 iterations).
- [x] AC-02.8 Limits: `insert_text` over `MAX_INSERT_CHARS`, `insert_blocks` over `MAX_BLOCKS_PER_CALL`, and `get_blocks` over 50 ids return `limit`; a block type not in `ALLOWED_NODES` returns `schema`.
- [x] AC-02.9 Every successful mutation is committed with `origin = actor:<actorId>` and a non-empty `message`; `doc.getAllChanges()` shows one change per tool call with a timestamp (`setRecordTimestamp(true)`).
- [x] AC-02.10 `listHistory(doc)` attributes every change to the author recorded in the `authors` map, falling back to `{ name: "Unknown peer <id>" }` rather than guessing "human".
- [x] AC-02.11 Unit test coverage for `src/core` and `src/shared` is ≥ 85 % lines (vitest `--coverage`), and `npm test` runs them in under 10 s.
- [x] AC-02.12 The seed text and fixed seed ids from lorocollab do not exist anywhere in the codebase.
- [x] AC-02.13 `get_blocks` on a Mermaid figure returns the source as `text` and the caption as `attrs.caption`; `replace_text` with a `find` locator edits the source; `insert_blocks { type: "mermaidFigure", text, attrs: { caption } }` creates a figure; the same holds for `infographicFigure`; an `imageFigure` cannot be created by agents with a data URI (`schema`), only with an existing `asset:` reference.

## Out of scope

Transport (03), persistence (04), UI (05/09), agent scheduling (12).

## Open questions

- The human's own `DocumentSession` (renderer side) uses the same tool surface for comments so human and agent comment actions are attributed and undoable identically; text editing by humans goes through `loro-prosemirror`, not tools. (Wired in 03.)
- `meta.title` is a plain map value (last-writer-wins); `setTitle(doc, title, origin)` commits it. Revisit only if title conflicts show up in practice.
- `listHistory` walks `getAllChanges()` on every call. Not measured on a 5 000-change document yet — 05 owns the incremental cache if it is needed.
- If a tool session and the editor both add the first `LoroText` to the same empty paragraph concurrently, the paragraph ends up with two text children. `loro-prosemirror` renders both; 03 should decide whether the editor-side `DocumentClient` normalises this.
