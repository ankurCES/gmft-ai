# Changelog

All notable changes to GMFT-AI are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [Semantic](https://semver.org/).

## [0.1.0-phase1.5d] — 2026-06-13

LLM streaming into the TUI. No tools, no slash commands, no session
persistence (those are 1.5e). Builds on 1.5c's TUI; the TUI itself
is unchanged. v0.1 has no chokepoint — `runTurn` is a single
`streamText` call with `maxSteps: 1`.

### Added
- `createModel({provider, model, apiKey, endpoint?})` in
  `@gmft/core` → returns a Vercel AI SDK `LanguageModelV1` handle
  for the 5 supported providers. OpenRouter/Ollama route through
  `@ai-sdk/openai` with `compatibility: 'compatible'` (sidesteps
  the V1/V2 version skew between `@ai-sdk/openai-compatible@1.0`
  and `ai@4.3.19`)
- `buildSystemPrompt('agent' | 'summarizer', env)` — pinned safety
  text + environment metadata. The agent prompt embeds the
  "authorized testing only" + "STOP and ask" rules verbatim
- `runTurn({model, system, history, signal?})` →
  `AsyncIterable<AgentEvent>` where `AgentEvent` is
  `text-delta | done | error`. Wraps `streamText`; ignores all
  chunk types except `text-delta` and `error`. Pre-aborted signal
  is honored at the next event boundary
- `ChatMessage` + `tokenEstimate(text)` + `totalTokens(messages)` —
  v0.1 uses chars/4 with +4 overhead per message. Phase 2 swaps for
  tiktoken
- `summarizeIfNeeded({history, budget, generateSummary?})` — drops
  oldest messages until under budget. Optional `generateSummary`
  callback prepends a synthetic system message summarizing the
  dropped chunk (LLM call lands in phase 2)
- `useAgent({system, runTurn, initialHistory?, onError?})` hook in
  `apps/gmft` — owns conversation state, exposes `submit` /
  `abort` / `history` / `streaming` / `error`. The seam for slash
  commands (1.5e) and the tool-calling loop (phase 3)
- `AgentApp` — thin wrapper around `App` that supplies the real
  `onSubmit`. The TUI itself is unaware of the LLM, which keeps
  `app-e2e.test.tsx` working with a stub `onSubmit`

### Changed
- `cli.tsx` now renders `AgentApp` and looks up the API key from
  the `SecretStore` after onboarding. Tolerates keytar probe
  failures and missing `os.hostname()` / `os.userInfo().username`
  (sandbox envs)
- Bumped `@gmft/core` `VERSION` to `0.1.0-phase1.5d`

### Test count
- 22 new tests (7 in `model-factory.test.ts` + `prompts.test.ts`,
  13 in `agent-loop.test.ts` + `context.test.ts` +
  `summarizer.test.ts`, 2 in `useAgent.test.tsx`)
- Workspace total: 1 + 57 + 39 = **97** (was 75)
- All green; `pnpm -r test` runs in <2s; `pnpm -r build` clean;
  `pnpm -r typecheck` clean

## [0.1.0-phase1.5b] — 2026-06-09

Provider modules, onboard driver, session log. Builds on 1.5a's
`ConfigField` registry. UI binding is 1.5c; this plan ships only
data, types, and a headless driver.

### Added
- `ProviderModule` interface (replaces the 1.5a stub) with real
  `AuthField`, `ModelInfo`, `ValidationResult` types
- 5 provider modules: `anthropic`, `openai`, `google`, `openrouter`,
  `ollama`. Each does a real 1-token HTTP probe via `validate()` —
  no stubs, no fake responses. Probes use `undici.fetch` (respects
  `setGlobalDispatcher` for test mocking) and have a 5s timeout
  (3s for Ollama)
- `PROVIDERS` tuple (frozen, stable order) + `getProvider(id)`
- `createLlmProviderField(ui)` factory — takes a `ProviderUI`
  adapter, returns a `ConfigField`. UI binding is 1.5c; this is
  the seam
- `runOnboarding({ fields, runtimeFactory, save, force? })` driver
  in `@gmft/core` — walks the registered fields, merges returned
  partial configs, calls `save` once. Returns `null` on user abort
- `session/log.ts` — `appendTurn` / `readLog` / `redactSecrets` in
  `@gmft/core`. JSONL format, one line per turn, partial-write
  crash loses at most one turn. `redactSecrets` is conservative
  string-level redaction (Authorization headers, apiKey=, provider
  key prefixes)
- Dev dependency on `undici@^6` for `MockAgent` in tests

### Fixed
- `secrets.compositeKey` now preserves inner-key case (was uppercase
  before) — no more `apiKey` / `apikey` collision. Backward-incompatible
  for anyone who has secrets stored under the uppercase form, but
  1.5a shipped 1.5 days ago and no real users exist yet. Env-file
  line parser regex updated to accept mixed-case keys.

### Tests
+20 new `it()` cases across 4 new test files (providers, onboard,
session-log) + 1 new case in secrets. Phase 1.5b running total:
39 → 59.

## [0.1.0-phase1.5a] — 2026-06-09

ConfigLayer. The data layer Phase 1.5b (providers + onboard driver) and
1.5c (UI + cli wiring) will build on.

### Added
- **`ConfigField` plugin registry** in `@gmft/core`
  (`registerConfigField`, `getConfigFields`, `_clearConfigFields`).
  Future phases can register their own config fields; the onboarding
  driver picks them up automatically. Documented extension point in
  `packages/core/src/config/registry.ts`.
- **`OnboardRuntime` interface** — `{ getSecret, setSecret,
  validateProvider, providers }`. The shape fields 1.5b will need
  (provider-module list, validation callback) is declared now so 1.5b
  is purely additive.
- **TOML config loader/saver** at `$XDG_CONFIG_HOME/gmft/config.toml`
  (default `~/.config/gmft/config.toml`). `loadConfig()` returns
  defaults when the file is missing; `saveConfig()` writes the file
  (no atomic-rename yet — see code TODO). Forward-compat: unknown
  top-level sections are preserved across round-trips via the
  `[k: string]: unknown` index signature.
- **`SecretStore` interface** with two implementations:
  - `KeytarStore` (preferred; OS keyring via `keytar` 7.9)
  - `EnvFileStore` (fallback; `~/.config/gmft/secrets.env` mode 0600,
    shell-sourceable `KEY=VALUE` format)
- **`createSecretStore({ service })` factory** with load-time probe
  that silently falls back to `EnvFileStore` when keytar fails to
  load. TODO: when honoring `secrets.backend` from `config.toml`, accept
  an explicit preference and re-throw on probe failure when the user
  explicitly chose `keytar`.

### Stub
- `packages/core/src/llm/providers/types.ts` — minimal `ProviderModule`
  type. Replaced in 1.5b with the full shape (id, displayName,
  authFields, defaultEndpoint?, modelCatalog, validate).

### Tests
+7 new `it()` cases across 3 new test files (registry, config, secrets).
Phase 1.5a running total: 23 → 30. (Plan said 6; added an XDG-unset
fallback test for `configDir()` per code-review recommendation.)

## [0.1.0-phase1] — 2026-06-08

Phase 1 of the v0.1 plan ships: the TUI scaffold, theming, tab system,
input handling, and CI. No LLM, no tools, no onboarding yet — those
arrive in phase 2 / phase 1.5a-1.5h.

### Added
- **`App` 3-tab layout** (Chat / Findings / Help) with a `TabBar` indicator.
  `Tab` and `Shift-Tab` cycle tabs; the hint line is always visible
  (`apps/gmft/src/App.tsx`, `src/ui/components/TabBar.tsx`,
  `src/ui/tabs/{Chat,Findings,Help}Tab.tsx`).
- **`FindingsTab`** — phase-1 placeholder. Shows the count of any pre-existing
  findings the caller injected via `initialStatus.findings` and a clear
  "No findings yet" line. Real findings land in phase 2.
- **`HelpTab`** — static reference card (keybindings, slash commands, status).
- **Clean Ctrl-C exit** — App-level `useInput` calls `useApp().exit()` and an
  optional `onExit` prop (used by tests).
- **GitHub Actions CI** (`.github/workflows/ci.yml`) — matrix on Node 20 + 22,
  `pnpm install --frozen-lockfile && pnpm -r build && pnpm -r test`. Concurrent
  in-flight runs of the same ref are cancelled.

### Fixed
- **`theme.ts` typecheck errors** — `chalk.Chalk` is not a namespace in chalk
  v5; switched to the named export `ChalkInstance`. `chalk.supportsColor` is
  also a named export now.

### Tests
- `test/app-e2e.test.tsx` (9 tests): slash commands, onSubmit hook, stub echo,
  history ↑ recall, **Tab cycling**, **Shift-Tab cycling**, **Ctrl-C exit**.
- `test/InputBox.test.tsx` (5 tests): render, onSubmit, whitespace trim,
  history ↑/↓, `disabled` state.
- `test/smoke.test.tsx` (4 tests): banner, welcome, status rail, override.
- `test/theme.test.tsx` (3 tests).
- **Running total: 23 tests across 4 packages, 0 fail.**

### Done-when check (from plan §1, phase 1 acceptance criteria)
- [x] `pnpm install && pnpm -r build && pnpm -r test` is green.
- [x] TUI renders the banner, status rail, chat tab, and input box.
- [x] User can type into the input box, press Enter, see a user/assistant
  message pair in the transcript.
- [x] `/help` and `/clear` slash commands work.
- [x] Tab cycles between Chat / Findings / Help; Shift-Tab cycles backward.
- [x] Ctrl-C exits cleanly (process exits, no leftover process).
- [x] CI runs on Node 20 and 22.

### Out of scope (deferred)
- LLM streaming + ReAct loop (phase 2).
- Chokepoint + tool registry (phase 3).
- Onboarding flow with `keytar` (phase 1.5a-1.5h, added by amendment).
- Real findings content (phase 2 onwards).

## [Unreleased]

### Planning
- Full v0.1 plan written: [`docs/plans/2026-06-08-gmft-ai-v0.1.md`](docs/plans/2026-06-08-gmft-ai-v0.1.md).
  6 phases, 12 weeks, ~50 tests. Awaiting execution.
- **Decisions locked 2026-06-08**:
  - **Provider set in v0.1**: Anthropic, OpenAI, Google, OpenRouter, Ollama (local).
    Curated, picked from a TUI screen on first launch.
    Design: [ADR-0005](docs/plans/adr/0005-onboarding-and-model-selector.md).
  - **wifi_evil_twin** is in v0.1, behind the maximum-friction gate
    (`requiresElevation` + `destructive` + typed `attack` confirm + `GMFT_ALLOW_ELEVATION=true`).
  - **License**: MIT.
  - **Name**: `gmft-ai` (Good-Made-for-the-World AI).
  - **Tool catalog**: curated to 12 in v0.1, 22 in v0.2, 60+ in v0.3.
- **Phase 1 amended** to include the first-run onboarding flow (originally in
  phase 2; pulled forward — see plan §11). Adds tasks 1.5a-1.5h and +4 tests.
  Phase 1 test total: 5 → 9. v0.1 test total: 50 → 54.

## [0.1.0-phase1.5e] — 2026-06-10

Slash commands + JSONL session persistence. App is now a controlled
component; AgentApp owns chat state and the slash dispatcher. Builds
on 1.5d's streaming LLM hook.

### Added
- `App` is a **controlled component** — it takes `messages` and
  `onMessagesChange` as props. The TUI is unaware of the LLM or
  sessions; it just renders. `AgentApp` (in `apps/gmft/src/AgentApp.tsx`)
  wires `messages` + `dispatchSlash` into `App.onSubmit`.
- `SessionStore` (`apps/gmft/src/session/store.ts`) — JSONL-backed
  session log + current-session pointer. Methods: `start`, `setCurrent`,
  `append`, `load`, `current`, `list`, `currentId`, `clear`,
  `pathFor`. `SessionStore.noop()` returns a `NoopSessionStore` that
  touches no filesystem (used by AgentApp when no session is provided,
  e.g. tests).
- `PreviewTurn` type — `Turn` + optional `ts` + optional `id`. The
  store's `load()` / `current()` hydrate `ts` from `meta.ts` first,
  then a top-level `ts` (so `ChatMessage`-shaped writes round-trip),
  then the file mtime. `id` is the 1-based line number.
- **Slash commands** (handled by `dispatchSlash` in
  `apps/gmft/src/session/commands.ts`):
  - `/help` — show commands list
  - `/clear` — clear chat messages
  - `/model <id>` — switch model in-memory (no LLM call, no persist)
  - `/provider <id>` — switch provider in-memory; clears model
  - `/session new [id]` — start a new session, set current pointer
  - `/session list` — list sessions (id, turn count, mtime, current)
  - `/session load <id>` — load a session, replace chat messages
  - `/session clear` — clear current pointer (logs kept on disk)
  - `/resume` — alias for `/session load current`
  - `/exit` — exit the TUI
- `cli.tsx` now creates a `SessionStore`, resumes the previous
  conversation on startup (via `currentId()` + `load()` →
  `initialMessages`), and persists every LLM turn via
  `onTurnComplete`. Resume failures are logged but non-fatal.

### Changed
- `AgentApp` accepts `session?`, `initialMessages?`, `onTurnComplete?`,
  `onExit?`. When `session` is omitted, slash commands that need
  persistence return a "no current session" reply; the LLM turns
  are not persisted.

### Tests
- 73 passing in `apps/gmft` (up from 41 in 1.5d). New:
  - 12 `SessionStore` tests (round-trip, list ordering, noop,
    missing-file, current pointer races, etc.)
  - 2 hydrator tests (`meta.ts`, top-level `ts`)
  - 20 slash-command tests (every command + edge cases)
- Total workspace: **138 tests** (64 core + 73 apps/gmft + 1 testkit).

## [0.0.0] — 2026-06-08

### Added
- Repository initialized via `gh repo create ankurCES/gmft-ai --public --license MIT`.
- README, LICENSE, CHANGELOG, SECURITY placeholder, plan document.
