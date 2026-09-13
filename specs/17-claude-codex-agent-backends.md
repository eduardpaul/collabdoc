# 17 · Claude Code / Codex as agent backends

**Phase:** 3 · **Depends on:** 12, 16 · **Status:** not started

## Summary

Let a persona run on the user's locally installed Claude Code or Codex instead of an API key: CollabDoc launches the CLI headlessly for one turn, points it at its own MCP server (16) so the document tools are the *only* document access, and treats the result like any other run. This is the second half of the Scope's "connect its own Claude or Codex" — the user's subscription/auth is reused, no key is entered in CollabDoc.

## Current state (collabdoc)

- `Agent.routing: 'llm' | 'mcp'` and `McpConnection { kind: 'claude' | 'codex', command }` exist; `selectors.ts#agentCanRun` checks for a "connected" MCP. This spec redefines that model: a **backend** is a way to execute a run; `mcpId` goes away.

## Reference (lorocollab)

- None. lorocollab has no external-agent backend. The `handoff` concept in `voice/handoff.ts` (route a request to a named agent and report back) is the closest analogue for how a run's summary flows back.

## Review before adopting

- The current mock treats "connected" as a persistent socket. CLIs are per-run processes; the state to show is "available" (binary found, auth OK) not "connected".
- Do not spawn the CLI with the user's whole home directory as cwd — give it an empty scratch dir under `userData/agents/<id>/work/` and disallow filesystem tools where the CLI supports it (Claude Code: `--allowedTools` limited to the `mcp__collabdoc__*` tools; Codex: sandbox `read-only` plus MCP).

## Design

- Backend interface (in 12): `AgentBackend { id, kind: "claude-code" | "codex" | "custom-cli", label, detect(): Promise<Availability>, run(job, { systemPrompt, mcp: { url, token, docId }, signal }): AsyncIterable<RunEvent> }`.
- **Claude Code backend**: prefer `@anthropic-ai/claude-agent-sdk` (`query({ prompt, options: { mcpServers: { collabdoc: { type: "http", url, headers } }, allowedTools: ["mcp__collabdoc__*"], permissionMode: "bypassPermissions" or a scoped preset, cwd: scratchDir, maxTurns } })`) which yields structured messages (tool calls, result) — this gives per-step events for the run record. Fallback: spawn `claude -p --output-format stream-json --mcp-config <file> --allowedTools …` and parse the stream.
- **Codex backend**: spawn `codex exec --json --sandbox read-only -c mcp_servers.collabdoc.url=… "<prompt>"` (verify flag names against the installed version at implementation time; pin the minimum CLI version and detect it) and parse the JSON event stream.
- The run's actor identity is the *persona* (name/color/handle), not "Claude Code": the backend passes an `actorId` header to the MCP server so the session is created for the persona, and role gating applies (reviewer personas on a backend still cannot write).
- Prompt: 13's assembled system prompt goes in the CLI's system/append-system-prompt option; the job input is the user prompt.
- Settings → "Backends" (replaces the Local MCP client list): rows for Claude Code and Codex with Detect (path, version, auth status via `claude auth status` / `codex login status`), plus a custom CLI row with a command template.
- Streaming: tool-call events map to run steps; the final assistant text is the run summary; process exit ≠ 0 → `error` with stderr tail.
- Timeouts/cancel: `signal` kills the process group; MCP sessions for that actor are disposed after exit.

## Acceptance criteria

- [ ] AC-17.1 Detect shows the Claude Code binary path, version and auth status; when not installed, the row explains how to install and the backend is not selectable for personas.
- [ ] AC-17.2 A writer persona on the Claude Code backend asked to "draft an intro" produces attributed commits by the persona (not "Claude Code") using only `mcp__collabdoc__*` tools; the run record lists the tool calls with arguments.
- [ ] AC-17.3 The spawned process cannot write outside its scratch dir: an instruction "also save a copy to ~/notes.md" results in no file outside `userData/agents/<id>/work/` (test with a stub CLI that attempts it, and with the real CLI when available).
- [ ] AC-17.4 A reviewer persona on a backend cannot write: the MCP session is created with reviewer tools, and a write attempt is reported as `forbidden` in the run record.
- [ ] AC-17.5 Cancel kills the CLI process (and children) within 2 s, the run ends `cancelled`, and no MCP session for that actor remains open.
- [ ] AC-17.6 CLI failure (non-zero exit, auth expired) surfaces a typed error with the last 20 lines of stderr in the run record and a "Re-check auth" action.
- [ ] AC-17.7 The Codex backend passes the same tests as AC-17.2/17.4/17.5 using `codex exec`; flag names are verified against the pinned minimum version and detection refuses older versions with a message.
- [ ] AC-17.8 Both backends work while the API-key providers (11) are absent; `aiReady` is true with only a backend available.
- [ ] AC-17.9 A stub CLI (`resources/test/fake-cli.js`) that emits a canned event stream is used for CI; real-CLI tests are opt-in via env var.
- [ ] AC-17.10 The obsolete `McpConnection`/`routing: 'mcp'`/`mcpId` types and the fake `connectMcp` are removed; persisted data is migrated to `provider: { kind: "backend" }` where applicable.

## Out of scope

Interactive (TTY) Claude Code sessions inside CollabDoc; passing user files to the CLI; Gemini CLI and other CLIs (the `custom-cli` row covers experiments).
