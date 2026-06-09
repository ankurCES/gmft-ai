# Changelog

All notable changes to GMFT-AI are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [Semantic](https://semver.org/).

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
