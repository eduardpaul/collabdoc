# 18 · External MCP knowledge sources for agents

**Phase:** 3 · **Depends on:** 12 · **Status:** not started

## Summary

Let personas use tools from external MCP servers — the Scope names Microsoft Learn and local file mapping — alongside the document tools. CollabDoc acts as an MCP *client* (via `@langchain/mcp-adapters`) for the agent runtime; each source is configured once and attached to personas, with tools namespaced so they can never be confused with document tools.

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

## Acceptance criteria

- [ ] AC-18.1 Adding the Microsoft Learn preset and clicking Refresh lists its tools with descriptions; a persona with the source attached asked "explain Azure Functions triggers" produces text containing a `learn.microsoft.com` link (network test, skippable) and the run record shows the external tool call.
- [ ] AC-18.2 Local folder source: the filesystem server is started with exactly the chosen directory and only read tools are exposed to the agent (assert the bound tool names); an instruction to write a file results in no such tool being available.
- [ ] AC-18.3 External tool names are namespaced `src_<slug>__…`; no external tool can shadow a document tool (unit test with a source that exposes a tool named `replace_text`).
- [ ] AC-18.4 A disabled source contributes no tools; enabling it takes effect on the next run without restart.
- [ ] AC-18.5 Per-run cap: the 21st external call in one run returns a tool error to the model and is recorded; result over 32 KB is truncated with a visible marker.
- [ ] AC-18.6 A source that fails to start (bad command, unreachable URL) shows the error in Settings and, if attached to a persona, the run starts anyway with a warning step "source X unavailable" rather than failing.
- [ ] AC-18.7 stdio source processes are stopped when the last run using them finishes or after 5 min idle, and on app quit; no orphan processes remain (test enumerates child processes).
- [ ] AC-18.8 Secrets in source headers/env are stored via `safeStorage` and never returned to the renderer.

## Out of scope

Exposing external sources to guests; OAuth flows for MCP servers; MCP sampling/elicitation.
