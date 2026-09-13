# 11 · LLM provider configuration and secure key storage

**Phase:** 3 · **Depends on:** — · **Status:** not started

## Summary

Turn the provider form into a working provider registry that lives in the main process: OpenAI-compatible, Anthropic (native SDK), and custom/local (Ollama, LM Studio, vLLM). Keys are stored with Electron `safeStorage`, never reach the renderer after entry, and "Test connection" proves the setup before any agent runs. The Scope says selecting a provider at startup is optional — that stays true.

## Current state (collabdoc)

- `types.ts#LlmProvider { enabled, kind, label, endpoint, apiKey, model }`; `provider.enabled` is derived from a non-empty endpoint (a key is not required to be "enabled").
- `SettingsModal.tsx` presets: OpenAI `gpt-4.1`, Anthropic `claude-sonnet-4-5` (stale), custom `http://127.0.0.1:11434/v1`.
- `lib/persist.ts` writes the whole provider object, **including `apiKey`**, to `localStorage`.
- Nothing ever calls the endpoint. `aiReady()` is "endpoint non-empty OR an MCP marked connected".

## Reference (lorocollab)

- `server/azure.ts` — single Azure OpenAI config from env; `createAzureClient`. Illustrates the "server owns the key" rule but is otherwise not reusable.
- `.env.example` — the environment-variable shape; irrelevant for a desktop app.

## Review before adopting

- lorocollab hard-codes one provider (Azure) and reads it from env at startup. CollabDoc needs multiple named providers, editable at runtime, with a default; the runtime (12) must pick up changes without restart.
- Azure-specific `apiVersion`/`deployment` fields should be supported through the OpenAI-compatible kind (base URL + optional `api-version` query + `api-key` header), not a separate kind.
- Do not route Anthropic through an OpenAI-compatible shim: use the native Anthropic SDK via `@langchain/anthropic` so adaptive thinking, effort, and tool-use semantics are correct.

## Design

- Main: `src/main/providers/ProviderRegistry.ts` — `list()`, `upsert()`, `remove()`, `setDefault()`, `test(id)`, `createChatModel(id)` (returns a LangChain `BaseChatModel` for 12). Config in `userData/providers.json` **without secrets**; secrets in `userData/secrets.bin` encrypted with `safeStorage.encryptString` (fall back to a clear warning when `safeStorage.isEncryptionAvailable()` is false, e.g. some Linux setups without a keyring — still store, but show "keys are stored unencrypted on this system").
- Kinds and adapters:
  - `openai-compatible` → `@langchain/openai` `ChatOpenAI` with `configuration.baseURL`, optional extra headers/query (Azure).
  - `anthropic` → `@langchain/anthropic` `ChatAnthropic`; presets `claude-opus-5` (default), `claude-sonnet-5`, `claude-haiku-4-5`; adaptive thinking on; no `budget_tokens`.
  - `custom` → same as openai-compatible with no key required (Ollama/LM Studio); "Discover models" calls `GET /v1/models`.
- IPC: `providers:list/upsert/remove/test/setDefault/discoverModels`; the renderer never receives `apiKey` back — it receives `hasKey: true` and a masked suffix (`…a1b2`).
- Test connection: one tiny chat call (`"Reply with OK"`, `max_tokens: 8`) with a 15 s timeout; result shows latency, model id echoed by the server, and typed error (`auth`, `network`, `model_not_found`, `rate_limited`, `unknown`).
- Renderer `aiReady` becomes: default provider exists and last test succeeded **or** a backend from 17 is available. The start-screen card and topbar indicator read from main.
- Per-agent provider override (13) references providers by id.
- Startup prompt: on first launch after 01–06 ship, the start screen shows the existing "AI setup — optional" card; no modal blocks the user.

## Acceptance criteria

- [ ] AC-11.1 Adding an Anthropic provider with a valid key and clicking "Test" returns success with latency and model id; an invalid key returns a typed `auth` error message within 15 s; a wrong endpoint returns `network`.
- [ ] AC-11.2 The API key is not present in `localStorage`, `providers.json`, renderer memory after the form closes (checked via a Playwright `evaluate` on `window` and IndexedDB), or any IPC payload to the renderer; it exists only in `secrets.bin` (encrypted when `safeStorage` is available).
- [ ] AC-11.3 Existing users' keys persisted under `collabdoc.v1` are migrated into `safeStorage` on first launch and removed from `localStorage`; the migration is logged in Activity and idempotent.
- [ ] AC-11.4 Multiple providers can coexist with one default; the default is used by agents without a per-agent override; changing the default takes effect for the next agent turn without restart.
- [ ] AC-11.5 The Anthropic adapter sends requests through the native Anthropic SDK (assert `anthropic-version` header in a recorded request) with `thinking: { type: "adaptive" }` and no `budget_tokens`; the OpenAI-compatible adapter honours a custom base URL and extra headers (Azure `api-key`) in a recorded request.
- [ ] AC-11.6 "Discover models" against a local Ollama/LM Studio endpoint lists models from `/v1/models`; picking one fills the model field.
- [ ] AC-11.7 When `safeStorage.isEncryptionAvailable()` is false the settings tab shows a persistent warning and still allows saving; when it becomes available later the secret store is re-encrypted on next launch.
- [ ] AC-11.8 `aiReady` on the start screen and topbar reflects the actual test result: green only after a successful test (persisted `lastTestedAt` + `lastTestOk`), and turns grey if the provider is removed.
- [ ] AC-11.9 The stale preset `claude-sonnet-4-5` is gone; presets use `claude-opus-5` (default), `claude-sonnet-5`, `claude-haiku-4-5`, and `gpt-4.1` (or the current OpenAI default at implementation time — record the choice in the spec).
- [ ] AC-11.10 Removing a provider that agents reference shows which agents will fall back to the default and requires confirmation.

## Out of scope

Bedrock/Vertex/Foundry clients (can be added as kinds later); OAuth login flows; usage/cost tracking (19 can add token counts from responses).
