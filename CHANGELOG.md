# Changelog

All notable changes to GMFT-AI are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [Semantic](https://semver.org/).

## [0.2.0-A.3] — 2026-06-12

Final slice of v0.2.A (multi-agent supervisor). Ships the
end-of-turn postmortem (trigger 6), the session-log schema
migration (`schemaVersion: 1` → `2`), the TUI surface for fires
(StatusRail field, inline ⚠ markers, postmortem card), and
secret-redaction on supervisor field bodies. The A.1+A.2 work
landed the 3 rule engines and the `withSupervisor` wrapper.

### Added
- `packages/core/src/agent/supervisor-postmortem.ts` — fixed
  4-section LLM call (WHAT WE TRIED / LEARNED / MISSING / NEXT
  STEP). 10s timeout via `Promise.race` over `generateText`.
  Never throws — a failed/timed-out call returns the empty
  string and the card renders a placeholder. A turn with 0
  fires returns the "quiet turn" fallback without making an
  LLM call.
- `packages/core/src/agent/supervisor.ts` — `withSupervisor`
  now invokes the postmortem generator on `done` and `error`,
  yields a `supervisor-postmortem` event, and exposes
  `wrapped.lastFires()` / `wrapped.lastPostmortem()`.
- `packages/core/src/session/log.ts` — `SessionRecord` gains
  `schemaVersion: 1 | 2`; `TurnRecord` gains optional
  `supervisor?: SupervisorTurnRecord`. v0.1 logs load with
  `supervisor: undefined` and `schemaVersion: 1` (or absent);
  v0.2 writes `schemaVersion: 2` with the supervisor field.
  Secret redaction now scrubs `supervisor.fires[].quote` and
  `supervisor.postmortem`.
- `apps/gmft/src/ui/components/StatusRail.tsx` — Supervisor
  field with 3 states (quiet / fires / postmortem). The pure
  helper `renderSupervisorField` is the public seam tested
  directly; the JSX wrapper is exercised through app-e2e.
- `apps/gmft/src/ui/components/SupervisorFireMarker.tsx` —
  inline ⚠ marker line keyed on the fire's `targetEventId`.
  Maps the `kind` discriminant (loop-detected / overclaim /
  plan-issue) to a short `rule a/b/c` label. Optional
  `showTargetId` flag for debug builds.
- `apps/gmft/src/ui/components/SupervisorPostmortemCard.tsx` —
  collapsible postmortem card (cyan border, `(N fires)` label,
  visual `[+]`/`[-]` toggle). The keyboard handler for the
  toggle lives in `AgentApp.tsx`; the component itself only
  renders the current `collapsed` state. Empty body is
  handled with a `(no postmortem — generator error)` placeholder.

### Tests
- 22 new tests in A.3: 5 postmortem + 3 wrapper integration +
  5 schema migration (4 in `session-log.test.ts`, 1 in
  `session-store.test.ts` to keep the existing assertions
  consistent with the new field) + 3 StatusRail +
  3 SupervisorPostmortemCard + 3 SupervisorFireMarker.
- v0.2.0-A.3 total: 428 (374 baseline + 54 new across
  A.1+A.2+A.3). The 1-test delta vs the plan's "53" is the
  schema-migration regression test added to `session-store.test.ts`
  to cover the new `schemaVersion: 2` field.
- `pnpm -r test` green. `pnpm -r typecheck` green. `pnpm -r build` green.

### Plan deviations
The plan documented in `docs/superpowers/plans/2026-06-11-gmft-v0.2-A-supervisor.md`
contained 2 bugs/ambiguities that this slice corrected:
- Task 3.5's example `Transcript.tsx` doesn't exist in the v0.1
  app. Events stream into `AgentApp` and the supervisor-fire
  events were unrendered in v0.2.A.2. Shipped
  `SupervisorFireMarker` as the smallest renderable unit
  (one marker line per fire) and noted the AgentApp-level
  wiring (deciding which messages get a marker) as separate
  follow-up work.
- Task 3.5's example test referenced the wrong `SupervisorFire`
  shape (`rule: 'A' | 'B' | 'C'` with an `at: number` field).
  The actual type is a discriminated union on `kind`
  (loop-detected / overclaim / plan-issue) and has no
  top-level `rule` / `at` fields. The shipped test uses the
  real shape.

## [0.2.0-A.2] — 2026-06-12

Second slice of v0.2.A (multi-agent supervisor). Ships the
`withSupervisor` wrapper that observes the inner `runTurn`
`AsyncIterable<AgentEvent>`, runs the 3 rules from A.1, and injects
advice into the agent's `history` array as `role: 'user'` messages.
Wires the wrapper into `apps/gmft/src/AgentApp.tsx`. The postmortem
generator, TUI surface, and schema migration are in A.3.

### Added
- `packages/core/src/agent/supervisor.ts` — `withSupervisor({...})`
  wrapper. The 3 rules are run on every event; on a fire, the
  wrapper yields a `supervisor-fire` event AND mutates the
  caller's `historyRef` with a `role: 'user'` advice message
  (mirrors v0.1's `AgentApp` mutation pattern, but with immutable
  reassignment instead of in-place push). Resets all per-turn
  state on `done` and `error`. The `chokepointSessionTarget` is
  sticky across turns.
- `packages/core/src/agent/loop.ts` — `tool-call-request` event
  now carries an optional `flags` field (passes the registry-
  declared flags through). Two new `AgentEvent` variants:
  `supervisor-fire` (yielded by the wrapper) and
  `supervisor-postmortem` (declared now, yielded by the A.3
  generator). v0.1 tests unchanged.
- `packages/core/src/index.ts` — re-exports `withSupervisor` and
  the supervisor types from the public seam.
- `apps/gmft/src/AgentApp.tsx` — wraps the `runTurn` call site
  with `withSupervisor`. Introduces a `historyRef` so the
  supervisor's advice accumulates across turns (v0.1 passed
  `history: [userMsg]` as a fresh array, which would have lost
  the advice). The rest of the TUI is unchanged; the A.3 phase
  adds inline ⚠ markers and the StatusRail field.

### Tests
- 10 new tests in `supervisor.test.ts` (3 passthrough + 4 advice
  injection + 3 Rule B/C integration) + 1 integration smoke test
  in `apps/gmft/test/supervisor-integration.test.ts`.
- v0.2.A.2 total: 406 (395 + 11). `pnpm -r test` green.
- Typecheck clean.

### Plan deviations
The plan documented in `docs/superpowers/plans/2026-06-11-gmft-v0.2-A-supervisor.md`
contained 9 bugs/ambiguities that this slice corrected:
- Plan's test import paths (`./supervisor.js` etc.) were wrong for
  `packages/core/test/`; corrected to `../src/agent/...js`.
- `ChatMessage` lives in `context.ts`, not `chat-message.ts` (no
  such file exists).
- `distinctToolFamiliesThisTurn` was deleted in A.1's cleanup
  (commit `e740de3`); wrapper uses `createInitialState` instead
  of a hand-rolled literal.
- `Tool.flags` is `readonly string[]` — `tool?.flags` is truthy
  when empty, so the yield gates spread on `length > 0` instead.
- Public seam is `packages/core/src/index.ts`, not
  `packages/core/src/agent/index.ts` (no such file).
- `AgentApp` change required a `historyRef` design change (v0.1
  passed `[userMsg]` as a fresh array).
- The plan's tests in Tasks 2.2 and 2.3 expected exactly-1 fires
  in scenarios where Rule C.2 co-fires (3+ same-family tool
  calls); corrected to `>= 1` and to assert specific fire kinds.
- Rule C.1 test in plan had a recon tool first (nmap_scan IS
  recon); corrected to use a non-recon tool first.
- `historyRef.current` is immutable-reassigned, so test fixtures
  must read from `historyRef.current` not from the original local
  array variable.

## [0.2.0-A.1] — 2026-06-11

First slice of v0.2.A (multi-agent supervisor). Ships the rule engine
that observes the agent loop's `AsyncIterable<AgentEvent>` and fires on
plan quality (1), stuck/loop (2), and confidence calibration (4). The
wrapper, postmortem, TUI surface, and schema migration are in A.2 / A.3.

### Added
- `packages/core/src/agent/supervisor-types.ts` — `SupervisorFire`
  discriminated union (`loop-detected` | `overclaim` | `plan-issue`),
  `SupervisorState`, `SupervisorFireRecord` (Zod-validated,
  JSON-serializable), and the additive `supervisor-fire` /
  `supervisor-postmortem` `AgentEvent` variants.
- `packages/core/src/agent/supervisor-rules.ts` — pure rule engine:
  - **Rule A** (stuck/loop): same `(toolName, argsHash)` ≥4 times in
    the last 8 `tool-call-request` events. Fires with an
    alt-suggestion table keyed on tool family (`nmap_*`, `whois` /
    `dig`, `nuclei_*` / `nikto_*`, `http_get`).
  - **Rule B** (confidence calibration): 3 sub-rules — empty-findings
    claim, claim-without-evidence (within 2 tool calls of empty
    result), negative-result overconfidence (port not in scan range).
  - **Rule C** (plan quality): 3 sub-rules — no recon before
    destructive, 3+ calls to same tool family, `targetRequired` tool
    called without `--target` set.
  - Helpers: `applyFire`, `resetForNewTurn`.
- `packages/core/src/agent/loop.ts` — `tool-call-request` event
  grows an optional `flags` field (additive; v0.1 tests unchanged).

### Tests
- 21 new tests in `supervisor-rules.test.ts` (6 Rule A + 7 Rule B +
  6 Rule C + 2 helpers).
- Workspace total: 395 (374 + 21). `pnpm -r test` green.
- Typecheck clean (`pnpm -C packages/core run typecheck`).

## [0.1.0] — 2026-06-17

The v0.1 release. Shipped across 6 phases + 9 amendments; the polish
branch (`v0.1.0-polish`) lands the final 7 tasks from
[`docs/plans/2026-06-08-gmft-ai-v0.1.md`](docs/plans/2026-06-08-gmft-ai-v0.1.md)
§11 (phases 6.1, 6.2, 6.3, 6.5, 6.6, 6.7, 6.9, 6.10, 6.11, 6.12, 6.13,
6.14, 6.15). Phase 6's feature work (A. attack-chain, B. report +
findings, C. more wifi, D. scope file) shipped earlier on
[`phase6`](https://github.com/ankurCES/gmft-ai/tree/phase6).

### Added (polish delta)

- **CLI `--target <host>`** flag — pins the whole session to one host.
  The chokepoint denies any `targetRequired` tool call whose
  `args.target` doesn't match with a "scope mismatch" reason. The
  strongest session-binding gmft v0.1 offers. See
  [`docs/safety.md`](docs/safety.md) §2.
- **CLI `--resume <id>`** flag — loads a specific session by id and
  updates the current-session pointer so subsequent `gmft` runs
  start there. Falls back to the pointer with a warning if the
  requested id has no log.
- **`/report [md|json|pdf] [path]`** slash command — writes a
  report from the current session's findings sidecar. `pdf` also
  opens the file with `xdg-open` (or `open` on macOS, `start` on
  win32).
- **`report_write` JSON format** + `includeEvidence` flag — the
  `report_write` tool now emits markdown, JSON, or HTML. JSON is
  the canonical machine-readable form; the `includeEvidence: false`
  flag strips the per-finding evidence field for at-a-glance review.
- **`report_pdf` tool** — renders the current session's findings
  to a PDF using `@react-pdf/renderer`. Sibling to `report_write`,
  not a format flag on it (each renderer is single-purpose; the
  catalog lists both).
- **StatusRail severity sparkline** — the status rail's "findings"
  field is now a stacked bar of finding counts by severity
  (`info:█ low:██ medium:█ high:███ critical:█`), updated live
  from the agent loop's `tool-result` events. Empty tally renders
  as `(none)`. The pure render (`renderSeveritySparkline`) is
  exported for testability.
- **CI drift detector** — `scripts/check-tools.mjs` greps the
  catalog at build time and fails if a tool's name/category/flags
  drift from `docs/tool-catalog.md`. Wired into `.github/workflows/ci.yml`.
- **`docs/safety.md`** — full threat model: chokepoint rule order,
  what it does not catch, the operator switches and their risks,
  audit log shape, hardening checklist, the 9-row threat model
  table, the safety-bug reporting flow.
- **`docs/tool-catalog.md`** — per-tool operator reference: name,
  category, flags, input schema, output shape, prereqs for all 15
  tools. Includes a "what's not in v0.1" deferral list.
- **`CONTRIBUTING.md`** — the "one rule" is `pnpm -r test` must be
  green; the tool-add recipe (source + catalog entry + test);
  slash-command recipe; ADR convention; PR flow.
- **README rewrite** — mission, ⚠ legal, quickstart, the
  `--target scanme.nmap.org` safe-demo, the full CLI flag table,
  the slash-command table, the 15-tool quick reference, project
  layout, testing instructions, contributing pointer.

### Chokepoint delta (this branch)

- New `ChokepointEnv.sessionTarget?: string` field. Set by the
  CLI's `--target` flag; the chokepoint's `checkTarget` rule now
  compares `args.target` against it and denies on mismatch with a
  human-readable reason that names both the requested and the
  session target.
- `readChokepointEnv` accepts `sessionTarget?` and propagates it
  to the env object.
- 7 new chokepoint tests cover the new rule + the `readChokepointEnv`
  round-trip. The rule order is unchanged (still
  `elevation → typeToConfirm → destructive → target → allow`); the
  `checkTarget` function grew one new check at the end.

### Tests

- 374 tests green across 4 packages
  (1 testkit + 148 core + 106 tools + 119 gmft).
- Phase-6-polish delta: +5 chokepoint tests (session-target),
  +2 report-write tests (JSON, includeEvidence), +7 report-pdf
  tests, +9 slash-command tests, +8 StatusRail tests, +0
  App/AgentApp tests (the status-lift change is exercised through
  the existing slash + e2e tests).

### Changed

- `@gmft/tools` version `0.1.0-phase3` → `0.1.0` (was already
  `private: true`; the bump is cosmetic for the in-monorepo
  consumer).
- `App` is now a controlled component for `status` (in addition to
  `messages`); `AgentApp` owns the live status and updates it
  from the agent loop's `tool-result` events. Existing `App` tests
  continue to work because `internalStatus` is the default when
  no controlled `status` is passed.
- The `cli.tsx` `--target` help text expanded (no more "lands in
  phase 6" stub).

### Hardening notes

- The chokepoint's `sessionTarget` is a runtime-evaluated field;
  switching hosts in a running session is not possible by design
  (you'd need a fresh `gmft --target <other>`).
- `report_pdf` uses `@react-pdf/renderer` which runs in pure
  Node — no headless browser, no network, no font fetch. The
  font is bundled with `@react-pdf/renderer` itself.
- The CLI's PDF "open with xdg-open" step is best-effort; a
  failure to launch the OS handler does not fail the slash
  command (the file was written; the user can open it from the
  slash-reply path).

## [0.1.0-phase6] — 2026-06-17

Adds the web-app pentest and wifi-evil-twin tool families, a new
chokepoint `type-then-confirm` decision kind for high-friction tools
(`evil_twin`, future wifi deauth, …), and the `Dockerfile.web` image
for the 5 web tools. Focus: a single agent can now run a full
attack chain — recon → web → wifi — under a uniform chokepoint
gate, with the destructive tools demanding a literal typed
confirmation rather than a casual y/n.

### Added
- **5 web tools** in `packages/tools/src/web/`:
  - `nuclei_run` (template-driven scanner, JSONL output)
  - `nikto_scan` (web server scanner, JSON output)
  - `gobuster_dir` (directory/file bruteforce)
  - `ffuf_fuzz` (web fuzzer)
  - `sqlmap_inject` (SQLi detection/exploitation, JSON output)
  Each tool: Zod input/output schemas, `category: 'binary'`,
  `flags: ['destructive', 'targetRequired']`, `execFileNoShell`
  runner, stdout/stderr capture, exit-code propagation, shared
  `prereq` + `runner` + `stream` test helpers in
  `packages/tools/src/shared/`.
- **1 wifi tool**: `evil_twin` in `packages/tools/src/wifi/`. Drives
  `fluxion` (hostapd + dnsmasq + captive portal) inside a detached
  `tmux` session. `flags: ['destructive', 'requiresElevation']`,
  `typeToConfirm: 'attack'`. Dry-mode via `GMFT_DRY=1` (no actual
  process spawn, returns a synthetic log path).
- **Chokepoint `type-then-confirm`**: new `Decision` variant
  `{ kind: 'type-then-confirm', reason, prompt }`. Any tool that
  declares `Tool.typeToConfirm` fires this decision; the user must
  type the literal `prompt` (e.g. `attack`) and press Enter to
  approve. Aggregator order is
  `checkElevation → checkTypeToConfirm → checkDestructive →
  checkTarget → allow` so type-to-confirm beats plain destructive
  (a tool with both gets the stricter prompt).
- **`ApprovalPrompt` type-to-confirm mode**: when the
  `pendingApprovals[i].prompt` is set, the prompt switches from
  y/n to a literal-typing input. Backspace is supported. Esc
  denies. Rendered as `chokepoint type-to-confirm` (vs the plain
  `chokepoint confirm`) so the user can tell at a glance which
  mode they're in.
- **`Dockerfile.web`**: `docker/Dockerfile.web` builds an
  `alpine:3.20` image with nuclei, nikto, gobuster, ffuf, sqlmap
  preinstalled. Used by the web tools' `findBinary` shim when
  `GMFT_DOCKER=web` is set.
- **Tool catalog barrel**: `packages/tools/src/catalog.ts` exports
  the full ordered list of 11 tools (1 shell + 1 osint + 1 packets
  + 4 network + 5 web + 1 wifi). `packages/tools/src/index.ts`
  re-exports it under `ALL_TOOLS`.

### Tests
- 5 web tools × 3 cases each = 15 new tests
  (`packages/tools/test/web/*.test.ts`).
- 1 wifi tool × 4 cases = 4 new tests
  (`packages/tools/test/wifi/evil-twin.test.ts`).
- 4 chokepoint tests for the new `typeToConfirm` rule
  (`packages/core/test/chokepoint.test.ts`).
- 5 `ApprovalPrompt` tests for type-to-confirm mode
  (`apps/gmft/test/approval-prompt.test.tsx`): renders prompt
  literal, approves on exact match + Enter, denies on partial
  match + Enter, denies on Esc, supports backspace.
- 1 executor-test update for the new 2-arg `onConfirmation`
  signature (the agent loop's separate `onConfirmation` keeps its
  own signature, augmented with optional `prompt`).

### Changed
- `Tool<I,O>` interface in `packages/core/src/tools/types.ts`
  gains `typeToConfirm?: string` (forward-declared, all 6 prior
  tools leave it undefined so the chokepoint is unchanged for
  them).
- `ChokepointCall` carries `typeToConfirm`; `Decision` union grows
  the new variant.
- `executor.onConfirmation` now receives the `Decision` as a 2nd
  arg so the handler can dispatch on `kind` (and render the
  correct UI). The agent loop's `runTurn.onConfirmation` callback
  separately gains an optional `prompt` field; AgentApp wires it
  into `pendingApprovals`.
- `App` component's `pendingApprovals` shape grows the optional
  `prompt` field; `App.tsx` passes it through to `<ApprovalPrompt>`.

## [0.1.0-phase1.5h] — 2026-06-16

Completes the four items 1.5a-1.5g deferred from the phase 1
amendment. Focus: the secret store must not silently corrupt
its own state on a crash mid-write, and the user's chosen
`secrets.backend` from `config.toml` must be honoured by the
boot path (not just the LLM-call path).

### Fixed
- `EnvFileStore.writeAll` in `packages/core/src/config/secrets.ts`
  now opens the file itself with `openSync`, writes via
  `writeFileSync(fd, …)`, calls `fsyncSync(fd)` to force the
  page-cache flush before `chmodSync(0o600)`, and closes the fd
  in a `try/finally`. The previous `writeFileSync(p, …)` +
  `chmodSync` sequence could leave the file with the new
  permissions and the old content (or no content) after a crash
  because the kernel was free to reorder the inode update against
  the page-cache flush. Discovered in 1.5a code review; landed now.
- `createSecretStore` in `packages/core/src/config/secrets.ts`
  now accepts a `preferred?: SecretBackend` argument. The boot
  path in `apps/gmft/src/cli.tsx` passes `config.secrets?.backend`
  through so a user who explicitly chose `keytar` in config gets a
  visible error on keytar probe failure rather than a silent
  downgrade to envfile. The onboarding runtime (`onboard/runtime.ts`)
  intentionally still passes no `preferred` — at first run the
  user is *choosing* the backend, and there's no `config.toml`
  to read from yet. `lookupApiKey(provider, store?, preferred?)`
  in `packages/core/src/llm/api-key.ts` accepts the same option
  for callers that resolve the key without going through the CLI
  boot path.

### Tests
- `EnvFileStore.writeAll fsyncs the file before chmod` (1.5h) —
  mocks `fsyncSync` to throw, drives a write, asserts the
  rejection carries `simulated crash` and the on-disk file is
  never empty (it's either the pre-crash content or the
  fully-replaced post-crash content, never a torn mix)
- `KeytarStore.set rethrows keytar import errors as keytar-backend` (1.5h) —
  guards against the 1.5a regression where a missing libsecret
  binding silently fell through to envfile with no surface
  indicator of the downgrade
- `EnvFileStore.compositeKey roundtrips through the env file` (1.5h) —
  regression guard for the `${provider}.apiKey` ↔
  `provider_apiKey` env-var mapping. Without the explicit
  `compositeKey`/`decomposeKey` pair the roundtrip is lossy
  for keys with `-` in the provider name (e.g. `open-router`).

### Test totals
- Phase 1.5h delta: +3 tests (`secrets.test.ts`)
- Workspace: 233 tests passing (core 123, tools 26, apps/gmft 83, testkit 1)

## [0.1.0-phase3.5] — 2026-06-15

TUI chokepoint prompt + design doc delta. Builds on phase 3 by
wiring the new `pendingApprovals` stream into the TUI so the user
sees a prompt when the chokepoint emits a `confirmation` event.
No new tools, no new policies — purely the user-facing surface
for the spine that phase 3 shipped.

### Added
- `ApprovalPrompt` component in
  `apps/gmft/src/ui/components/ApprovalPrompt.tsx` — yellow-bordered
  Ink box that listens for `y` / `n` / `Esc`, renders tool name +
  summarised args + reason + a `(y/n)` hint. 5 tests cover
  visible state, approve (`y` and `Y`), deny (`n`), and Esc-deny
- `App` gains `pendingApprovals: PendingApproval[]` and
  `onApprovalResolve?: (id, approved) => void` props; when the
  array is non-empty, a row of prompts renders above the active
  tab so the user always sees a pending confirmation regardless
  of which tab they're on. When empty, the layout is identical
  to phase 3
- `AgentApp` constructs the `pendingApprovals` ref map, registers
  an `onConfirmation` callback against `runTurn` that creates an
  entry and resolves the runTurn promise, and threads the two
  new props through to `App`
- ADRs:
  - `0006-chokepoint-first-tool-dispatch.md` — why every tool
    call is funnelled through `@gmft/core`'s chokepoint
  - `0007-tools-as-a-separate-package.md` — why the catalog
    lives in `@gmft/tools`, not `@gmft/core`
  - `0008-sandbox-via-docker-with-host-fallback.md` —
    implementation of ADR-0003's policy as a `runInSandbox`
    helper with a `mode: 'docker' | 'host'` field on every
    result for auditability

### Test totals
- Phase 3.5 delta: +5 tests (`approval-prompt.test.tsx`)
- Workspace: 228 tests passing (core 119, tools 26, apps/gmft 83)

## [0.1.0-phase3] — 2026-06-15

The chokepoint + tools safety spine. This is the first release
where the agent can use tools at all. v0.1's `runTurn` was a
single `streamText` call with `maxSteps: 1`; phase 3 replaces
that with a hand-rolled dispatch loop that funnels every tool
call through a single audit point, gates each call against a
typed policy, and either allows, denies, confirms (with the
user), or mutates the call before execution. Tools live in a
new `@gmft/tools` package with a Docker-first runner and a
loud, explicit host fallback.

### Added
- `@gmft/core` — chokepoint:
  - `Chokepoint.evaluate(call, ctx)` → `Confirm | Allow | Deny |
    Mutate` decision
  - `Policy` — typed per-action rules (allow / deny / confirm)
  - `Decision` — user's yes / no / mutated response to a
    `Confirm`
  - 4 source files (`decision.ts`, `policy.ts`, `rules.ts`,
    `index.ts`), 23 tests
- `@gmft/core` — tools:
  - `Tool<I, O>` — Zod-typed tool interface (input + output)
  - `ToolRegistry` — register / list / lookup
  - `executeTools()` — runs approved calls and emits
    `tool-result` events
- `@gmft/core` — agent loop:
  - `runTurn` is now a hand-rolled dispatch loop
    (`packages/core/src/agent/loop.ts`) that calls
    `streamText` for one step at a time, inspects the
    `tool-call` chunks, routes each through the chokepoint,
    and feeds `tool-result`s back into the next step
  - New event types: `tool-call`, `tool-result`, `confirmation`,
    `approve`, `deny` (alongside the existing `text-delta`,
    `done`, `error`)
  - `wrapToolsForSDK` exports a typed helper for SDK consumers
- `@gmft/tools` — new package, version `0.1.0-phase3`:
  - `catalog()` — 5 default tools (`whois`, `dig`, `tshark_read`,
    `http_get`, `shell_exec`)
  - `runInSandbox({ tool, argv, cwd?, env?, timeoutMs? })` —
    Docker-first runner; falls back to host only when
    `GMFT_SANDBOX=host` is set or Docker is unavailable and the
    tool's `allowHostFallback: true` is set
  - `SandboxResult.mode: 'docker' | 'host'` — part of the audit
    event for traceability
  - `prereq.ts` — detects `docker`, `tshark`, `scapy` on the
    host (skipped in test env via `GMFT_SKIP_PREREQ=1`)
  - 26 tests across `prereq.test.ts`, `runner.test.ts`,
    `shell-exec.test.ts`
- `apps/gmft` — status rail shows the active sandbox mode and
  surfaces a persistent ⚠ banner when host fallback is in use
- Plan doc: `docs/superpowers/plans/2026-06-15-gmft-phase3-chokepoint-tools.md`

### Changed
- `runTurn`'s public surface is now an `AsyncIterable<AgentEvent>`
  over the new event union; `text-delta` and `done` are unchanged
  so the TUI's existing render path keeps working
- `package.json` versions: `@gmft/core` → `0.1.0-phase3`;
  `@gmft/tools` → `0.1.0-phase3`
- `pnpm-workspace.yaml` unchanged (workspace was already
  glob-`packages/*`)

### Test totals
- Phase 3 delta: +73 tests (core +73, tools +26, apps unchanged)
- Workspace: 223 tests passing at phase 3 (core 119, testkit 1,
  tools 26, apps/gmft 78)

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

## [0.1.0-phase1.5f] — 2026-06-14

Live model + provider switching. `/model <id>` and `/provider <id>`
now actually rebuild the `LanguageModel` the next LLM turn uses,
re-resolving the API key from the `SecretStore` for the new provider.
Picks a sensible default model when `/provider` is used without a
subsequent `/model`. Builds on 1.5e's in-memory status string (1.5e
updated the rail; it didn't touch the model).

### Added
- `lookupApiKey(provider, store?)` and `bindGetApiKey(store)` in
  `@gmft/core/llm/api-key.js` — provider-aware key resolver over
  `SecretStore`. The contract is `${provider}.apiKey`; missing keys
  and store errors both surface as `''` (the next `createModel` call
  turns it into a clean chat-visible error). `bindGetApiKey` is the
  recommended path for the CLI: it constructs the store once and
  reuses it for every swap.
- `getDefaultModel(provider)` in `@gmft/core/llm/model-catalog.js` —
  one model per provider (the fast/cheap tier): `claude-3-5-haiku-latest`
  / `gpt-4o-mini` / `gemini-1.5-flash` / `openai/gpt-4o-mini` /
  `llama3.2`. Returns `''` for unknown providers (case-sensitive on
  purpose — the factory's switch is exact-match too).
- `AgentApp` now takes `getApiKey: (provider) => Promise<string>` and
  (optionally) `endpoint`. A `useEffect` re-resolves the key when
  the active provider changes; `useMemo` rebuilds `llmModel` from
  `(activeProvider, activeModel, resolvedApiKey, endpoint)`. Unknown
  provider ids from the slash command are logged + no-op (the slash
  command already replied with the typo).
- `cli.tsx` constructs one `SecretStore` at boot and calls
  `bindGetApiKey(store)` once; the resulting closure flows into
  `AgentApp.getApiKey`. The initial `apiKey` lookup is unchanged.

### Changed
- `/provider <id>` reply no longer says "model cleared"; it now says
  "default model selected — /model <id> to override" because that's
  what happens. The slash dispatcher is still pure (it still emits
  `{provider, model: ''}`); the default-model fill is AgentApp's job.
- `AgentApp` `useState<string>(model.provider)` →
  `useState<LlmConfig['provider']>(model.provider)` so the type system
  catches future regressions in `setActiveProvider`.

### Tests
- 7 new `lookupApiKey` / `bindGetApiKey` tests (happy path, missing
  key, store throws, `${provider}.apiKey` contract guard, closure
  delegation, keytar hiccup tolerance)
- 2 new `getDefaultModel` tests (every known provider + the
  unknown-provider fallback)
- 4 new AgentApp e2e tests (live model switch, live provider switch,
  model-only key retention, unknown-provider no-op)
- 1 new slash-command test (`/provider` reply mentions the new
  default-model behavior)
- Workspace total: **152 tests** (73 core + 78 apps/gmft + 1 testkit)

## [0.1.0-phase1.5g] — 2026-06-14

Write-time secret redaction. A user pasting an API key, a bearer
token, or a `{"apiKey": "..."}` config snippet into chat must never
land on disk in the JSONL session log. v0.1 plan §10 line 572 calls
this out: "scrubs `(api[_-]?key|token|secret)\s*=\s*\S+` patterns.
Apply at write time."

### Added
- `redactSecrets(line)` extended to cover JSON-shaped secrets
  (`"apiKey": "..."`, `"api_key": "..."`, `"token": "..."`,
  `"secret": "..."`) and a bare `sk-` provider prefix (OpenAI
  keys, gated on 20+ chars to avoid English-word false positives).
  The header, env, `sk-ant-`, `sk-or-`, and `AIza` patterns from
  1.5d are unchanged.
- `appendTurn(path, turn)` now runs `redactSecrets` on the
  serialized line before `appendFile`. A user pasting
  `sk-ant-1234567890abcdef` into chat is rewritten to
  `[REDACTED]` on disk; `readLog` returns the redacted form too.
  This is intentional — the alternative is keeping secrets on disk.
- `appendTurnRaw(path, turn)` — sibling that bypasses redaction.
  Escape hatch for tests and trusted internal paths. Not used by
  the production write path; not re-exported from
  `@gmft/core/index.ts`.

### Tests
- 4 new `appendTurn` regression tests: env-style
  (`apiKey=sk-...`), JSON-style (`"apiKey": "sk-..."`),
  header-style (`Authorization: Bearer sk-...`), and
  round-trip-safety (benign text passes through unchanged).
- 1 new `appendTurnRaw` boundary test (the secret IS on disk
  when redaction is bypassed — proves the safety net lives in
  `appendTurn`, not in the writer).
- Workspace total: **157 tests** (78 core + 78 apps/gmft + 1 testkit)

### Migration
- Pre-1.5g session logs that contain raw user-pasted secrets are
  NOT scrubbed retroactively. Delete the affected `.jsonl` file
  under `~/.local/share/gmft/sessions/` (or whatever
  `SessionStore` reports as the sessions dir) if you want a clean
  start. v0.1 has no built-in session migration — it would have
  to parse every line and decide what's a secret, which is exactly
  the redaction problem we just solved for new writes.

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
