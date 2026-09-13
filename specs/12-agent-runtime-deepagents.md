# 12 · Agent runtime in main on LangChain DeepAgents

**Phase:** 3 · **Depends on:** 03, 11 · **Status:** not started

## Summary

Replace the `setTimeout` stubs with a real runtime in the main process. Each agent turn is a LangChain DeepAgents run whose only way to touch the document is the tool surface from 02, executed through that agent's own `DocumentSession` (attributed, role-gated, undoable). The runtime schedules turns, enforces concurrency and backlog caps, streams status/log events to the renderer, and supports cancellation. Writer/Reviewer behaviour on top of it is specified in 14 and 15.

## Current state (collabdoc)

- `useSessionActions.ts#askAgent` flips `status: 'working'`, posts an activity row, and after 1.4 s posts "Finished the turn. Output will land in the document once LangChain DeepAgents is connected."
- `Agent { routing: 'llm' | 'mcp', mcpId }` exists in `types.ts`.

## Reference (lorocollab)

- `server/runtime.ts` — `AgentRuntime`: `LiveAgent { session, queue, busy, cancelled, timers }`, `enqueue`, `maxParallel = 2`, `MAX_AGENT_QUEUE`, `JobOutcome`, `handoff`, status/log/roster callbacks.
- `server/llm-agent.ts` — `runLlmAgent`: manual tool loop, `MAX_STEPS = 12`, `MAX_RESULT_CHARS`, `FINISH_TOOL`, `openaiTools(names)` mapping `TOOL_DEFINITIONS` to function tools, `reviewerPrompt` / `writerPrompt`.
- `shared/types.ts` — `DOCUMENT_WRITE_TOOLS` used to decide "did the agent actually write".
- `server/runtime.test.ts`, `server/llm-agent.test.ts`.

## Review before adopting

- `runtime.ts` (893 lines) mixes scheduling, reviewer heuristics, mention parsing, apply jobs, voice handoff and Azure config. Keep only the scheduling model (per-agent queue, global semaphore, cancellation) and re-implement it as `AgentScheduler`; reviewer/writer policies move to 14/15; voice is dropped.
- The manual loop in `llm-agent.ts` is replaced by DeepAgents (`createDeepAgent`) with our tools bound via `tool()` from `@langchain/core/tools`. DeepAgents brings a planning tool, a virtual filesystem and subagents; **disable or sandbox the filesystem tools** — the document is the only thing an agent edits, and any scratch space must live under `userData/agents/<id>/`, never the user's disk (18 may open this up deliberately).
- `MAX_STEPS = 12` was tuned for one paragraph. Make it per-role config (`writer 24`, `reviewer 12`) and expose "steps used" in the log.
- Prompts say "Never reply with plain assistant text. Always call a tool." That worked with Azure GPT; with DeepAgents the final answer is a message. Treat the final message as the turn summary and require at least one `DOCUMENT_WRITE_TOOLS` call for writers (14).
- Tool results in lorocollab are JSON strings truncated at 8 000 chars. Keep the cap but truncate *block views*, not the JSON mid-string.
- `onLog` broadcast is per tool call — fine, but batch to the renderer at ≤ 10 events/100 ms.
- No cancellation reaches the LLM call in lorocollab (`cancelled` is checked between steps). Use `AbortSignal` all the way into the model call.

## Design

- Main: `src/main/agents/AgentRuntime.ts` (public API: `invite(agentId, docId)`, `remove`, `run(job)`, `cancel(runId)`, events), `AgentScheduler.ts` (per-agent FIFO, global `maxParallel` from settings default 2, backlog cap 8, priority: user-initiated > mention > reviewer sweep), `AgentSessionFactory.ts` (creates a `DocumentSession` per invited agent per document with `allowedTools` by role), `tools.ts` (LangChain tools wrapping `session.call(name, args)` with zod schemas generated from `TOOL_DEFINITIONS`), `DeepAgentFactory.ts` (`createDeepAgent({ model, tools, systemPrompt, subagents?, backend })` per run, model from 11 or backend from 17).
- Run record: `{ runId, agentId, docId, kind: "ask" | "mention" | "review" | "apply", input, startedAt, steps: ToolCall[], writes: number, outcome, tokens?, error? }` streamed to the renderer as `agents:event` and persisted in Activity (19).
- Renderer: `agents` slice reflects `status: idle | queued | working | done | error`, current step summary, cancel button; ask box wires to `agents:run`.
- Safety rails at the runtime level: per-run write cap (e.g. 40 write calls), per-run wall clock (3 min default), max output chars per run; exceeding any ends the run with `limit` and the document keeps what was written (all attributed, undoable).
- Every agent commit carries `origin = agent:<agentId>` and `message = <tool> <summary>`; the agent's identity is registered in `authors` (02) on invite.
- Renderer-only dev mode (03) gets a `FakeRuntime` that echoes tool calls, so UI work never needs a key.

## Acceptance criteria

- [ ] AC-12.1 With a tested provider, "Ask to draft" on an invited Writer results in at least one attributed commit in the document within the run's time limit; the History panel shows the agent's name and the tool message; the run record lists every tool call.
- [ ] AC-12.2 A Reviewer run cannot mutate text: the LangChain tool list bound for a reviewer contains only `REVIEWER_TOOLS`; a unit test asserts the write tools are absent and that a forged call is rejected by the session.
- [ ] AC-12.3 Concurrency: with `maxParallel = 2` and three agents asked at once, at most two model calls are in flight (assert via a mocked model); the third shows `queued` and starts when one finishes.
- [ ] AC-12.4 Backlog: the 9th queued job for one agent is rejected with a notice, not silently dropped or queued.
- [ ] AC-12.5 Cancel: clicking Cancel during a run aborts the in-flight model call (mock observes `AbortSignal`), the run ends with `cancelled`, and any writes already committed remain and are undoable by the agent's own undo (06) or via History restore.
- [ ] AC-12.6 Limits: a run that attempts a 41st write, exceeds 3 minutes, or exceeds max steps ends with `limit`, the reason is visible in the run record and Activity, and no partial tool call is applied.
- [ ] AC-12.7 DeepAgents' built-in filesystem tools do not reach the user's filesystem: an agent instructed to "write a file to ~/x" either has no such tool or writes only under `userData/agents/<id>/` (test asserts no file outside that dir).
- [ ] AC-12.8 Provider or network failure mid-run surfaces as `error` with the typed reason from 11 on the agent card and in Activity; the agent returns to `idle` and can be re-run.
- [ ] AC-12.9 Runtime events reach the renderer at ≤ 10 batches per 100 ms during a busy run (measure with a mock producing 500 events).
- [ ] AC-12.10 Removing an agent from the session disposes its `DocumentSession` and cancels its queued/in-flight runs; its past commits remain attributed to it.
- [ ] AC-12.11 Runs on a shared document (08) executed by the host are visible to guests as ordinary attributed edits; guests do not run agents on the host's behalf (agents are host-local in this version).
- [ ] AC-12.12 Unit tests for scheduler ordering, caps and cancellation run without any network (mock `BaseChatModel`).

## Out of scope

Reviewer/writer policies (14/15), external MCP tools for agents (18), Claude/Codex backends (17), token cost reporting (19), guest-side agents.
