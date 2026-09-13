# 19 · Activity feed

**Phase:** 4 · **Depends on:** 05, 08, 12 · **Status:** not started

## Summary

Replace the in-memory list of reducer strings with a real, persisted, filterable activity log fed by main: document lifecycle, edits (summarised from history), comments, agent runs (with steps and token counts), sharing events, MCP clients, and errors. It is the audit trail for "who did what and when" that complements History (which is only document changes).

## Current state (collabdoc)

- `state/AppState.tsx#push-activity` keeps ≤ 50 rows in memory, cleared on `home`; kinds `edit | comment | agent | share | join | system`.

## Reference (lorocollab)

- `shared/protocol.ts` `log` message `{ at, actorId, name, tool, summary, ok }` and `DocumentSession.onLog`.

## Review before adopting

- The log is per tool call and not persisted. CollabDoc needs run-level grouping (a run with N steps expands) and persistence per document.

## Design

- Storage: `userData/activity/<docId>.jsonl` (append-only, rotated at 5 MB) written by main; the Loro document is not used for activity because it must include non-document events and must not sync to guests by default.
- Event shape: `{ id, at, docId, actor: { id, name, role, color }, kind, summary, detail?, runId?, ok }`; kinds: `document`, `edit` (one per history commit, summarised), `comment`, `mention`, `agent-run`, `agent-step`, `share`, `peer`, `mcp`, `provider`, `error`.
- Producers: `DocumentRegistry` (open/save/close/import/export), history subscriber (edit rows from 05 commits), comments store, `AgentRuntime` (run start/steps/end with tokens if the model reports usage), `TunnelHost`/`GuestClient`, `DocumentMcpServer`, `ProviderRegistry`.
- Rail Activity tab: newest first, grouped runs (collapsed by default, expandable to steps), filters by kind and actor, search, "Jump to" (block, comment, history entry), export as JSONL/Markdown.
- Guests see their own local activity; host-side events are not synced except those already visible through the document (edits, comments).

## Acceptance criteria

- [ ] AC-19.1 Every producer listed emits at least one event in an end-to-end test (open, type, comment, run agent, share, MCP call, error) and each appears in the Activity tab with the correct actor and kind.
- [ ] AC-19.2 Activity persists: closing and reopening the document shows the previous events; the JSONL file rotates at 5 MB without losing the newest 1 000 events.
- [ ] AC-19.3 Agent runs appear as one collapsed row (`Writer · drafted intro · 4 steps · 1 230 tokens · 12 s`) expandable to steps with tool name, summary, and ok/error; token counts are shown when the provider reports usage and omitted otherwise (never guessed).
- [ ] AC-19.4 Filters by kind and actor and the search box combine; the visible count is shown; clearing filters restores all.
- [ ] AC-19.5 "Jump to" from an edit row selects the History entry (05); from a comment row selects the comment (09); from an agent row filters History to that run.
- [ ] AC-19.6 Errors from any subsystem (provider auth, tunnel down, MCP source failure) appear as `error` rows with the typed reason and are also shown in the notice bar once.
- [ ] AC-19.7 Export writes JSONL or Markdown for the current filter; the file contains no secrets (grep for provider keys and tunnel tokens in a test).
- [ ] AC-19.8 The renderer receives events in batches (≤ 10/100 ms) and the tab stays responsive with 10 000 events (virtualised list).
- [ ] AC-19.9 The old in-memory `push-activity` path is removed; the reducer no longer holds activity.

## Out of scope

Cross-document activity view on the start screen (nice to have later); syncing activity to guests.
