# 13 · Agent personas, skills, memory, and roster management

**Phase:** 3 · **Depends on:** 12 · **Status:** not started

## Summary

Make agents configurable participants: a persona (name, handle, role, color, voice/instructions), a set of skills (reusable instruction modules with optional subagent), a provider/backend choice, and per-agent memory that persists across documents. The Settings → Agents tab becomes the roster editor; inviting an agent into a document registers it as a participant.

## Current state (collabdoc)

- `types.ts#Agent { name, role, persona, skills: string[], routing, mcpId, invited, status }`; two defaults (Writer, Reviewer) in `state/defaults.ts`.
- `SettingsModal.tsx` agents tab: create/edit/delete with free-text skills; nothing consumes them.

## Reference (lorocollab)

- `shared/protocol.ts#RosterAgent { actorId, kind, name, handle, color, goal, idleSeconds }` — the minimal persona.
- `shared/actors.ts#REVIEWER_GOAL_PRESETS` — three goal presets worth keeping as skill seeds.
- `server/llm-agent.ts#reviewerPrompt/writerPrompt` — prompt structure (identity, goal, hard rules about tools).
- `client/components/Roster.tsx` — add reviewer/writer forms.

## Review before adopting

- lorocollab agents are ephemeral (lost on server restart) and have one free-text `goal`. CollabDoc agents are persistent config; `goal` becomes `persona.instructions`, and reusable "what to watch for" becomes a skill.
- `handle` validation (`shared/mentions.ts#isValidHandle`) is good; reuse the rule (lowercase, `[a-z0-9_-]{2,20}`) and enforce uniqueness across the roster.
- Colors were assigned round-robin per process; make color part of the persisted persona so attribution colors are stable across sessions and machines (guests see the host's agent color via `authors`).
- The prompts hard-code node type lists and "never reply with text". Generate the schema section from `ALLOWED_NODES/MARKS` at runtime so prompts never drift from the schema.

## Design

- `AgentPersona { id, name, handle, role: "writer" | "reviewer", color, instructions, skills: SkillRef[], provider: { kind: "default" } | { kind: "provider", id } | { kind: "backend", id }, memory: { enabled }, limits?: Partial<RunLimits> }` in `userData/agents.json`.
- **Skills**: `userData/skills/<slug>/SKILL.md` (frontmatter `name`, `description`, `role: writer|reviewer|any`, optional `subagent: true`) — the same shape as Claude Code skills so users can reuse existing ones. Built-in seeds: `outline`, `draft-section`, `rewrite-in-voice`, `tighten-copy`, `check-claims`, `structure-review`, `tone-review`. Skills are injected into the system prompt (non-subagent) or registered as DeepAgents subagents (subagent) with the same document tools and the parent's role gate.
- **Memory**: per-agent DeepAgents memory backend rooted at `userData/agents/<id>/memory/` — the agent can read/write notes about the user's preferences and style; shown in the agent editor ("What this agent remembers") with a clear button. Memory is never shared between agents or documents unless the persona says so.
- System prompt assembly (in 12's `DeepAgentFactory`): identity → role rules (generated) → schema section (generated) → persona instructions → skill bodies → document context (title, outline) → run input.
- Roster UI: list with role badge, handle, provider chip, color swatch; editor form; "Invite to this document" from the rail; import/export persona as JSON.
- Migration: existing `agents` from `collabdoc.v1` map to personas (`persona → instructions`, free-text skills → ignored with a notice).

## Acceptance criteria

- [ ] AC-13.1 Creating an agent requires a unique handle and a name; the roster rejects duplicates and invalid handles with inline errors; personas persist in `agents.json` and survive restart.
- [ ] AC-13.2 The agent's color is stable: after restart and on a guest machine (via `authors`), the agent's commits show the same color as in the persona.
- [ ] AC-13.3 Attaching a non-subagent skill adds its `SKILL.md` body to the system prompt of the next run (assert on the prompt captured by a mocked model); attaching a subagent skill registers a DeepAgents subagent that receives only the tools allowed for the parent's role.
- [ ] AC-13.4 A user-authored skill dropped into `userData/skills/<slug>/SKILL.md` appears in the skill picker after "Reload skills" (or on next launch) with its description; malformed frontmatter shows a readable error.
- [ ] AC-13.5 Memory: with memory enabled, a run that writes a note produces a file under `userData/agents/<id>/memory/`; the next run on a different document sees it (mocked model asserts the note is in context); "Clear memory" removes it; memory disabled → no files written.
- [ ] AC-13.6 Per-agent provider override is respected: an agent set to provider B runs against B while the default is A (mock both and assert which was called).
- [ ] AC-13.7 The generated role rules and schema section in the prompt list exactly the node/mark types from `shared/constants.ts`; a unit test fails if a type is added to constants without appearing in the prompt.
- [ ] AC-13.8 Inviting an agent into a document registers it in `authors` and the participant list; removing it leaves history intact and hides it from pickers.
- [ ] AC-13.9 Exporting a persona produces JSON without secrets; importing it creates a new agent with a fresh id and the same handle unless it collides (then prompts for a new handle).
- [ ] AC-13.10 Existing agents from `collabdoc.v1` are migrated once with their name/role/persona text; the migration is idempotent.

## Out of scope

Marketplace/sharing of personas; per-document agent overrides; agents with both roles at once.
