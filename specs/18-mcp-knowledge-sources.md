# 18 · External MCP knowledge sources for agents

**Phase:** 3 · **Depends on:** 12 (for the in-process host), 17 · **Status:** configuration, health checks and CLI-backend pass-through implemented 2026-09-20; the LangChain `McpSourceHost` waits for 12

## Summary

Let personas use tools from external MCP servers — the Scope names Microsoft Learn and local file mapping — alongside the document tools. CollabDoc acts as an MCP _client_ (via `@langchain/mcp-adapters`) for the agent runtime; each source is configured once and attached to personas, with tools namespaced so they can never be confused with document tools.

## Current state (collabdoc)

- None (the "Local MCP" settings tab was about connecting CLIs; that moves to 16/17).

## Reference (lorocollab)

- None.

## Review before adopting

- Nothing to port. The one rule to carry from 02/12: external tools must not be able to write to the document; only `DocumentSession` tools can.

## Design

- `McpSource { id, label, transport: "stdio" | "http", command?, args?, env?, url?, headers?, enabled, toolAllowlist?: string[] }` in `userData/mcp-sources.json`; secrets in headers/env go to `safeStorage` (11).
- Presets: **Microsoft Learn** (`https://learn.microsoft.com/api/mcp`, HTTP, no auth), **Local folder** (`@modelcontextprotocol/server-filesystem` via `npx` with the chosen directory as the only argument — read-only by pinning to tools `read_file`, `list_directory`, `search_files`), **Custom**.
- Runtime: `McpSourceHost` in main uses `MultiServerMCPClient` from `@langchain/mcp-adapters` to fetch tools per enabled source, caching per process; tools are prefixed `src_<slug>__<tool>`; personas list `sources: string[]`; 12's factory binds document tools + the persona's source tools.
- Consent & limits: sources are off by default; per-source tool allowlist editor with the tool descriptions shown; per-run cap on external tool calls (20) and on result size (32 KB, truncated with a marker).
- Health: Settings shows each source's status (`ok · 12 tools`, `error: …`) with "Refresh tools"; failures at run time are reported as run errors, not silent tool absence.
- Citations: when a persona uses Microsoft Learn, the prompt asks it to cite the URL in the inserted text as a link mark; nothing enforces this beyond the prompt.

## Implementation notes (2026-09-20)

- `src/main/agents/sources.ts` (`McpSourceStore`): `userData/mcp-sources.json` holds everything but secret values; header and env values live in `userData/secrets.bin` through `SecretStore` (Electron `safeStorage`; plain text with a visible warning when no keyring is available). The renderer only ever sees `{ hasValue, masked }`.
- Presets as designed: **Microsoft Learn** (HTTP, pinned URL), **Local folder** (`npx -y @modelcontextprotocol/server-filesystem <dir>`, allowlist pinned to `read_file`, `read_text_file`, `list_directory`, `search_files` — the pin cannot be widened from the UI), **Custom** (HTTP with a header, or stdio with env).
- "Refresh tools" connects once with the MCP SDK client (Streamable HTTP or stdio), lists tools, disconnects; the result (`ok · N tools` / `error: …`) is persisted so the allowlist editor has descriptions after a restart.
- **For CLI backends (17) the CLI is the MCP client**: an attached, enabled source is added to the run's MCP config as a server named `src_<slug>` next to `collabdoc`. Tool names are therefore namespaced by the CLI itself (`mcp__src_x__tool`, `src_x__tool`) and can never shadow a document tool. Per-tool allowlists are enforced where the CLI has a flag for it (Claude Code `--allowedTools mcp__src_<slug>__<tool>`); grok and agy get the whole server (documented in the Settings hint). A source that is disabled, failing its last check or misconfigured is skipped with a `warning` run event ("source X unavailable: …") and the run proceeds.
- Not done (they belong to the in-process runtime of 12): `MultiServerMCPClient`, the per-run cap of 20 external calls and the 32 KB result truncation (AC-18.5), stdio process idle shutdown (AC-18.7 — for CLI runs the CLI owns the source processes and they end with it), and the Microsoft Learn network test (AC-18.1 second half).

## Acceptance criteria

- [ ] AC-18.1 (preset + Refresh listing tools: done; network run with citation: not automated) — Adding the Microsoft Learn preset and clicking Refresh lists its tools with descriptions; a persona with the source attached asked "explain Azure Functions triggers" produces text containing a `learn.microsoft.com` link (network test, skippable) and the run record shows the external tool call.
- [x] AC-18.2 Local folder source: the filesystem server is started with exactly the chosen directory and only read tools are exposed to the agent (assert the bound tool names); an instruction to write a file results in no such tool being available.
- [x] AC-18.3 External tool names are namespaced `src_<slug>__…`; no external tool can shadow a document tool (unit test with a source that exposes a tool named `replace_text`).
- [x] AC-18.4 A disabled source contributes no tools; enabling it takes effect on the next run without restart.
- [ ] AC-18.5 (in-process runtime only; a CLI's own external calls cannot be capped from outside) Per-run cap: the 21st external call in one run returns a tool error to the model and is recorded; result over 32 KB is truncated with a visible marker.
- [x] AC-18.6 A source that fails to start (bad command, unreachable URL) shows the error in Settings and, if attached to a persona, the run starts anyway with a warning step "source X unavailable" rather than failing.
- [ ] AC-18.7 (in-process runtime only) stdio source processes are stopped when the last run using them finishes or after 5 min idle, and on app quit; no orphan processes remain (test enumerates child processes).
- [x] AC-18.8 Secrets in source headers/env are stored via `safeStorage` and never returned to the renderer.

## Out of scope

Exposing external sources to guests; OAuth flows for MCP servers; MCP sampling/elicitation.
