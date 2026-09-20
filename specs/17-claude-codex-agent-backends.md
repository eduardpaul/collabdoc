# 17 · CLI agents (Claude Code, grok, Antigravity, Codex, …) as agent backends

**Phase:** 3 · **Depends on:** 12 (scheduling shell only), 16 · **Status:** implemented 2026-09-20 (generic CLI backend; see Implementation notes)

## Summary

Let a persona run on the user's locally installed Claude Code or Codex instead of an API key: CollabDoc launches the CLI headlessly for one turn, points it at its own MCP server (16) so the document tools are the _only_ document access, and treats the result like any other run. This is the second half of the Scope's "connect its own Claude or Codex" — the user's subscription/auth is reused, no key is entered in CollabDoc.

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
- The run's actor identity is the _persona_ (name/color/handle), not "Claude Code": the backend passes an `actorId` header to the MCP server so the session is created for the persona, and role gating applies (reviewer personas on a backend still cannot write).
- Prompt: 13's assembled system prompt goes in the CLI's system/append-system-prompt option; the job input is the user prompt.
- Settings → "Backends" (replaces the Local MCP client list): rows for Claude Code and Codex with Detect (path, version, auth status via `claude auth status` / `codex login status`), plus a custom CLI row with a command template.
- Streaming: tool-call events map to run steps; the final assistant text is the run summary; process exit ≠ 0 → `error` with stderr tail.
- Timeouts/cancel: `signal` kills the process group; MCP sessions for that actor are disposed after exit.

## Implementation notes (2026-09-20)

The spec was implemented as a **generic CLI agent backend** rather than two hard-coded ones, so any headless agent CLI the user already has (and is signed in to) can run a persona. What changed from the Design above:

- **Backend = `CliProfile`** (`src/main/agents/cli-profiles.ts`): one declarative profile per CLI — binary, version probe, sign-in probe, how the MCP server config is delivered, which stdout parser to use, and the flags that keep it away from the user's files. Built-ins: `claude-code`, `grok`, `antigravity` (agy), `gemini`, `codex`, plus `custom-cli` (a command template with `{prompt} {systemPrompt} {mcpUrl} {mcpToken} {mcpConfigFile} {cwd} {maxTurns}`). The `@anthropic-ai/claude-agent-sdk` path was not used: spawning `claude -p --output-format stream-json` gives the same events and keeps one code path for every CLI.
- **Verified against real binaries on 2026-09-20**: Claude Code 2.1.149, grok 1.0.30, Antigravity 1.2.2 each drove a document end to end as a persona (`src/main/agents/real-cli.test.ts`, opt-in via `COLLABDOC_REAL_CLI=claude-code,grok,antigravity`). Gemini 0.41.2 was detected but could not be signed in on the dev machine; Codex was not installed. Both profiles carry `verified: false`, shown as an "unverified" chip in Settings.
- **Per-CLI findings**:
  - Claude Code: `--tools ""` removes every built-in tool; `--allowedTools mcp__collabdoc` auto-approves the document server under `--permission-mode default`; `--strict-mcp-config` ignores the user's own servers. `CLAUDECODE` is removed from the env so a CollabDoc launched from a Claude Code terminal still works.
  - grok: `--tools ""` is treated as unset (it kept shell access and hand-rolled HTTP to the MCP server); the profile passes `--tools todo_write` (one harmless built-in) instead. Repo-local `.grok/config.toml` servers only start in a trusted folder, so the run passes the hidden `--trust` flag; `grok mcp doctor` was the diagnostic that found this. Output format `streaming-messages-json` is the same shape as Claude's `stream-json`, so one parser (`MessagesParser`) serves both.
  - Antigravity (`agy`): there is no per-run MCP config; the run does `agy mcp add …` into the user-level `~/.gemini/config/mcp_config.json` before launching and `agy mcp remove` after. There is no system-prompt flag, so the system prompt is folded into the user prompt. Its stream-json `step_update` events have a closed `step_type` vocabulary; MCP calls appear as `call_mcp_tool` steps.
  - Gemini: project `.gemini/settings.json` in the scratch dir carries the servers and `tools.core: []`; `GEMINI_CLI_TRUST_WORKSPACE=true` is required headless.
- **Identity**: the runtime pre-registers a run binding (`runId → persona, role, docId`) with the MCP server and the CLI sends `X-CollabDoc-Run: <runId>` next to the bearer token. Only pre-registered ids are accepted, so a CLI cannot pick an identity; the `actorId` header idea from the Design was dropped for that reason.
- **Run record steps come from the server side**: `DocumentMcpServer` records every `tools/call` of a run (tool, args, ok, error kind) regardless of what the CLI prints, so AC-17.2/17.4 hold even for CLIs whose stream format hides tool arguments (agy). The CLI stream contributes the assistant text, the final summary and external-tool activity.
- **Scheduling (12's shell)** lives in `AgentRuntime`: FIFO per agent, `maxParallel = 2`, backlog cap 8 with a `rejected` record, 3 min wall clock, 40 writes per run, cancel kills the process group (SIGTERM → SIGKILL after 1 s). The in-process DeepAgents runtime is still 12's job and plugs in beside the CLI backends.
- **Renderer**: `Agent.provider: { kind: 'default' } | { kind: 'backend', id }`; `default` = first available backend in `BACKEND_IDS` order. `McpConnection`, `routing`, `mcpId` and `connectMcp` are gone; persisted agents migrate on load (`lib/persist.ts#migrateAgent`). Detect results stream to the renderer per backend (`agents:backend`) so a fast CLI shows before a slow sign-in probe finishes, and an Ask during the first seconds waits for Detect instead of failing.
- **Scratch dir**: `userData/agents/<id>/work/` is emptied before every run; the MCP config files (which carry the token and source secrets) are removed after it. `COLLABDOC_USER_DATA` overrides Electron's userData for tests and side-by-side profiles.
- **Tests**: `resources/test/fake-cli.js` (stub speaking the Claude/grok shape, with an `mcp` mode that really connects to the server) drives `CliBackend.test.ts` and `AgentRuntime.test.ts` in CI; `e2e/electron-agent.spec.ts` (opt-in `COLLABDOC_ELECTRON_E2E=1`) runs the whole flow in the built Electron app with the real Claude Code.

## Acceptance criteria

- [x] AC-17.1 Detect shows the Claude Code binary path, version and auth status; when not installed, the row explains how to install and the backend is not selectable for personas.
- [x] AC-17.2 A writer persona on the Claude Code backend asked to "draft an intro" produces attributed commits by the persona (not "Claude Code") using only `mcp__collabdoc__*` tools; the run record lists the tool calls with arguments.
- [x] AC-17.3 (stub: cwd is the scratch dir and a cwd-relative save lands there; real CLIs: by their own flags — Claude `--tools ""`, grok `--tools todo_write`, agy `--sandbox` — a hostile-instruction test against the real binaries was not automated) The spawned process cannot write outside its scratch dir: an instruction "also save a copy to ~/notes.md" results in no file outside `userData/agents/<id>/work/` (test with a stub CLI that attempts it, and with the real CLI when available).
- [x] AC-17.4 A reviewer persona on a backend cannot write: the MCP session is created with reviewer tools, and a write attempt is reported as `forbidden` in the run record.
- [x] AC-17.5 Cancel kills the CLI process (and children) within 2 s, the run ends `cancelled`, and no MCP session for that actor remains open.
- [x] AC-17.6 CLI failure (non-zero exit, auth expired) surfaces a typed error with the last 20 lines of stderr in the run record and a "Re-check auth" action.
- [ ] AC-17.7 (Codex profile written from the docs: `codex exec --json --sandbox read-only` with `-c mcp_servers.*` overrides, `codex login status` for auth, min 0.50.0; not verified — no Codex on the dev machine. Version pinning and refusal are tested with the stub.) The Codex backend passes the same tests as AC-17.2/17.4/17.5 using `codex exec`; flag names are verified against the pinned minimum version and detection refuses older versions with a message.
- [x] AC-17.8 Both backends work while the API-key providers (11) are absent; `aiReady` is true with only a backend available.
- [x] AC-17.9 A stub CLI (`resources/test/fake-cli.js`) that emits a canned event stream is used for CI; real-CLI tests are opt-in via env var.
- [x] AC-17.10 The obsolete `McpConnection`/`routing: 'mcp'`/`mcpId` types and the fake `connectMcp` are removed; persisted data is migrated to `provider: { kind: "backend" }` where applicable.

## Out of scope

Interactive (TTY) CLI sessions inside CollabDoc (the user's own interactive session connects through 16 instead); passing user files to the CLI; per-run cost reporting (19).
