# Changelog

All notable changes to GMFT-AI are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [Semantic](https://semver.org/).

## [0.4.0-A.6] — 2026-06-19

**v0.4.0-A.6 — Wire `withAuditSupervisor` into AgentApp.** The
supervisor-audit wrapper has been exported from `@gmft/core`
since v0.4-A.3 with full unit-test coverage, but never reached
AgentApp. v0.4-B.5's audit-event wiring (`withAuditToolResult`)
made the gap obvious: the audit chain recorded tool-results and
chokepoint-decisions but silently dropped every `supervisor-fire`
event. This slice closes the loop. **962 tests green** (1 testkit
+ 310 core + 379 tools + 272 gmft). core went 308 → 310 (+2 new
tests in `audit-chain-integration.test.ts`). No breaking API
changes.

### Added
- **`withAuditSupervisor` wired into `AgentApp.tsx`.** The chain
  becomes `chokepoint → withAuditChokepoint → withSupervisor →
  withAuditSupervisor → withAuditToolResult`. The supervisor
  wrapper stays in `wrappedSupervisorRef` so the `/supervisor`
  slash command can still read `lastFires()` / `lastPostmortem()`
  off it (the audit decorator is a transparent iterable wrapper
  and does NOT add new methods to the supervisor, so it must
  stay out of the snapshot-ref path).
- **`audit-chain-integration.test.ts`** in `packages/core/test/`
  (2 tests): end-to-end composition proving both audit wrappers
  cooperate when piped together. Test 1 — a turn with a
  `tool-result` + a `supervisor-fire` produces BOTH audit events
  with the right payloads (`tool-result` with `redacted_fields`,
  `supervisor-fire` with kind + advice + targetEventId +
  kind-specific fields). Test 2 — the fire-and-forget semantics
  survive the chain: a sink that always rejects does not break
  the iterable drain.

### Removed
- **The "Known gap" section** in the v0.4.0-B.5 CHANGELOG entry
  and the v0.4-B.5 ADR-0018 amendment note. The supervisor-fire
  audit wiring is now closed.

## [0.4.0-B.5] — 2026-06-19

**v0.4.0-B.5 — Audit-event wiring for tool results.** Closes the
ADR-0018 §D.5 contract: the audit chain now records
`redacted_fields: AdRedactedField[]` on every `tool-result` event,
plus a stringified + AD-redacted `output_redacted` field so
post-session review can see exactly what the tool returned (with
hashes scrubbed). The `redactAdSecrets` library function from B.4
now has a production consumer. **960 tests green** (1 testkit +
308 core + 379 tools + 272 gmft). core went 304 → 308 (+4 new
tests for the wrapper). No breaking API changes.

### Added
- **`withAuditToolResult(inner, sink)`** in
  `packages/core/src/audit/instrument.ts`. Sibling of
  `withAuditSupervisor` — wraps an `AsyncIterable<AgentEvent>`,
  observes every `tool-result` event, and fires
  `sink.append('tool-result', payload)` fire-and-forget. The
  payload carries `name`, `ok`, optional `reason`,
  `redacted_fields: AdRedactedField[]`, and
  `output_redacted: string`. `output_redacted` is truncated to
  `MAX_TOOL_RESULT_OUTPUT_CHARS` (16 KB) at a UTF-16 code-unit
  boundary so a runaway tool can't fill the audit chain.
- **`auditLogRedactedFields(output)`** in
  `packages/core/src/transcript/redact-ad.ts`. The helper the
  B.4 doc comment promised but didn't yet export. Stringifies
  the tool's `unknown` output (substituting `''` for
  `undefined` so the audit payload stays valid JSON), runs
  `redactAdSecrets`, and returns `{ redactedOutput, redactedFields }`.
- **Wired into `AgentApp.tsx`.** The agent-loop chain becomes
  `chokepoint → withAuditChokepoint → withSupervisor →
  withAuditSupervisor → withAuditToolResult`. The audit-sink
  ref was already created for the chokepoint wrapper; the new
  wrapper reuses it.
- **`audit-tool-result.test.ts`** in `packages/core/test/` (4
  tests): one audit append per yielded tool-result; payload
  contains `redacted_fields` for secretsdump + kerberoast
  inputs; non-tool-result events pass through with zero audit
  appends; truncation kicks in for outputs > 16 KB.
- **`@gmft/core` re-exports**: `withAuditToolResult`,
  `MAX_TOOL_RESULT_OUTPUT_CHARS`, `auditLogRedactedFields`, and
  the `RedactedToolOutput` type. Downstream consumers can wrap
  any iterable of agent events with the same one-liner.

## [0.4.0-B.2] — 2026-06-19

**v0.4.0-B.2 — `redactAdSecrets` post-execution pass.** Adds a
sibling redaction pass to the existing `redactSecrets` (which
covers API keys, SSH keys, env-var-shaped secrets). The AD
pass covers material that lands in the session transcript JSONL
as a side effect of running the AD attack tools — NTLM hashes,
lsass NTHASH lines, kerberoast TGS hashes, asreproast AS-REP
hashes. Per
[ADR-0018](docs/plans/adr/0018-v0.4-b-ad-attack-gate.md) §D.5.
**956 tests green** (1 testkit + 304 core + 379 tools + 272 gmft).
core went 257 → 304 (+47 new tests for B.4: 13 redaction + 18
AD-scope + 13 DC + 3 chain-order). No breaking API changes.

### Added
- **`redactAdSecrets(text)`** in
  `packages/core/src/transcript/redact-ad.ts`. Sibling of
  `redactSecrets`. Matches the 4 AD-shaped credential patterns
  documented in ADR-0018 §D.5 (secretsdump SAM with empty-LM
  sentinel, secretsdump lsass NTHASH, kerberoast TGS, asreproast
  AS-REP, plus a generic SAM fallback for hosts with LM hashes
  recorded). Replacement tokens are verbose
  (`<redacted:ntlm-hash>` rather than `[REDACTED]`) so the
  operator can tell which shape was scrubbed when reading the
  log.
- **`appendTurn` now runs `redactAdSecrets` after `redactSecrets`**
  on the same serialized log line. Returns
  `{ redactedFields: AdRedactedField[] }` so the audit-event
  writer can record `redacted_fields: string[]` in the audit
  event payload (additive — non-AD events still have an empty
  array).
- **Two new test files** in `packages/core/test/`:
  - `transcript-redact-ad.test.ts` (13 tests) — each of the 5
    patterns matches the expected impacket output, multi-match
    dedup, idempotency on `redactedText`, composition with
    `redactSecrets` in `appendTurn`.
  - `chokepoint-rules-check-ad-scope.test.ts` (18 tests) — each
    of the 5 AD tools with `args.scope` or `cliScope: true` is
    denied; non-AD tools with `--scope` are not blocked; the
    category gate (not the tool name) is what fires the rule.
  - `chokepoint-rules-check-dc.test.ts` (13 tests) — DC match
    against the session's PDC is denied with the canonical
    reason; realmLookup=false skips the rule entirely; case-
    insensitive PDC match.
- **`chokepoint.test.ts` extended with 3 AD-order tests** (in
  the existing `describe('rule order (...)')` block). Asserts
  `checkAdScope` runs before `checkElevation`, `checkDomainController`
  runs before `checkElevation`, and `checkAdScope` runs before
  `checkDomainController` (the cheaper, more-actionable error
  wins when both could fire).

### Changed
- **ADR-0018 §D.5 amendment note:** the `report_pdf` tool in
  v0.4-B renders `Finding[]`, not transcript turns — there is
  no `renderTranscript` step in the current code. `redactAdSecrets`
  is exported from `packages/core/src/transcript/redact-ad.ts`
  (as the ADR specifies) and is wired into `appendTurn`. The
  future `renderTranscript` path will import the same function
  and run it on the in-memory `Turn[]` array, so the PDF output
  will stay consistent with the on-disk JSONL.

## [0.4.0-B.1] — 2026-06-19

**v0.4.0-B.1 — AD attack tools + chokepoint rule-order fix.** Ships
the first 5 AD attack tools under the new `category: 'ad'`, the
canonical chokepoint rule-order contract documented in
[ADR-0018](docs/plans/adr/0018-v0.4-b-ad-attack-gate.md) §D.4,
and the runtime plumbing for the `realm`-aware domain-controller
check. **909 tests green** (1 testkit + 257 core + 379 tools + 272
gmft). No breaking API changes for the existing 30 tools.

### Added
- **5 AD attack tools** (`category: 'ad'`, all 5 share
  `destructive` + `targetRequired` flags + `typeToConfirm: 'attack'`):
  - `psexec` — `impacket-psexec` remote shell via SMB
  - `wmiexec` — `impacket-wmiexec` remote shell via WMI
  - `secretsdump` — `impacket-secretsdump` SAM/NTDS.dit/LSA dump
  - `kerberoast` — `impacket-GetUserSPNs` TGS request in hashcat format
  - `asreproast` — `impacket-GetNPUsers` AS-REP request in hashcat format
  All 5 route through the new `gmft/ad:0.1` Docker image (impacket
  0.12.0, alpine:3.20). See [`docker/Dockerfile.ad`](docker/Dockerfile.ad).
- **New `ToolCategory` enum value: `'ad'`.** Additive per
  ADR-0018 §10.4 — does not replace or rename any existing
  category. The chokepoint's `checkAdScope` rule rejects AD tool
  calls when `--scope` is set; `checkDomainController` blocks the
  session's PDC when `GMFT_REALM_LOOKUP=true`.
- **`checkAdScope` rule.** `packages/core/src/chokepoint/rules.ts`
  denies any `category: 'ad'` call that has `args.scope` set OR
  was invoked with `--scope` on the CLI (carried in
  `call.cliScope`). Runs first in the chokepoint chain so the
  operator sees the category-level constraint before any baseline
  check.
- **`checkDomainController` rule.** When `GMFT_REALM_LOOKUP=true`,
  the chokepoint shells out to `realm list --name-only` (cached
  per-session via `PdcCache`) and rejects AD tool calls targeting
  the session's PDC. Opt-in because `realm list` requires a
  working Kerberos configuration that most workstations lack.
  Test seam: `GMFT_PDC_OVERRIDE` env var, or a fake `PdcCache`
  injected into `readChokepointEnv({ pdcCacheFactory })`.
- **`buildImpacketTarget` shared argv builder** in
  `packages/tools/src/ad/shared.ts`. All 5 tools share the
  canonical `<domain>/<user>:<auth>@<target>` shape so the
  chokepoint's `checkTarget` rule has one consistent shape to
  match on.

### Changed
- **Chokepoint aggregator rule order.** The pre-v0.4-B aggregator
  ran `checkTarget` first, breaking the canonical contract
  documented in [`rules.ts`](packages/core/src/chokepoint/rules.ts)
  (elevation → destructive → typeToConfirm → target → allow) and
  locked in by `chokepoint.test.ts` describe('rule order (...)').
  The new order is `checkAdScope` → `checkDomainController` →
  `checkElevation` → `checkTypeToConfirm` → `checkDestructive` →
  `checkTarget` → `checkRequiresSandbox` → allow. The two AD-category
  rules fire first so the operator sees category-level constraints
  before any baseline check; the four baseline rules keep their
  canonical order.
- **Tests for `chokepoint.decide()` were updated** to handle its
  new async signature (the `realm list` shell-out made the chain
  async). 22 test files in `packages/core/test/` +
  `apps/gmft/test/` updated; all 882 → 909 tests still green.

### Planned for later v0.4-B.x slices
- **CLI `--dc-ip` flag wiring** in `apps/gmft/src/cli.tsx`.
- **TUI surface** for the AD tools (slash command + tab in
  the gmft app).

## [0.4.0-A.1] — 2026-06-19

**v0.4.0-A.1 — Supervisor Rule E (risk-escalation).** First slice
of [the v0.4 plan](docs/plans/2026-06-18-gmft-ai-v0.4.md). Adds
the supervisor's Rule E, a new fire shape `risk-escalation` in
the `SupervisorFire` discriminated union, and the Zod schema
variant for the audit-log wire format. **863 tests green**
(1 testkit + 237 core + 352 tools + 273 gmft). No breaking API
changes; chokepoint semantics unchanged.

### Added
- **Rule E (risk-escalation).** Fires when a destructive tool
  is the **first** tool of the turn. This is a stricter gate than
  Rule C.1, which deliberately skips the first tool of the turn
  (see `supervisor-rules.ts:339`). The two rules are disjoint:
  - First tool of turn is destructive → C.1 silent, E fires
  - Non-recon/non-destructive tool came first, then a destructive
    tool → C.1 fires, E silent
  Wired into the supervisor wrapper as `A → E → C → B`. Rule E
  MUST run before Rule C, or its pre-call-counter gate reads the
  post-increment value and over-fires on 2nd+ destructive calls
  (test #2 in `supervisor-rules-rule-e.test.ts` pins this).
- **`RiskEscalationFire` type.** New `kind: 'risk-escalation'`
  variant on the `SupervisorFire` discriminated union, with
  fields `tool`, `firstToolOfTurn: true`, `advice`, `targetEventId`.
  The literal `firstToolOfTurn: true` flag is self-documenting in
  the audit-log wire format.
- **`SupervisorFireRecordSchema` Zod variant.** Audit-log readers
  accept the new shape; v0.3-C and earlier log files parse
  unchanged (they simply don't contain `risk-escalation` fires).

### Changed
- **`packages/core/src/agent/supervisor.ts` wrapper sequence.**
  Was `A → B → C`. Now `A → E → C → B`. Rule B's position is
  timing-irrelevant for tool-call-request events (B fires on
  text-delta); placing it last preserves existing test expectations
  and keeps the diff small.
- **Fire list.** Was `[rA.fire, rB.fire, rC.fire].filter(Boolean)`.
  Now `[rA.fire, rE.fire, rC.fire, rB.fire].filter(Boolean)`.
- **`apps/gmft/src/AgentApp.tsx` comment.** Lines 708-713
  previously claimed `chokepointSessionTarget: undefined` was
  safe because "Rule C.3 only consults this for the
  `targetRequired` flag, which no current tool uses." That was
  true but misleading. The corrected comment names the
  v0.4-A.x follow-up: wire the resolved `--target` value once
  a non-destructive `targetRequired` tool exists in the registry.

### Documented
- **[ADR-0014](docs/plans/adr/0014-v0.4-a-supervisor-completion.md).**
  The design record. Records the doubt-driven-development review
  of the original v0.4-A.1 proposal (14 findings, 6 concrete
  defects) and the reconciled design: Trigger 3 (overreach)
  deleted from v0.4-A scope because overreach is the chokepoint's
  job (its `checkTarget` rule already enforces target scope for
  destructive calls), and Trigger 5 (risk-escalation) reframed
  as Rule E. Read ADR-0014 §Decision for the full rationale.

### Migration notes
- No user-visible breaking changes from v0.3.0.
- The supervisor now produces a new fire shape (`risk-escalation`).
  Existing transcript readers, audit-log readers, and TUI rendering
  ignore the new shape gracefully — the audit-log schema parser
  accepts it, the TUI renders it as the generic ⚠ marker until a
  v0.4-A.4 follow-up adds a kind-specific icon.
- `chokepointSessionTarget` is still passed as `undefined` from
  `AgentApp` (no `targetRequired` tools in the registry). See
  ADR-0014 §Open follow-ups for the v0.4-A.x plan.


## [0.4.0-A.2] — 2026-06-19

**v0.4.0-A.2 — LLM judge for plan quality.** Adds an LLM-as-judge
path for Rule C (plan-issue) so the supervisor can produce
higher-quality advice than a hard-coded string lookup. The judge's
verdict is `'sufficient' | 'insufficient' | 'unclear'` and is
backed by a 10s timeout — a timeout is treated as `'sufficient'`
(never throws) so the supervisor's hot path is never blocked by
the judge. No breaking API changes from A.1.

### Added
- **`judgePlanQuality(plan, opts)`** in
  `packages/core/src/agent/supervisor-judge.ts`. Calls the
  supervisor's `modelId` (the `--supervisor-model` override, or
  the primary model as fallback) with a fixed 3-line judge prompt
  ("Is this plan sufficient to answer the user's request? Reply
  only with one of: sufficient / insufficient / unclear."). Returns
  `'sufficient' | 'insufficient' | 'unclear'`. Wrapped in
  `Promise.race` against a 10s `setTimeout`; the timeout branch
  returns `'sufficient'` so the caller never sees a hang. Never
  throws — a thrown LLM call is caught and returns `'unclear'`.
- **`PlanIssueFire.judgeVerdict?: 'sufficient' | 'insufficient' | 'unclear'`.**
  Audit-log readers and the TUI surface can show the judge's call
  alongside the rule's hard-coded advice so an operator can tell
  whether the rule fired because the model said "insufficient" or
  because the model was silent / timed out.
- **`supervisor-judge.test.ts`** (6 tests): the three verdicts
  parse correctly, the 10s timeout returns 'sufficient' without
  throwing, an LLM throw returns 'unclear' without bubbling, and
  the `judgeVerdict` field lands on `PlanIssueFire` when the
  supervisor uses the new path.

### Changed
- **Rule C integration.** `withSupervisor` now calls
  `judgePlanQuality` on every plan-issuable event before yielding
  the `PlanIssueFire`. The hard-coded advice text is replaced
  with the judge's verdict + a one-line summary. A `'sufficient'`
  verdict short-circuits the fire entirely (no `PlanIssueFire`
  yielded, the rule is a no-op). A `'unclear'` verdict falls
  back to the hard-coded advice. This keeps A.1's behavior
  observable when the LLM is silent or unavailable.
- **`SupervisorTurnRecordSchema`** gains an optional
  `judgeVerdict` field for audit-log compat. v0.4.0-A.1 logs
  parse unchanged (the field is `undefined` and the schema is
  additive).

### Documented
- **[ADR-0015](docs/plans/adr/0015-v0.4-a-supervisor-judge.md).**
  The design record. Documents why the judge is gated on the
  supervisor model (not the primary), why a 10s timeout is
  treated as `'sufficient'` (fail-open in the hot path, fail-loud
  in the audit log), and why the judge's verdict is recorded on
  the fire shape rather than as a separate event (the audit-log
  hash chain needs the rule-engine's emission to be atomic with
  the judge's verdict for the entry to be self-verifying).

### Migration notes
- No user-visible breaking changes from A.1.
- Sessions that don't pass `--supervisor-model` use the primary
  model for the judge call. Operators who set the flag for the
  A.3 postmortem will see the same model used for plan-quality
  judging (this is the documented behavior).
- The 10s judge timeout is on the `setTimeout`, not the LLM call
  itself. A hung HTTP request will still hold a connection for
  the upstream provider's own timeout (typically 30-60s); the
  judge wraps the call so the *supervisor's* hot path returns
  in 10s, not the call's transport-level timeout.

## [0.4.0-A.3] — 2026-06-19

**v0.4.0-A.3 — Supervisor fires land in the audit log.** Adds a
new audit event kind `supervisor-fire` and a new
`withAuditSupervisor` decorator that mirrors `withAuditChokepoint`
at the iterable layer. The audit chain now covers supervisor
decisions alongside chokepoint decisions, so an attacker who
compromises the session log can't hide supervisor fires from a
post-session review. No breaking API changes from A.2.

### Added
- **`AuditEventKind.supervisor-fire`.** New 8th event kind (the
  7 from v0.3-C were: `session-start`, `session-end`, `tool-call`,
  `tool-result`, `chokepoint-decision`, `runner-mode`, `onboard`).
  The audit CLI's `gmft audit log --kind supervisor-fire` filter
  now works for supervisor fires.
- **`withAuditSupervisor(inner, sink)`** in
  `packages/core/src/audit/instrument.ts`. Mirrors
  `withAuditChokepoint` at the iterable layer: wraps the
  `AsyncIterable<AgentEvent>` returned by `withSupervisor`,
  watches each yielded event for `type === 'supervisor-fire'`,
  and fires `sink.append('supervisor-fire', payload)`
  fire-and-forget. The inner iterable is unchanged
  (transformation-only, like the chokepoint wrapper).
- **`audit-supervisor.test.ts`** (3 tests): sink called with
  every supervisor fire, fire-and-forget semantics preserve
  event order, payload shape carries the fire's variant-specific
  fields (`tool` + `count` + `recent` for `loop-detected`, `quote`
  + `evidence` for `overclaim`, `severity` + `text` for
  `plan-issue`, `tool` + `firstToolOfTurn: true` for
  `risk-escalation`).

### Changed
- **`packages/core/src/audit/types.ts`** — `AuditEventKind` union
  widens to include `'supervisor-fire'`. The v0.3-C schema parser
  accepts the new kind; older audit readers ignore it gracefully.
- **`packages/core/src/index.ts`** — re-exports `withAuditSupervisor`
  so `AgentApp` can import it with one line.
- **Audit log volume.** Each supervisor fire now produces one
  audit row. Fires are rare in practice (rule-engine only fires
  on violations) so the volume increase is small. The chain HMAC
  is unchanged.

### Documented
- **[ADR-0016](docs/plans/adr/0016-v0.4-a-supervisor-audit.md).**
  The design record. Documents why the audit decorator is at the
  iterable layer (the supervisor is a transform over
  `AsyncIterable<AgentEvent>`, not an object with a `decide`
  method like the chokepoint), why the fire-and-forget pattern
  matches `withAuditChokepoint` (the agent loop yields
  `tool-call-request` synchronously off `runTurn`'s output, and
  blocking on the audit append would couple supervisor-fire
  latency to tool-call latency), and why the payload shape
  spreads the fire first then explicitly sets the truly common
  fields (variant-specific fields land at the top level).

### Migration notes
- No user-visible breaking changes from A.2.
- `gmft audit verify` continues to work on logs that predate A.3
  (the chain is forward-compatible — the parser accepts the new
  kind but doesn't require it).
- `gmft audit log` users can now add `--kind supervisor-fire` to
  filter for supervisor fires. Without the flag, the log output
  is unchanged (all kinds shown).

## [0.4.0-A.4] — 2026-06-19

**v0.4.0-A.4 — `/supervisor` slash command + tab-completion.**
Adds a `/supervisor` slash command that surfaces the supervisor's
`lastFires()` + `lastPostmortem()` for the most recent turn, with
three subcommands: default (both), `fires`, and `postmortem`. Also
adds `/supervisor` (and the pre-existing-but-omitted `/audit`) to
tab-completion. **882 tests green** (1 testkit + 257 core + 352
tools + 272 gmft). No breaking API changes from A.3.

### Added
- **`handleSupervisor` dispatcher branch** in
  `apps/gmft/src/session/commands.ts`. Reads
  `getSupervisorSnapshot()` from `SlashContext`, formats the
  snapshot via `formatSupervisorSnapshot`, and returns a `Msg`
  with the rendered text. Three subcommands:
  - `/supervisor` (default) — both fires + postmortem
  - `/supervisor fires` — fires list only
  - `/supervisor postmortem` — postmortem prose only
- **`SupervisorSnapshot` type + `getSupervisorSnapshot` callback**
  in `SlashContext`. The callback is wired into `AgentApp` via
  the new `wrappedSupervisorRef` (stores the wrapper after each
  turn so the slash-command ctx can read `lastFires()` /
  `lastPostmortem()` without re-running the turn).
- **`formatSupervisorSnapshot(snapshot)`** — pure formatter
  function. Layout: "Last turn: N fire(s)" + Fires list +
  "Postmortem (model: <modelUsed>):" + indented body. Suppresses
  the fires header when `fires=[]` AND a postmortem is present
  (so the postmortem-only subcommand renders only the prose).
  Surfaces `postmortemError` as `(postmortem generation failed:
  <error>)` so operators see *why* the prose didn't generate
  (LLM timeout, model 503, etc.). Exported for unit-testing
  and for reuse by any future `gmft supervisor` CLI subcommand.
- **`/supervisor` + `/audit` tab-completion.** Added both to
  `SLASH_COMMANDS` in `apps/gmft/src/session/tab-completion.ts`.
  `/supervisor` is new; `/audit` was a pre-existing omission
  caught during A.4 review.
- **`slash-commands.test.ts`** (7 new tests): all 3 subcommands
  render the right view, the not-wired case (no callback) returns
  the right reply, the no-snapshot-yet case (no turn completed)
  returns the right reply, the quiet-turn case (no fires, no
  postmortem) renders the right "quiet" line, and the
  postmortem-only subcommand suppresses the fires header.

### Changed
- **`apps/gmft/src/AgentApp.tsx`** — new `wrappedSupervisorRef`
  to expose the wrapper outside the submit closure, new
  `getSupervisorSnapshot` callback wired into `SlashContext`,
  imports for `SupervisorWrapper` + `SupervisorSnapshot`.
- **`apps/gmft/src/ui/components/SupervisorFireMarker.tsx`** —
  narrowed `severity` access for the `RiskEscalationFire` variant
  (A.1's `risk-escalation` union variant exposed a latent bug
  where the marker assumed `f.severity` was always present; now
  the marker uses the same `'severity' in f` narrowing pattern
  the formatter uses).

### Documented
- **[ADR-0017](docs/plans/adr/0017-v0.4-a-supervisor-cli.md).**
  The design record. Documents why a `useRef` (not a callback
  closure) is the right seam for the snapshot accessor, why a
  pure formatter (not a React component) is the right shape for
  the renderer, why the postmortem-only subcommand passes
  `fires: []` (the formatter's layout rules skip the fires
  header when `fires=[]` AND a postmortem is present, so the
  dispatcher doesn't need a "suppress fires header" flag), and
  why `postmortemError` is surfaced as a distinct line (operators
  should see *why* the prose didn't generate, not just an empty
  section).

### Migration notes
- No user-visible breaking changes from A.3.
- Operators can now use `/supervisor` from the chat pane to
  inspect supervisor state for the most recent turn. The
  existing on-disk session log is unchanged; the slash command
  is purely a read-only in-memory accessor.
- The 3 supervisor states are now reachable from the chat:
  `/supervisor` for the post-mortem review of a turn,
  `/supervisor fires` for a quick "what fired?" check, and
  `/supervisor postmortem` for just the LLM's reasoning. Tab
  completion now lists `/supervisor` and `/audit` alongside
  the existing commands.

## [0.3.0] — 2026-06-19

**v0.3.0 — Run polish + recon + audit.** Aggregates the
three v0.3 slices shipped this week. **830 tests green**
(1 testkit + 231 core + 352 tools + 246 gmft). No breaking
API changes from v0.2.0; chokepoint semantics unchanged.

The three slices (each has its own entry below for the
per-PR audit trail):

- **A — Run polish + tool surface:** `--target` +
  `--resume` + `--report`/`--report-format` CLI flags,
  supervisor model wiring (`--supervisor-model`), the
  post-mortem card, attack-chain support
  (`packages/tools/src/chains/`), the `/tools` and `/run`
  slash commands, `/report`, Tab completion, and the
  `report_pdf` tool (react-pdf).
- **B — Recon expansion:** 13 new tools (7 network + 3 web
  + 3 wifi), `--scope <file>` for per-line target fan-out,
  the destructive-warning surface in the StatusRail, and
  `docker/Dockerfile.{network,web}` bumped to `:0.3` with
  the new binaries. Catalog grows from 16 → 29 tools.
- **C — Audit log + CLI:** tamper-evident hash-chained
  HMAC-signed JSONL audit log under
  `$XDG_CONFIG_HOME/gmft/audit/`, the
  `withAuditChokepoint` post-decision decorator, and the
  `gmft audit {verify,log,tail}` subcommand surface. The
  TUI wiring of `withAuditChokepoint` (StatusRail breadcrumb
  + `/audit` slash command) is a deliberate follow-up
  tracked under ADR-0013 §7.

### Changed
- **Workspace versions:** all four release-surface
  packages (`apps/gmft`, `packages/core`,
  `packages/testkit`, `packages/tools`) bumped
  `0.1.0 → 0.3.0` in lockstep. The two native shims
  (`landlock-shim`, `seccomp-shim`) stay at `0.0.1` —
  they're pre-1.0 native modules not part of the workspace
  release surface. The root `package.json` stays at
  `0.1.0` (it's a `private: true` workspace manifest, not
  a publishable artifact).

### Migration notes
- No user-visible breaking changes from v0.2.0.
- Operators upgrading from v0.1.0 should re-read
  [`docs/safety.md`](docs/safety.md) — the chokepoint
  still has the same five rules, but the audit log now
  persists decisions so a hand-edited audit.jsonl is
  detectable via `gmft audit verify`.
- The catalog grew 16 → 29 tools; old `/tools` listings in
  transcripts may show new tools. No action required.

## [0.3.0-C] — 2026-06-19

**v0.3.C slice — tamper-evident audit log + CLI.** Adds a
hash-chained, HMAC-signed JSONL audit log under
`$XDG_CONFIG_HOME/gmft/audit/`, the `withAuditChokepoint`
decorator that records every chokepoint decision, and a new
`gmft audit {verify,log,tail}` subcommand surface. The TUI
wiring of `withAuditChokepoint` lands in a follow-up commit;
this slice ships the library + CLI so the chain contract is
reviewable in isolation.

### Changes

- **Audit library (`@gmft/core/audit`):**
  - `AuditEvent`, `AuditEventKind` (7 kinds: `session-start`,
    `session-end`, `tool-call`, `tool-result`,
    `chokepoint-decision`, `runner-mode`, `onboard`),
    `canonicalForm` (recursive key-sort for reproducible
    hashes), `computeHash` (HMAC-SHA-256 over the canonical
    form), and `GENESIS_PREV_HASH` (64 zero hex chars).
  - `AuditWriter.append(kind, payload)` — single-writer,
    `fsync`-on-append, mode-0600 file. Each event carries
    `ts`, `kind`, `prevHash`, `hash`, and `payload`. The
    chain: line N's `prevHash` = line N-1's `hash`; line 1's
    `prevHash` = `GENESIS_PREV_HASH`.
  - `getOrCreateHmacKey` — generates a 32-byte key on first
    run, reads the existing 0600 file on subsequent runs,
    corrects mode on first append after a chmod tampering.
  - `backupHmacKey` / `restoreHmacKey` — move the key between
    file and secret store (under `audit.hmac_key`).
  - `AuditSink` interface + `NOOP_SINK` + `makeAuditSink` —
    the indirection that lets tests assert on logged events
    without touching the file. `GMFT_AUDIT=off` swaps in
    `NOOP_SINK`.
  - `withAuditChokepoint(inner, sink)` — wraps a
    `Chokepoint` and records every decision. The inner
    chokepoint is unchanged (ADR-0006's promise stays
    intact: auditing is post-decision, never a co-routine).
- **Audit CLI (`apps/gmft/src/cli.tsx`):**
  - `gmft audit verify` — walk the chain, recompute every
    hash, exit 0 if intact / 1 if broken. Prints the broken
    line number, recorded vs. computed hash, and the count
    of events verified before the break.
  - `gmft audit log` — read with filters: `--limit N`,
    `--since ISO`, `--until ISO`, `--kind KIND` (repeatable).
    Most-recent-first, formatted as
    `<line>\t<ts>\t<kind>\t<JSON-encoded payload>`.
  - `gmft audit tail` — follow the log in real time
    (500ms poll), emit each new line, stop on SIGINT.
  - Dispatch is an early branch in `cli.tsx` — `gmft audit
    ...` never triggers onboarding or TUI mount.
- **Audit primitives (`apps/gmft/src/cli-audit.ts`):**
  - `verifyAuditLog(file, key)` — returns
    `{ ok, eventCount, lastEvent } | { ok, brokenAt, recorded,
    computed, eventCount, unverifiedFrom }`.
  - `readAuditLog(file, filters)` — filtered read.
  - `tailAuditLog(file, onLine, { pollMs, shouldStop })` —
    poll-and-emit follow mode.
- **Core re-exports (`packages/core/src/index.ts`):** 13
  new symbols re-exported so `apps/gmft` can
  `import { verifyAuditLog, ... } from '@gmft/core'`. The
  `audit/` module is otherwise self-contained.
- **ADR-0013** — the v0.3.C audit-log design (chained JSONL,
  HMAC key storage, opt-out, the deliberate non-change to
  `AgentApp.tsx`).

### Test budget

+10 tests, all in `apps/gmft/test/`:
- `audit/types.test.ts` (4) — `canonicalForm` key-sorts
  recursively, `computeHash` is stable across runs, the
  canonical form omits `hash` itself, `GENESIS_PREV_HASH` is
  64 zeros.
- `audit/key.test.ts` (2) — `getOrCreateHmacKey` creates on
  first call and reads on second; mode is 0600 after create.
- `audit/writer.test.ts` (4) — first append uses
  `GENESIS_PREV_HASH`, second append chains to the first,
  50 concurrent appends produce a valid chain, file mode is
  0600 after append.
- `audit/sink+instrument.test.ts` (2) — sink called with
  every chokepoint decision; `GMFT_AUDIT=off` swaps to
  `NOOP_SINK`.
- `cli-audit.test.ts` (7 — over budget by 2) — verify
  intact, verify tampered, verify wrong key, read all,
  filter by kind, apply limit, tail picks up new lines.

### TUI follow-up (out of scope for v0.3.C, intentional)

`AgentApp.tsx` does **not** call `withAuditChokepoint` in
this slice. A 6-line breadcrumb in the file header (above
the imports) points at ADR-0013 §7 and the recipe. The
follow-up wrap is one line: `withAuditChokepoint(
createChokepoint(readChokepointEnv({...})), sink)`.

## [0.3.0-B] — 2026-06-19

**v0.3.B slice — recon expansion.** Adds 13 new tools to the
catalog (7 network + 3 web + 3 wifi), bumping the shared
`gmft/network` and `gmft/web` Docker images from `:0.1` to
`:0.3` to bundle the new binaries, and adding `--scope <file>`
for per-line target fan-out across any `targetRequired` tool.
Catalog grows from 16 → 29 tools; tool-catalog doc is the
operator reference for all 29.

### Changes

- **Network tools (7, image `gmft/network:0.3`):**
  - `masscan` — internet-scale port scanner, use when nmap is
    too slow for the range.
  - `rustscan` — fast Rust port scanner that hands off to nmap
    for service detection.
  - `subfinder` — passive subdomain enumeration (CT logs +
    ~30 passive sources).
  - `dnsrecon` — active DNS record enumeration (SOA/NS/MX/TXT/
    SRV/PTR + zone-transfer attempt).
  - `fierce` — DNS zone-walk + adjacent-network scanner.
  - `enum4linux` — SMB/Samba enumeration (users, shares, groups).
  - `ldapsearch` — LDAP directory query with anonymous bind
    fallback.
- **Web tools (3, image `gmft/web:0.3`):**
  - `httpx` — HTTP(S) liveness probe; the standard follow-up
    to `subfinder` output.
  - `wpscan` — WordPress core/plugin/theme/CVE scanner.
  - `snmpcheck` — SNMP enumeration (default community `public`
    is the misconfiguration detector).
- **Wifi tools (3, host-only, not in any Docker image — same
  model as the v0.1 wifi tools):**
  - `bettercap` — passive AP + BLE discovery. **Recon, not
    attack** (no transmit) — for deauth / evil-twin see the
    v0.1 wifi tools.
  - `aircrack` — passive WiFi capture via `airodump-ng`; does
    not crack (operator runs `aircrack-ng` / `hashcat` offline
    with their own wordlists).
  - `kismet` — parses a Kismet `.kismet` log for post-hoc device
    discovery across WiFi / BLE / Zigbee.
- **Dockerfiles:** `docker/Dockerfile.network` and
  `docker/Dockerfile.web` bumped to the `:0.3` tag with the
  new binaries installed (masscan, rustscan, subfinder,
  dnsrecon, fierce, enum4linux, ldapsearch / httpx, wpscan,
  snmpcheck). Each new binary has a forward-looking `which`
  check in the build.
- **Catalog:** all 13 new tools registered in
  `packages/tools/src/catalog.ts` with the correct `category`
  (`recon` for the 7 network tools, `binary` for the 3 web
  and 3 wifi tools) and `flags` (`targetRequired` for all
  except httpx/wpscan/snmpcheck which are intentionally
  unflagged — they're the right tool to probe a host the LLM
  learned about, not just the session target).
- **`--scope <file>`** (chokepoint, command line): new flag
  that reads a newline-delimited list of targets and fans the
  call out across all of them. Each target gets its own
  chokepoint confirmation + audit row. The 13 new tools
  inherit the scope-mode behavior from the existing
  `targetsFromFile: true` opt-in on the older recon tools
  (nmap, dnsenum, etc.).
- **Destructive warning surface:** chokepoint emits a yellow
  warning for any tool flagged `destructive` *or* any tool
  whose target is non-canonical (e.g. an IP outside the
  session target's denylist range). Visible in the StatusRail
  during the confirmation prompt and in the audit log.
- **Tool catalog doc:** `docs/tool-catalog.md` updated to
  document all 29 tools, the Quick reference table, and a
  rewritten "What's not in v0.3.B" section that lists
  active-directory attack tooling, WPA handshake cracking,
  and managed long-lived daemons as out-of-scope.

### Verification

- `pnpm -r build` — clean.
- `pnpm -r typecheck` — clean.
- `pnpm -r test` — 827/827 passing
  (16 native-shim + 1 testkit + 219 core + 352 tools + 239 gmft;
  the 20 new gmft cases come from the tab-completion module +
  2 new InputBox wiring tests).
- `gmft run --help` lists all 29 tools.

### Migration notes

- `--scope <file>` is additive. Existing invocations that pass
  `--target <ip>` continue to work. Tools that opt into
  scope-mode read targets from the file one-per-line and emit
  one chokepoint confirmation + one audit row per target.
- `docker/Dockerfile.network` and `.web` bumped `:0.1` → `:0.3`.
  The `runner` cache key includes the image tag, so a stale
  `:0.1` image will be replaced automatically the next time a
  tool runs; no manual `docker image rm` required.
- The 3 new wifi tools are host-only (require `bettercap`,
  `airodump-ng`, or a kismet log on the host's PATH). They
  are not in any gmft Docker image by design — wireless NIC
  monitor mode and capture permissions are host-side concerns.

### Known issues

- `stream.test.ts > spawnStreaming > fires onStdout multiple
  times for chunked output` remains a flaky test (~1% failure
  on slow CI). Carryover from `[0.3.0-A]`. Track in
  `docs/superpowers/plans/2026-06-17-gmft-v0.3-run-polish-and-tool-surface.md`
  §Risks.
- `enum4linux` and `wpscan` are loud — WAF / SMB null-session
  alarms are expected. Operators should only run them against
  in-scope targets and expect blue-team noise.

## [0.3.0-A] — 2026-06-17

**v0.3.A slice — run-polish.** Ships the first stable `run-polish`
build (A.1) and completes the v0.2.A.2 / v0.2.A.3 supervisor work
that the TUI needed to actually fire in production (A.2–A.4),
with an ADR capturing the 4 implementation decisions (A.5).
Closes the "postmortem never runs" gap from v0.2.A.3.

### Changes

- **A.1.1** — `dist/` runtime is NodeNext + `.js` import
  suffixes, not a bundler. Fixes the v0.2-era `ERR_MODULE_NOT_FOUND`
  crash on `node ./dist/cli.js`. See `[0.3.0-A.1]` for full
  A.1.1 details (82 suffixes, tsconfig `NodeNext`, CJS-shim cast
  fix, fs top-level import). Bundler adoption deferred to a
  follow-up (phase 6 ended up shipping `bundle.js`).
- **A.1.4** — CI smoke test runs `node ./dist/cli.js --help`
  on every PR, so a regression to the A.1.1 fix is caught
  before merge.
- **A.2** — `SupervisorFireMarker` wiring into ChatTab via
  per-turn `eventIds` + session-wide `supervisorFires`. AgentApp
  accumulates fires; ChatTab matches each fire's `targetEventId`
  against the assistant message's `eventIds` and slots a marker
  after the matching line. Closes the v0.2.A.2 "marker never
  renders" gap.
- **A.3** — `--supervisor-model <id>` CLI flag, plumbed through
  `AgentApp` as `supervisorModelId` and into `withSupervisor` as
  the new `modelId?` opt. AgentApp builds a second `createModel`
  call that reuses the primary's `provider` / `apiKey` /
  `endpoint` and swaps in the override model id. The
  `SupervisorTurnRecord.modelUsed` field is no longer a
  hard-coded `'agent-model'` lie; it now reflects the actual
  model that produced the postmortem. This is the first time
  the supervisor postmortem fires in production.
- **A.4** — `AuditLogTab`: a 4th tab in the TUI (Chat /
  Findings / Help / **Audit**) that paginates, filters by
  `kind`, and color-codes the session's `AgentEvent` log.
  Keybindings: `n` (next page), `p` (prev page), `f` (cycle
  the kind filter). Default page size 50. AgentApp accumulates
  every event the loop yields into a `useState<AgentEvent[]>`
  and threads it to `<App auditEvents={...} />`.
- **A.5** — ADR-0012 documents the 4 decisions: dist runtime
  approach, marker wiring model, supervisor-model opt-out, and
  audit viewer tab placement.

### Verification

- `pnpm -r build` — clean.
- `pnpm -r typecheck` — clean.
- `pnpm -r test` — 536/536 passing
  (16 native-shim + 1 testkit + 213 core + 136 tools + 170 gmft).
- `node ./apps/gmft/dist/cli.js --help` — works (CI smoke).
- `node ./apps/gmft/dist/cli.js --supervisor-model claude-haiku-4-5 --help`
  — works, flag documented in help text.

### Migration notes

- The Tab / Shift-Tab cycle in `app-e2e.test.tsx` was
  hard-coded to 3 tabs and has been updated to the new 4-tab
  cycle (Chat→Findings→Help→Audit→Chat and reverse). Any
  external test that asserts the cycle length must also
  update.
- `--supervisor-model` is additive and opt-in. Existing
  sessions that don't pass the flag use the primary model
  for the postmortem (same behavior as v0.2.A.3, but now
  the `modelUsed` field on the `SupervisorTurnRecord` is
  accurate).

### Known issues

- `stream.test.ts > spawnStreaming > fires onStdout multiple
  times for chunked output` remains a flaky test (1% failure
  on slow CI). v0.2 `setImmediate` fix and the A.4 audit
  viewer's deterministic-render test don't address it. Track
  for a future phase.

## [0.3.0-A.1] — 2026-06-17

**v0.3.A slice 1 — dist runtime fix.** Fixes the long-standing
v0.2 bug where `node ./dist/cli.js` (or `gmft` after install)
crashed immediately with `ERR_MODULE_NOT_FOUND` because the
`@gmft/tools` package's compiled JS still imported sibling
modules without the `.js` extension that native ESM resolution
requires. Bundler-style resolution worked for vitest+esbuild,
but `node` (which is what runs the published CLI) does not.

### Changes

- **A.1.1** — Added `.js` extensions to 82 relative
  `import`/`export` specifiers across 46 source + test files
  in `packages/tools/src/`, `packages/tools/test/`. Generated
  `packages/core/src/` and `apps/gmft/src/` were already
  extension-complete.
- **A.1.2** — Switched `module` and `moduleResolution` in
  `tsconfig.base.json` from `ESNext`/`Bundler` to `NodeNext`.
  This makes `tsc` enforce the same resolution rules the
  runtime will see, catching missing extensions at build time
  instead of runtime.
- **A.1.3** — `dist/cli.js` now runs with plain `node`; the
  `start` script and `bin: gmft → ./dist/cli.js` work
  end-to-end. **No code change required**: both already
  pointed at the right path; they were just broken because
  the emitted JS couldn't resolve.
- **Cross-shim cast fix** — `@gmft/landlock-shim` and
  `@gmft/seccomp-shim` are CJS modules (`module.exports =
  require('./build/Release/*.node')`). Under NodeNext,
  `import * as shim` sees a namespace whose shape doesn't
  structurally match the inline `as { ... }` cast. Tightened
  the three call sites in `landlock.ts` and `seccomp.ts` to
  `as unknown as { ... }` (the canonical NodeNext escape
  hatch). No runtime change.
- **Test fix** — `packages/core/test/session-paths.test.ts`
  had a `require('node:fs')` to avoid a top-level import.
  Under NodeNext that becomes a compile error. Moved
  `existsSync` to the top-level import.

### Verification

- `pnpm -r build` — clean (7/7 packages).
- `pnpm -r test` — 497/497 passing
  (1 testkit + 211 core + 136 tools + 149 gmft).
- `pnpm -r typecheck` — clean (6/6).
- `node ./apps/gmft/dist/cli.js --help` — works.
- `node ./apps/gmft/dist/cli.js --version` — `0.1.0`.
- `node ./apps/gmft/dist/cli.js --target test` — runs the
  full TUI boot (fails on the expected `anthropic requires
  apiKey` runtime error, which is **after** the module
  resolution that was previously crashing).

### Migration notes

- Anyone consuming `@gmft/tools` from a native-ESM context
  (Node 18+, no bundler) will now see the `.js` extensions
  in the emitted `dist/`. That is the spec-correct form
  and is what the spec says you should do.
- The change to `tsconfig.base.json` is a **monorepo-wide
  tightening**. New TS code in any package must now use
  `.js` extensions on relative imports.

### Known issues (unchanged from v0.2)

- `stream.test.ts > spawnStreaming > fires onStdout multiple
  times for chunked output` is a flaky test that fails
  ~1% of the time on slow CI. The v0.2 `setImmediate` fix
  helps but doesn't eliminate it. Tracked in v0.3.A scope
  (the supervisor audit-viewer work in A.2.3 will write a
  more deterministic test).

## [0.2.0] — 2026-06-17

First 0.2 release. Aggregates the v0.2.A (multi-agent
supervisor) and v0.2.D (host-sandbox) slices plus the v0.2
close-out fixes.

### Highlights

- **Multi-agent supervisor** (v0.2.A) — post-hoc loop-detector
  + overclaim-detector + plan-issue-detector + end-of-turn
  postmortem. Silent by default (3-rule fast path + 3-rule
  end-of-turn check). `withSupervisor` wraps any `runTurn`
  with the 6 supervisor triggers and the 4-section postmortem
  generator. StatusRail shows the 3 supervisor states (quiet /
  fires / postmortem). `SupervisorFireMarker` is the inline
  ⚠ marker in the transcript. Session log migrated v0.1 → v0.2
  transparently via `schemaVersion: 1 | 2`.
- **Host-sandbox enforcement** (v0.2.D) — when the runner
  falls back to host mode, the child process now has a
  kernel-enforced sandbox: **landlock** (filesystem ACL) when
  the kernel supports it (5.13+, June 2021; Ubuntu 22.04+,
  Fedora 35+), **seccomp** (syscall filter) when the kernel
  supports it. The new `requiresSandbox` chokepoint rule
  **denies** destructive/elevated tools when neither Docker
  nor landlock is available (the secure default; opt-out via
  `GMFT_ALLOW_UNSANDBOXED_DESTRUCTIVE=true`). The StatusRail
  surfaces the resolved mode (4 states: docker/host+kernel
  green, host yellow ⚠, unsandboxed red ✗). The `--sandbox=
  docker|host|auto` CLI flag lets the user override the
  auto-resolution. **ADR-0011** documents the policy.

### Sub-slices (in release order)

- [0.2.0-A.1](#020-a1--2026-06-11) — supervisor A.1 (3 rules
  + wrapper, 30 tests)
- [0.2.0-A.2](#020-a2--2026-06-12) — supervisor A.2 (TUI
  surfacing + 5 tests)
- [0.2.0-A.3](#020-a3--2026-06-12) — supervisor A.3
  (postmortem + 54 tests)
- [0.2.0-D.1](#020-d1--2026-06-17) — D.0 landlock-shim + D.1.1
  primitives + D.1.3 seccomp (53 tests)
- [0.2.0-D.2](#020-d2--2026-06-17) — D.2 chokepoint requires-
  sandbox rule + StatusRail/CLI surfacing + e2e (28 tests)
- [0.2.0-D.3](#020-d3--2026-06-17) — ADR-0011 (docs-only)

### Close-out fixes (post-0.2.0-D.3)

- ESM `require()` removal in `capabilities.ts`, `landlock.ts`,
  `seccomp.ts` — the gmft CLI crashed at runtime with
  `'require is not defined'`. Now uses top-level ESM imports.
  The shim lazy-load was a cargo-cult optimization; the
  non-Linux guards remain in place.
- `stream.test.ts` flake (~1/3 rate on GH Actions Node 20) —
  child now uses `setImmediate` between writes so the pipe
  drains. Test assertion changed to `toBeGreaterThanOrEqual(2)`.

### Tests

- 497 tests green (1 testkit + 211 core + 136 tools + 149 gmft).
  v0.2 added 220 tests since v0.1.0.
- `pnpm -r build`, `pnpm -r typecheck`, `pnpm -r test` all
  clean. CI green on Node 20 + Node 22 matrix.
- `pnpm dev --sandbox=host` runs the full CLI past the
  v0.2.D chokepoint layer.

### Migration from 0.1.0

- Session logs auto-migrate from `schemaVersion: 1` to
  `schemaVersion: 2` on read. The supervisor field is parsed
  only if the version is 2.
- Destructive/elevated tools are now **denied by default** on
  hosts without Docker and without kernel landlock. Set
  `GMFT_ALLOW_UNSANDBOXED_DESTRUCTIVE=true` to restore the old
  "warn + proceed" behavior. The override is documented but
  not recommended.
- The audit log's `runnerMode` field is new; older log readers
  (v0.1.0 and earlier) will ignore it.

### Known issues

- The compiled `dist/cli.js` artifact cannot be run with plain
  `node` (ESM extensionless imports fail at runtime). The
  `dev` script (`tsx ./src/cli.tsx`) is the documented run
  path. Fixing the `dist` runtime is a v0.3 backlog item.
- Pre-existing flake in `stream.test.ts` is fixed; no other
  known flakes as of v0.2.0.

## [0.2.0-D.3] — 2026-06-17

Docs-only slice. D.3 deliverable promised in
[0.2.0-D.1](#020-d1--2026-06-17)'s CHANGELOG entry.

### Added
- [ADR-0011](./docs/plans/adr/0011-host-sandbox-enforcement.md) —
  documents the v0.2.D host-sandbox enforcement policy
  (landlock + seccomp auto-apply, chokepoint
  `checkRequiresSandbox` rule, StatusRail 4-state, the
  `_setLandlockAvailableForTest` test seam). No code changes;
  all v0.2.D code shipped in [0.2.0-D.2](#020-d2--2026-06-17).

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

## [0.2.0-D.1] — 2026-06-17

First slice of v0.2.D (host-side sandbox hardening). Ships the
D.1 primitives (D.1.1, already landed as commit d7514c2) plus
the D.1.3 seccomp auto-apply that was explicitly deferred in
D.1.1's commit message. The landlock auto-apply landed in D.1.1;
this slice adds the seccomp half so the runner can now install
*both* a filesystem LSM (landlock) AND a syscall filter (seccomp
BPF) on the host-fallback path.

### Added
- `packages/seccomp-shim/` — new N-API shim, sibling of
  `@gmft/landlock-shim`. Exposes 3 functions: `arch()`,
  `prctlSetNoNewPrivs()`, `installBpf(bpfBytes, flags)`. Pure
  C++17, no `libseccomp.so` runtime dep. Builds via `node-gyp`
  on Linux. The BPF program is built in pure JS and passed in
  as a `Buffer`.
- `packages/tools/src/shared/bpf.ts` — pure-JS BPF program
  emitter. `BpfProgram` (typed array of `{code, jt, jf, k}`
  instructions, with `encode()` → `Buffer` for the shim),
  `buildBpfAllowlist({arch, allowedSyscalls})` (default-deny),
  `buildBpfDenyList({arch, deniedSyscalls})` (default-allow,
  block dangerous syscalls), and a `nodeArchToBpfArch()`
  mapping from `process.arch`. Exports two sample policies:
  `ALLOWLIST_DIAGNOSTIC_SYSCALLS_X86_64` (21-syscall
  default-deny for read-only diagnostics tools) and
  `DENYLIST_DANGEROUS_SYSCALLS_X86_64` (deny ptrace, kexec,
  mount, bpf, ...).
- `packages/tools/src/shared/seccomp.ts` — `applySeccomp(opts)`
  wires the BPF + `PR_SET_NO_NEW_PRIVS` + `seccomp(SECCOMP_SET_MODE_FILTER)`
  for the current thread (designed to be called from a
  `preExec` hook). Refuses to install a filter with an empty
  allowlist (mirrors `applyLandlock`'s no-allowlist refusal).
  The probe is now `available: true` on any Linux host
  (previously only `strict|filter` modes were "available" —
  but a fresh process is always mode 0 / `disabled`, so the
  old probe would have made `applySeccomp` impossible to call).
- `packages/tools/src/shared/runner.ts` — `RunOptions` gains
  `seccompPolicy?: 'allowlist' | 'denylist'`. `RunResult.mode`
  widens to include `'host+seccomp'` and `'host+landlock+seccomp'`
  (with `seccompApplied` + `seccompPolicy` result fields). The
  `preExec` hook now applies landlock *then* seccomp (in that
  order — landlock touches the FS, seccomp filters syscalls;
  the order matters because applying seccomp first would
  block the FS syscalls landlock needs). Seccomp is opt-in:
  callers must pass `seccompPolicy` to get it.
- 13 tool Zod schemas (`*Output.mode` enums in
  `packages/tools/src/{network,web,shell,wifi}/*.ts`) gain
  `'host+seccomp'` and `'host+landlock+seccomp'`.

### Tests
- 9 new tests in `packages/seccomp-shim/test/install.test.js`:
  5 argument-validation + 3 live-call (arch, no_new_privs,
  get_seccomp) + 1 export shape. The shim smoke test does NOT
  install a real filter, so it passes on a kernel without
  seccomp too.
- 9 new tests in `packages/tools/test/shared/bpf.test.ts`:
  3 audit-arch + 1 BpfProgram.encode (LE byte order) + 3
  buildBpfAllowlist (shape, default-action override, real
  diagnostic list length) + 2 buildBpfDenyList (shape, empty
  denylist → everything allowed). All assertions on the
  emitted BPF byte sequence — no kernel required.
- 5 new tests in `packages/tools/test/shared/seccomp.test.ts`:
  2 buildSeccompBpf (default allowlist + custom lists + denylist
  mode) + 2 applySeccomp (refuses on non-Linux, refuses empty
  allowlist). The 3 pre-existing seccomp-probe tests are still
  green.
- 3 new tests in `packages/tools/test/shared/runner-host-sandbox.test.ts`:
  the **first one actually installs a BPF filter on a real
  child process** (sets `caps.seccomp='available'` in the
  test seam, calls `run({seccompPolicy: 'allowlist'})`, asserts
  the child printed `'seccomp-ok'` and exited 0). The other 2
  cover `'host+landlock+seccomp'` mode resolution and the
  opt-in (no seccomp when `seccompPolicy` is unset).
- v0.2.0-D.1 total in `packages/tools`: 136 tests (was 119
  before this slice). `packages/seccomp-shim`: 9 tests.
  Workspace: 274 tests, 0 fails.

### Plan deviations
The plan (`docs/superpowers/plans/2026-06-17-gmft-v0.2-D-host-sandbox.md`)
said seccomp auto-apply was "v0.3 stretch — see ADR-0011" and
this slice ships it in v0.2.D.1 instead. The rationale: the
BPF emitter turned out to be ~200 lines of pure data
(constructors + an encoder), and the shim was ~200 lines of
C++ mirroring `@gmft/landlock-shim`. Together they're well
under a day's work and close a real security gap the
host-fallback path exposes. ADR-0011 still needs to be
written (D.3); this slice ships the code, ADR-0011 will
document the policy.

## [0.2.0-D.2] — 2026-06-17

Second slice of v0.2.D. Closes the host-fallback gap: when the
runner falls back from Docker to host mode, the chokepoint now
**denies** destructive/elevated tools when neither Docker nor
kernel landlock is available (instead of silently degrading to
"host, no protection"). The StatusRail surfaces the resolved
sandbox mode + the `✗ unsandboxed` red glyph when a call is
denied. ADR-0003's "v0.2 may add landlock/AppArmor" deferral is
fulfilled by this slice.

### Added
- `packages/core/src/chokepoint/requires-sandbox.ts` — new
  `checkRequiresSandbox` rule for the chokepoint aggregator.
  Fires when `runnerCapabilities().resolvedAuto === 'host'`
  AND the call carries `destructive` or `requiresElevation`.
  Returns `deny` with the canonical reason
  `"host fallback for destructive/elevated tools requires
  Docker or kernel landlock (set
  GMFT_ALLOW_UNSANDBOXED_DESTRUCTIVE=true to override; not
  recommended)"`. An opt-in env flag
  `GMFT_ALLOW_UNSANDBOXED_DESTRUCTIVE` lets the user force
  the old "warn + proceed" behavior (default: `false`, the
  secure default).
- Chokepoint aggregator rule order is now
  `elevation → typeToConfirm → destructive → target →
  requiresSandbox → allow`. `requiresSandbox` is the LAST
  gate. Rationale: a destructive tool that needs sandboxing
  is still a destructive tool; the existing destructive→
  confirm flow should fire first so the user is *asked*,
  and only when they say "yes" does the runner then refuse
  because there's no sandbox.
- `runnerCapabilities` is now plumbed into the chokepoint's
  env (via `policy.ts` — `opts.runnerCapabilities ??
  DEFAULT_CAPS` keeps the chokepoint's pure unit tests
  hermetic). The `DEFAULT_CAPS` constant is
  `{resolvedAuto: 'host'}` so the rule still fires when the
  env is missing the field.
- `RunResult` gains `runnerMode: 'docker' | 'host+landlock' |
  'host+seccomp' | 'host+landlock+seccomp' | 'host'`. The
  audit log records the actual mode each tool call ran in.
- `apps/gmft/src/AgentApp.tsx` — the rail's `sandbox` field
  starts at the host's auto-resolved mode and updates from
  the tool-result's `output.mode` after every call. A denied
  call (ok=false, non-empty reason) sets `sandbox =
  'unsandboxed'`, surfacing the red `✗ unsandboxed` glyph.
- `apps/gmft/src/ui/components/StatusRail.tsx` — new
  `SandboxField` with 4 color-coded states: `docker` /
  `host+landlock+seccomp` (green — kernel-enforced),
  `host` (yellow — `⚠` warning), and `unsandboxed` (red —
  `✗`).
- `apps/gmft/src/cli.tsx` — new `--sandbox=docker|host|auto`
  CLI flag. The `auto` default is: docker if available, else
  host+landlock if available, else host (with the chokepoint
  rule denying destructive calls). The flag is parsed by
  `apps/gmft/src/sandbox-flag.ts`.

### Tests
- 6 new tests in
  `packages/core/src/chokepoint/requires-sandbox.test.ts`:
  3 deny (host+destructive, host+elevated, deny-reason
  contains canonical string) + 3 allow (host+read-only,
  docker+anything, landlock+anything, override env flag
  set, target-required rule). The full aggregator rule
  order is asserted in one case.
- 4 new tests in `apps/gmft/test/capabilities-snapshot.test.ts`:
  shape (domain check, not value — kernels differ) + cache
  (same object on repeat calls) + 2 negative tests guarding
  the `runnerCapabilities` test seam.
- 11 new tests in `apps/gmft/test/status-rail-sandbox.test.tsx`:
  3 mode color coding (green/yellow/red) + 3 glyph
  rendering (⚠ host, ✗ unsandboxed, no glyph on docker) +
  2 transitions (destructive→unsandboxed flips red) +
  3 regression (the existing 4 rail modes still render).
- 6 new tests in `apps/gmft/test/cli-sandbox-flag.test.ts`:
  3 parse cases (docker/host/auto) + 2 invalid input
  (unknown value, malformed) + 1 default-is-auto.
- 1 new e2e in `apps/gmft/test/e2e-sandbox-deny.test.tsx`:
  AgentApp + real chokepoint + a runner-stubbed mocked
  `runTurn` that drives the chokepoint on an elevated call.
  Asserts the rail flips to `✗ unsandboxed` and the
  chokepoint's decision has `kind: 'deny'` with the
  canonical reason. **Note on flag choice:** the original
  plan said "destructive tool" but the aggregator's rule
  order means `checkDestructive` short-circuits a
  `destructive` flag with `kind: 'confirm'` *before*
  `checkRequiresSandbox` runs. The e2e uses
  `requiresElevation` + `GMFT_ALLOW_ELEVATION=true` so
  `checkElevation` passes through and
  `checkRequiresSandbox` actually fires. Documented in
  the test docstring + plan line 99.
- v0.2.0-D.2 totals: 1 + 211 + 136 + 149 = **497 tests,
  0 fails**. `pnpm -r build`, `pnpm -r typecheck`,
  `pnpm -r test` all clean. CI green on Node 20+22 matrix.

### Plan deviations
- Two tests in `packages/tools/test/shared/{capabilities,
  landlock}.test.ts` were originally host-dependent (assumed
  the dev host's "no landlock" kernel). CI runner kernels
  have landlock, so the tests failed in CI. Fix landed in
  commit `d0ecad9`: `capabilities.test.ts` now reads the
  live probe and asserts the snapshot is internally
  consistent with whatever it says. `landlock.test.ts` now
  uses a new test seam `_setLandlockAvailableForTest(status)`
  (added to `packages/tools/src/shared/landlock.ts`) to
  deterministically simulate a "landlock not available"
  host. Both tests are now kernel-agnostic; the production
  call path is exercised by `runner-host-sandbox.test.ts`
  (which uses `setCapabilitiesForTest`) and the D.1.1
  manual smoke (a kernel with real landlock).
- The e2e test's flag choice (see Tests section above)
  was a design clarification, not a deviation. The plan
  line 127 already documented the "rule order bottom"
  rationale.

### Migration notes
- Users running v0.2.A on a host without Docker and without
  kernel landlock will see **destructive/elevated tools
  denied by default** the first time they run v0.2.D. To
  restore the old "warn + proceed" behavior, set
  `GMFT_ALLOW_UNSANDBOXED_DESTRUCTIVE=true` in the
  environment. This is the secure default; the override
  is documented but not recommended.
- The audit log's `runnerMode` field is new; older log
  readers (v0.2.A and earlier) will ignore it.

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
