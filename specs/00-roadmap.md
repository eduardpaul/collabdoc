# CollabDoc — Feature Roadmap

Written 2026-09-13 against `collabdoc` commit `0875431` and `../lorocollab` (Sep 9 2026).

## 1. Where the app is today

| Area | State | Evidence |
| --- | --- | --- |
| Electron shell | **Done.** Electron 44, React 19, Vite, WSL/Windows launcher, sandbox + contextIsolation, single-instance lock | `src/main/index.ts`, `src/main/wsl.ts`, `scripts/run-electron-vite.mjs` |
| File I/O | **Basic.** Open/save Markdown via native dialogs, `# Title` header convention | `src/main/documents.ts`, `src/renderer/src/lib/files.ts` |
| UI scaffold | **Done (visual only).** Start screen, workspace (sidebar / editor / rail), settings modal with provider/MCP/agents tabs, share/join/unsaved dialogs, notice bar, activity feed | `src/renderer/src/screens/*`, `components/*` |
| Editor | **Placeholder.** A `<textarea>`; toolbar wraps Markdown syntax; "@ mention" and "Comment" buttons insert literal characters | `screens/Workspace.tsx` |
| CRDT / versioning | **Absent.** Content is a string in a React reducer | `state/AppState.tsx` |
| Sharing | **Mocked.** `toggle-share` fabricates a `CD-XXXXXX` code and a `https://<slug>.loca.lt` URL (localtunnel-style; superseded by the Hyperswarm decision in 08); join loads placeholder text | `state/AppState.tsx`, `lib/ids.ts` |
| LLM provider | **Form only.** Settings persisted; API key sits in plain `localStorage` under `collabdoc.v1`; nothing calls the endpoint | `lib/persist.ts`, `components/SettingsModal.tsx` |
| MCP | **Mocked.** `connectMcp` flips status to `connected` after 700 ms | `state/useSessionActions.ts` |
| Agents | **Mocked.** `askAgent` posts two activity rows 1.4 s apart | `state/useSessionActions.ts` |
| Tests | **None.** | — |

The UI vocabulary (Writer / Reviewer, invite into session, "AI ready", share code, activity attribution) already matches the Scope. The roadmap below makes each of those affordances real without redesigning the shell.

## 2. What we learn from lorocollab (and what we do not copy)

lorocollab is the same product idea implemented as **browser client + Node server**. It is a **proof of concept**: it proves the Loro + Tiptap + tool-driven-agent approach works, but it was written to demo, not to ship. Every piece we take from it goes through a review pass (see the "Review before adopting" section in each spec) covering at least:

- **Correctness under our constraints** — it assumes one document, one operator, one server process for the whole lifetime. CollabDoc opens/closes many documents, runs many sessions, and must survive the main process being the only authority.
- **Error handling** — POC paths that `console.warn` and continue must become typed results surfaced in the UI.
- **Naming and structure** — names like "Canvas", `SEED_*`, `HUB_ORIGIN`, hard-coded seed content, and the Azure-only config do not carry over.
- **Tests** — its vitest suites are a starting point, not proof; each ported module gets its tests re-read and extended for the multi-document, multi-session case.
- **Dependencies** — pin to current versions (§6) and drop anything voice/Azure/infographic specific.

The split we need is **Electron renderer + Electron main**, and the mapping of *responsibilities* is close to one-to-one:

| lorocollab | Role | CollabDoc target |
| --- | --- | --- |
| `src/core/*` (tree, locators, session, comments, history, hub, bootstrap) | Loro document model, agent tool surface, attribution | `src/core/*` — **port after review**; keep and extend its vitest suite |
| `src/shared/*` (types, constants, actors, ids, mentions, protocol) | Tool schemas, frame encoding, actor registry | `src/shared/*` — **port after review** (tool schemas are the contract agents see; wording matters) |
| `src/client/extensions/*`, `src/client/editor/*` | Tiptap 3 + `loro-prosemirror` glue, comments decorations, block ids, `@writer` mention | `src/renderer/src/editor/*` — **port after review**, re-skin toolbar to the existing UI kit |
| `src/client/components/HistoryPanel.tsx`, `SearchReplace.tsx`, `CommentCard.tsx`, `SelectionBar.tsx` | Panels | `src/renderer/src/components/*` — **rewrite against the existing UI kit**, using lorocollab for behaviour only |
| `src/server/index.ts` (ws hub, loopback/origin guard) | Sync authority + transport | **replace** → Electron main hosts `SyncHub`; renderer talks over `MessagePort`; peers over Hyperswarm (P2P, no ws server) |
| `src/server/runtime.ts` (reviewer/writer/apply scheduling, caps) | Agent orchestration | **re-implement** the scheduling rules (coalescing, sweep caps, backlog) in main; the class itself is too entangled with Azure and voice to keep |
| `src/server/llm-agent.ts` (Azure OpenAI tool loop) | LLM calls | **replace** → LangChain DeepAgents + provider abstraction + MCP backends |
| `src/voice/*`, `VoiceBar` | Azure Voice Live | **drop** (out of scope) |
| `infographic-figure.ts`, `mermaid-figure.ts` | Rich figures | **defer** — optional after 01 |

Two principles run through every spec. First, **agents are participants, not features**: a person and an agent open comment threads, reply, resolve, get mentioned and are attributed through the same model — what differs is only how they answer (a person reads a notification, an agent runs). lorocollab is agent-centric in places (comments and mentions exist only for agents there); the specs correct that rather than copy it. Second, carried over because it is the idea and not a shortcut: **agents never touch Loro/CRDT APIs**. They see block ids, text locators and a small tool set; the host resolves, validates, attributes and commits. Reviewers cannot mutate text. That is what makes "every AI modification strictly version-controlled and attributed" cheap to guarantee.

## 3. Target architecture

```
┌──────────────── Electron main (Node) ────────────────────────────┐
│  SyncHub (LoroDoc + EphemeralStore)   ← single source of truth   │
│  DocumentStore   (.collabdoc snapshots, autosave, recents)        │
│  AgentRuntime    (DeepAgents; one DocumentSession per agent)      │
│  ProviderRegistry(OpenAI-compatible / Anthropic / custom; safeStorage) │
│  McpHost         (server: document tools for Claude/Codex CLIs;   │
│                   client: knowledge MCPs for agents)              │
│  PeerHost        (Hyperswarm topic + join code; no listening port)│
└──────┬──────────────────────────────┬────────────────────────────┘
       │ MessagePort (binary frames)  │ Hyperswarm (Noise-encrypted UDP)
┌──────▼───────────┐          ┌───────▼──────────┐
│ Renderer (React) │          │ Peer CollabDoc   │
│ Tiptap 3 + Loro  │          │ (guest instance) │
│ client doc       │          └──────────────────┘
└──────────────────┘
```

The renderer is *a client* of main exactly as the browser is a client of lorocollab's server. Guests connect to the host's main process the same way, so the sync code path is identical for local and remote participants.

**Networking decision (2026-09-13):** the Scope named localtunnel; v1 uses **Hyperswarm** instead — direct, Noise-encrypted, keypair-authenticated P2P connections with DHT discovery, no relay we depend on and no listening port on the host. The trade-offs (native modules in Electron, public DHT bootstrap, hole-punch failures on strict NATs, no browser guests) and the mitigation plan are in [08](08-p2p-sharing-hyperswarm.md). `Scope.md` is updated to match.

## 4. Phases and features

Each feature is one file in this folder. "Depends on" is a hard ordering; everything else can be parallelised.

### Phase 1 — Editor and document core (local, single user)

| # | Feature | Depends on |
| --- | --- | --- |
| [01](01-tiptap-editor.md) | Tiptap rich-text editor replaces the textarea | — |
| [02](02-loro-document-core.md) | Loro document model + tool surface ported from lorocollab | — |
| [03](03-document-hub-in-main.md) | SyncHub in main, renderer synced over MessagePort | 01, 02 |
| [04](04-document-persistence.md) | `.collabdoc` snapshot format, autosave, Markdown import/export, recents | 03 |
| [05](05-history-and-attribution.md) | Per-actor change history, diffs, checkpoints, time-travel | 03 |
| [06](06-undo-redo.md) | Per-actor undo/redo via Loro UndoManager | 03 |

### Phase 2 — Collaboration

| # | Feature | Depends on |
| --- | --- | --- |
| [07](07-presence-and-identity.md) | Identity, presence, remote cursors, participant list | 03 |
| [08](08-p2p-sharing-hyperswarm.md) | Host/join a session peer-to-peer over Hyperswarm with a connection code | 03, 04, 07 |
| [09](09-comments-and-review.md) | Comment threads any participant (person or agent) opens, answers, resolves | 03, 07 |
| [10](10-mentions.md) | `@` mentions as requests to people (inbox) and agents (runs) | 01, 07, 09 |

### Phase 3 — AI participants

| # | Feature | Depends on |
| --- | --- | --- |
| [11](11-llm-provider-config.md) | Real provider configuration, secure key storage, connection test | — |
| [12](12-agent-runtime-deepagents.md) | Agent runtime in main on LangChain DeepAgents with document tools | 03, 11 |
| [13](13-agent-personas-and-skills.md) | Persona, skills, memory; agent roster management | 12 |
| [14](14-writer-agent-flows.md) | Writer: ask-to-draft, `@handle` instructions, selection rewrite | 10, 12, 13 |
| [15](15-reviewer-agent-flows.md) | Reviewer: idle-triggered review, comment-only, apply-on-accept | 09, 12, 13 |
| [16](16-collabdoc-mcp-server.md) | CollabDoc exposes an MCP server so local Claude / Codex can edit the open document | 03, 09 |
| [17](17-claude-codex-agent-backends.md) | Route an agent to a locally running Claude Code / Codex instead of an API key | 12, 16 |
| [18](18-mcp-knowledge-sources.md) | Agents consume external MCP servers (Microsoft Learn, local folders) | 12 |

### Phase 4 — Trust and quality

| # | Feature | Depends on |
| --- | --- | --- |
| [19](19-activity-feed.md) | Real, persisted, filterable activity feed | 05, 08, 12 |
| [20](20-security-hardening.md) | Secrets, P2P handshake auth, loopback MCP auth, IPC validation, agent limits | 08, 11, 16 |
| [21](21-testing-and-ci.md) | Vitest core suite, Playwright Electron e2e, CI | all |

## 5. Suggested delivery order

1. **01 → 02 → 03** together form the first milestone: the textarea is gone, typing produces attributed Loro ops, main owns the doc. Nothing user-visible changes beyond the editor, which is why it should go first.
2. **04, 05, 06** make it a trustworthy single-user editor (save, history, undo). Ship this as v0.2.
3. **11 → 12 → 13 → 14/15** gets a Writer and a Reviewer actually editing/commenting through an API key. v0.3.
4. **07 → 08** adds P2P sharing over Hyperswarm. It is independent of AI and can be built in parallel by a second person; start its native-module and NAT verification early because it is the main packaging risk. v0.4.
5. **09, 10** are needed by 14/15 but small; build them right after 03.
6. **16 → 17 → 18** deliver the MCP promises in the Scope. v0.5.
7. **19, 20, 21** run continuously; 20 has hard gates before any public build.

## 6. Versions to target (checked 2026-09-13)

`loro-crdt 1.16.1`, `loro-prosemirror 0.4.4`, `@tiptap/* 3.31.3`, `hyperswarm 4.17.1`, `hyperdht 6.34.0`, `sodium-native 5.1.0`, `udx-native 1.21.1`, `deepagents 1.13.4`, `@langchain/core 1.2.11`, `@langchain/langgraph 1.4.15`, `@langchain/openai 1.5.13`, `@langchain/anthropic 1.5.10`, `@langchain/mcp-adapters 1.1.4`, `@modelcontextprotocol/sdk 1.30.0`, `electron 44.3.0`, `electron-vite 5.0.0`, `vitest 5.0.0`.

## 7. Conventions used in the specs

- **AC-NN.x** — acceptance criterion, testable, phrased so a reviewer can say yes/no.
- **Reference** — the lorocollab files to read. Paths are relative to `../lorocollab/src`. Reference means *read and learn from*, never *copy as is*.
- **Review before adopting** — known POC shortcuts in the referenced code that must be resolved as part of the feature.
- **Out of scope** — explicitly deferred so the feature has an end.
