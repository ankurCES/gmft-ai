# ADR-0005: Terminal-first onboarding + in-TUI model selector

**Status**: Accepted (2026-06-08)
**Phase**: Lands in **Phase 1** (onboarding flow) and **Phase 2** (model selector UI)

## Context

GMFT-AI's first-run experience is critical. The user is a pentester who already
runs 12 different CLIs; we cannot ask them to read a `README` to find an
`OPENAI_API_KEY` line and a model id. We also cannot ship with a hard-coded
default — different users have different providers, and a TUI that hides the
provider choice is a TUI that doesn't survive first contact with reality.

xalgorix uses `~/.xalgorix.env` with `XALGORIX_LLM=<provider>/<model>` and
`XALGORIX_API_KEY=...`. That works but is text-only, with no validation, no
discovery, and no model selection. PentAGI ships a web UI for configuration,
which is overkill for a terminal-first tool.

We need an onboarding flow that:

1. Works **entirely in the terminal** (no web UI, no `vim`).
2. Lets the user pick from a **curated list of leading providers** (we choose
   the list, not them — this is product taste).
3. **Validates the API key / endpoint** before saving (round-trip a cheap
   call like `models.list` or a 1-token completion).
4. After validation, shows a **model selector** in the TUI itself, so the
   user can switch models per-session without restarting.
5. Stores the config in the same `~/.config/gmft/config.toml` defined in
   ADR-0004, with secrets kept in the OS keyring when available, falling
   back to `~/.config/gmft/secrets.env` (mode 0600) otherwise.

## Decision

### Curated provider list (v0.1)

We ship with five providers, in this order on the picker screen:

| # | Provider | Auth | Endpoint | Models offered |
|---|---|---|---|---|
| 1 | **Anthropic** | `ANTHROPIC_API_KEY` | hard-coded | `claude-3-5-sonnet-latest`, `claude-3-5-haiku-latest`, `claude-3-opus-latest` |
| 2 | **OpenAI** | `OPENAI_API_KEY` | hard-coded | `gpt-4o`, `gpt-4o-mini`, `o1`, `o1-mini`, `gpt-4-turbo` |
| 3 | **Google** | `GOOGLE_API_KEY` | hard-coded | `gemini-2.0-flash-exp`, `gemini-1.5-pro`, `gemini-1.5-flash` |
| 4 | **OpenRouter** | `OPENROUTER_API_KEY` | hard-coded | user-pickable from their `/models` list (top 25 by usage) |
| 5 | **Ollama** (local) | none | `http://localhost:11434` (configurable) | `GET /api/tags` on first connect |

Each provider entry in `packages/core/src/llm/providers/<id>.ts` is a small
module exposing `{ id, displayName, authFields, defaultEndpoint?, modelCatalog, validate }`.

### Onboarding flow

Runs **on first launch** (no config file present) and **on demand** via
`gmft onboard` slash command or `--reconfigure` CLI flag.

```
┌─────────────────────────────────────────────────────────────────┐
│  GMFT-AI — first-time setup                                    │
│  (Subsequent launches skip this when ~/.config/gmft/config.toml│
│   is present and valid.)                                        │
└─────────────────────────────────────────────────────────────────┘
  Choose your LLM provider (↑/↓, Enter):

  ❯ 1. Anthropic     — Claude 3.5 Sonnet, Haiku, Opus
    2. OpenAI        — GPT-4o, o1, GPT-4 Turbo
    3. Google        — Gemini 2.0 Flash, 1.5 Pro/Flash
    4. OpenRouter    — any model, your key, single bill
    5. Ollama (local)— no key, runs on your box

  ↑/↓ to move · Enter to select · Esc to quit
```

After the user picks a provider:

```
┌─────────────────────────────────────────────────────────────────┐
│  Anthropic — API key                                            │
│  Get one at https://console.anthropic.com/                      │
│  (The key is validated by sending a 1-token test request.)      │
└─────────────────────────────────────────────────────────────────┘
  › sk-ant-…                                                        (masked after first char)
  Enter to submit · Esc to go back
```

While the key is being validated, the input shows a spinner. On success:

```
  ✔ Key accepted. Account tier: Build (1k req/min).
  Fetching model catalog…

  Choose your default model (↑/↓, Enter):

  ❯ claude-3-5-sonnet-latest  — best balance, recommended
    claude-3-5-haiku-latest   — fastest, cheapest
    claude-3-opus-latest      — strongest reasoning, slower
```

For Ollama, the same flow runs but the "API key" prompt is skipped; instead
the user is asked to confirm/edit the endpoint URL (default `http://localhost:11434`)
and a `GET /api/tags` is performed to populate the model list live.

For OpenRouter, the model catalog is fetched from `https://openrouter.ai/api/v1/models`
and the top 25 are shown (with search/filter if the list is long).

### In-TUI model selector (post-onboarding)

A new tab in the TUI, **Models**, lists all models for the active provider
and lets the user switch with Enter. The switch is in-memory; the next
`/model` slash command persists it to `config.toml`. (We don't auto-persist
on tab-switch because the user might just be browsing.)

The StatusRail always shows the current model in the form
`provider:model` (e.g. `anthropic:claude-3-5-sonnet-latest`).

### Secret storage

- **Preferred**: OS keyring via `keytar` (Linux libsecret, macOS Keychain,
  Windows Credential Manager).
- **Fallback**: `~/.config/gmft/secrets.env` with mode `0600`, owned by the
  user. The file is **never** read into the session log; `session/log.ts`
  redacts any line matching `(api[_-]?key|token|secret)\s*=\s*\S+`.

The onboarding flow picks the keyring first and falls back silently.

### Reconfiguration

- `gmft onboard` — re-runs the full flow.
- `--reconfigure` CLI flag — same.
- `gmft providers` slash command — lists the configured provider; press `r`
  to reconfigure, `s` to swap to a different provider without losing the old
  config.
- Multiple providers can be configured side by side (e.g. OpenAI for chat,
  Ollama for offline reads). The slash command `/provider <id>` switches.

## Rationale

1. **Curated, not open-ended.** The user picks from 5, not from 50. We own
   the choice because we own the testing, the docs, and the failure mode.
2. **Validation is non-negotiable.** Saving a key that doesn't work is the
   #1 source of "the tool is broken" tickets. A 1-token test request is
   cheap insurance.
3. **TUI model selector** is the feature that makes the user feel in
   control. Hexstrike-AI is the same agent regardless of model; we
   celebrate the model choice instead.
4. **Keyring-first** matches user expectation on macOS/Windows and
   `libsecret`-enabled Linux (the default on Ubuntu/Fedora). The file
   fallback is a graceful degrade, not a regression.
5. **Multi-provider** in v0.1 is barely more code than single-provider
   (the provider modules are <100 lines each) and unlocks the offline
   + online use case the user will hit on day 1.

## Trade-offs accepted

- **We add a runtime dep (`keytar`)** that uses native bindings. This is
  the *only* native dep in v0.1. If it fails to build on a user's
  machine, the fallback to `secrets.env` keeps the tool working. We log
  the build failure and the user can still authenticate.
- **The curated provider list is opinionated.** Adding a new provider is
  a 1-file PR (see `packages/core/src/llm/providers/<id>.ts`), and the
  config schema accepts any `openai-compatible` endpoint as a power-user
  escape hatch (no UI for it in v0.1; CLI flag only).
- **No automatic key rotation** in v0.1. If a key expires, the user runs
  `gmft onboard` again.
- **No per-tool model pinning** (e.g. "use Haiku for recon, Sonnet for
  reports"). That's a v0.2 feature; the system-prompt builder can do it
  via a config flag.

## Consequences

- `packages/core/src/llm/providers/{anthropic,openai,google,openrouter,ollama}.ts`
  — one file per provider, each ~80 lines.
- `packages/core/src/llm/onboard.ts` — the onboarding driver. Pure function
  on inputs (a TTY, a writable `ink` instance, a keyring handle). Testable
  with `ink-testing-library`.
- `apps/gmft/src/ui/components/ProviderPicker.tsx`,
  `ApiKeyPrompt.tsx`, `ModelSelector.tsx` — the three onboarding screens
  plus the in-TUI model tab.
- `apps/gmft/src/ui/tabs/ModelsTab.tsx` — the post-onboarding model tab.
- The session log never contains a raw key (regression test in
  `packages/core/test/session-log.test.ts`).
- New test: `packages/core/test/onboard.test.ts` — 5 provider validation
  flows against a `fake-key-server` test double.
- A new test count: +3 onboarding tests, +1 model-selector render test.

## Open follow-ups (not blocking v0.1)

- Power-user escape hatch: a TUI form to add a custom `openai-compatible`
  endpoint with name, base URL, model list. v0.2.
- Per-tool model pinning in `config.toml`. v0.2.
- Key rotation via OAuth (e.g. ChatGPT Pro login). Out of scope.
