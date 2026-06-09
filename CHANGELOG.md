# Changelog

All notable changes to GMFT-AI are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [Semantic](https://semver.org/).

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

## [0.0.0] — 2026-06-08

### Added
- Repository initialized via `gh repo create ankurCES/gmft-ai --public --license MIT`.
- README, LICENSE, CHANGELOG, SECURITY placeholder, plan document.
