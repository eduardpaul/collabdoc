# 21 · Testing and CI

**Phase:** 4 · **Depends on:** all · **Status:** not started (no tests exist)

## Summary

Establish the test pyramid the other specs assume: vitest for `src/core`, `src/shared`, main-process modules and renderer logic; Playwright Electron tests for user flows including two-instance collaboration; mocked models and CLIs so AI flows run in CI without credentials; a GitHub Actions matrix for Linux/Windows/macOS.

## Current state (collabdoc)

- No test runner, no tests. `npm run build` runs typecheck only. `.playwright-cli/` logs show manual Playwright use.

## Reference (lorocollab)

- `vitest.config.ts`, and the suites under `core/*.test.ts`, `server/*.test.ts`, `shared/*.test.ts`, `client/editor/text-style-parity.test.ts`, `client/voice/mic-error.test.ts`.

## Review before adopting

- The suites test a single hub with seeded content; each ported test must be re-read for the empty-document, multi-document, and multi-session cases (02). Tests that assert on `SEED_*` ids are rewritten.
- `runtime.test.ts` mocks Azure by monkey-patching; replace with a `FakeChatModel` implementing LangChain's `BaseChatModel` that scripts tool calls, so 12–15 tests are deterministic.

## Design

- **Unit/integration (vitest 5)**: `src/core`, `src/shared` (Node + jsdom environments), `src/main/**` with Electron APIs mocked via a small `electron` stub, renderer reducers/selectors/editor extensions with jsdom + `@tiptap/core` headless editor.
- **Fakes**: `FakeChatModel` (scripted tool calls, observes `AbortSignal`), `FakeBackendCli` (17), `MemoryTransport` (03 in-page hub), `FakeTunnel` (08, in-process relay) so collaboration tests do not hit `loca.lt`.
- **E2E (Playwright `_electron`)**: launch `out/` build; flows: new/open/save/recover, editor basics, undo, history restore, comments, mention → fake writer, ask → fake reviewer, share/join with two app instances over `FakeTunnel`, MCP server with the MCP Inspector CLI, settings/provider test against a local mock server.
- **Perf checks**: typing latency (01), history incremental (05), presence bandwidth (07) as assertions with generous thresholds on CI.
- **CI**: GitHub Actions — `lint`, `typecheck`, `test:unit` on Linux; `test:e2e` on Linux (xvfb), Windows, macOS; `build:unpack` artefacts; `npm audit` (20); coverage upload; required checks on `main`.
- Scripts: `test`, `test:unit`, `test:e2e`, `test:watch`, `coverage`.

## Acceptance criteria

- [ ] AC-21.1 `npm test` runs unit + integration tests in under 60 s locally with no network and no credentials; `npm run test:e2e` runs the Playwright suite against a built app.
- [ ] AC-21.2 Coverage thresholds enforced: `src/core` + `src/shared` ≥ 85 % lines, `src/main` ≥ 70 %, renderer state/editor ≥ 70 %; CI fails below.
- [ ] AC-21.3 `FakeChatModel` supports scripted multi-step tool calls and abort; all AI-flow tests in 12–15 use it; a CI job proves the suite passes with `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` unset.
- [ ] AC-21.4 The two-instance collaboration e2e test (host + guest over `FakeTunnel`) runs on all three OSes and asserts convergence after concurrent typing.
- [ ] AC-21.5 A nightly opt-in job runs the real-network tests (localtunnel, Microsoft Learn MCP, real Claude Code CLI) and reports without blocking merges.
- [ ] AC-21.6 Every spec's ACs that say "unit test" or "Playwright test" have a corresponding test file referenced by AC id in a comment (a script lists ACs without tests and the count is tracked to zero over the roadmap).
- [ ] AC-21.7 CI produces unpacked builds for Linux/Windows/macOS as artefacts and runs the Fuses check (20).
- [ ] AC-21.8 Flaky-test policy: retries are 0 on unit tests, 1 on e2e; any test retried more than 3 times in a week is filed as an issue automatically (or at least listed in the CI summary).

## Out of scope

Release signing/notarisation; visual regression screenshots (can be added to e2e later).
