# 16 · CollabDoc as an MCP server for local Claude Code / Codex

**Phase:** 3 · **Depends on:** 03, 09 · **Status:** not started

## Summary

Expose the open document's tool surface (02) as a Model Context Protocol server so the user's own locally running Claude Code, Codex, or any MCP client can read, edit, and comment on the document as an attributed participant. This is the "connect its own Claude or Codex using locally running MCP" requirement in the Scope. The server runs inside the Electron main process; nothing leaves the machine.

## Current state (collabdoc)

- Settings → "Local MCP" lists `Claude (local MCP)` / `Codex (local MCP)` with `command: claude|codex`, `transport: stdio|sse`; `connectMcp` fakes a connection. The model in `types.ts` treats CollabDoc as an MCP _client_ of those CLIs, which is backwards for this feature — the CLIs are clients of CollabDoc's document tools (17 covers CollabDoc driving the CLIs).

## Reference (lorocollab)

- `shared/types.ts#TOOL_DEFINITIONS` — the JSON-schema tool definitions map 1:1 to MCP tool definitions.
- `core/session.ts` — a `DocumentSession` per connected client is exactly the isolation MCP needs (each client = one actor with its own peer id, undo stack, and role).
- `server/index.ts` — loopback/origin/host guards for the HTTP transport.

## Review before adopting

- No MCP code exists in lorocollab; the tool schemas are the reusable part. Descriptions were written for GPT tool-calling; re-read each for an external agent that has _no_ system prompt from us (Claude Code will see only the tool descriptions), and add a `get_instructions`/server `instructions` field explaining the workflow (`get_document` → `get_blocks` → edit with locators → comments).
- The session's `allowedTools` by role must be settable per MCP client: a client registers as `writer` (default) or `reviewer`.
- MCP clients may call tools very fast (Claude Code parallel tool calls); the session already serialises through Loro, but rate-limit per client (e.g. 20 writes/s) so a runaway agent cannot flood history.

## Design

- Server: `src/main/mcp/DocumentMcpServer.ts` using `@modelcontextprotocol/sdk` `McpServer` with two transports:
  - **Streamable HTTP** on `127.0.0.1:<random port>` with a per-launch bearer token — the primary transport; supports many concurrent clients and works for Claude Code (`claude mcp add --transport http collabdoc http://127.0.0.1:PORT/mcp --header "Authorization: Bearer …"`) and Codex (`~/.codex/config.toml` `[mcp_servers.collabdoc]`).
  - **stdio bridge** `collabdoc-mcp` (a tiny script shipped in `resources/`) that connects to the HTTP endpoint using the token from `userData/mcp.json`, for clients that only speak stdio.
- Tools: the fifteen from `TOOL_DEFINITIONS` plus `list_documents` (open documents: id, title), `select_document { docId }` (or a `docId` argument on every tool — choose the latter; simpler and stateless), and `whoami`. Resources: `collabdoc://doc/<id>` (Markdown rendering, read-only) and `collabdoc://doc/<id>/outline`. Prompts: `review-document`, `draft-section` as MCP prompts so users can invoke them from their client.
- Identity: on first tool call a client is bound to an actor `{ actorId: "mcp:<clientName>:<n>", name: clientInfo.name (e.g. "Claude Code"), role from a `register` tool or default writer, color }`, registered in `authors`, shown in the participant list as an external agent with a plug icon; presence published while calls are in flight.
- Settings → Local MCP becomes: server status (`running on port N`), token (copy / rotate), per-client role, "Copy setup command" for Claude Code and Codex, connected clients list with disconnect, and an "Allow external agents to edit this document" per-document toggle (default on for the host, off for guests).
- Consent: the first tool call from a new client shows a non-blocking banner "Claude Code connected as writer — Allow / Reviewer only / Block"; default Allow after 10 s is **not** acceptable — it must be an explicit choice, persisted per client name.

## Acceptance criteria

- [ ] AC-16.1 With the server enabled, `claude mcp add` (HTTP) followed by `claude "list my open documents"` returns the open document titles; `get_document` returns the outline with block ids; no other process on the machine can call the endpoint without the bearer token (401).
- [ ] AC-16.2 An external client's `replace_text` produces an attributed commit (author "Claude Code" with a distinct color) visible in History, the editor, and to guests; `Mod+Z` by the human does not undo it.
- [ ] AC-16.3 A client registered as `reviewer` receives only `REVIEWER_TOOLS` in `tools/list` and gets an MCP error when calling a write tool by name.
- [ ] AC-16.4 First contact from a new client shows the consent banner; until the user chooses, calls return an MCP error "awaiting approval in CollabDoc"; the choice persists per client name and is editable in Settings.
- [ ] AC-16.5 The stdio bridge works with a stdio-only client (test with the MCP Inspector in stdio mode) and forwards every tool with identical results to the HTTP transport.
- [ ] AC-16.6 Rate limit: a client issuing 200 writes in one second gets `limit` errors after the cap and the document has at most the cap's number of commits; the participant list shows a warning on that client.
- [ ] AC-16.7 Closing the document ends its sessions: subsequent calls with that `docId` return `not_found`; `list_documents` no longer lists it; the client is not disconnected from the server.
- [ ] AC-16.8 The `collabdoc://doc/<id>` resource returns the same Markdown as Export (04); resource subscriptions notify on document change at most 2×/s.
- [ ] AC-16.9 Token rotation disconnects all clients and the "Copy setup command" output changes; the old token returns 401.
- [ ] AC-16.10 The MCP server binds to loopback only and is off by default; enabling it is a persisted setting shown on the start screen AI card.
- [ ] AC-16.11 Tool descriptions and the server `instructions` field are reviewed for an external agent with no system prompt: a scripted Claude Code run that is told only "improve the intro of my open document" completes with ≤ 8 tool calls (golden transcript test, allowed to be skipped without credentials).

## Out of scope

Exposing provider keys or agent personas over MCP; serving guests' documents (only the local instance's open documents); non-loopback binding.
