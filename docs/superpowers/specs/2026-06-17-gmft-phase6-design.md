# Phase 6 — Attack chains, reports, more wifi, scope files

> Companion to §5 of the v0.1 master plan (`docs/plans/2026-06-08-gmft-ai-v0.1.md`).
> This spec brings the master plan forward into the current codebase (post-merge
> main at `939dc1a`, after PR #3 / phase 5), locks the design decisions for
> four features, and is the contract for the implementation plan that follows.

**Goal:** Four features ship in the order **C → B → A → D** (lowest risk first):

- **C. Two more wifi tools** (`wifi_deauth`, `wifite_scan`) — same shape as the
  existing `evil_twin`, no new architecture. Closes the wifi family gap.
- **B. Report writer + Findings tab depth** — a new `report_write` tool that
  reads the session's findings JSONL, plus a real (scrollable, selectable)
  FindingsTab that drives the report's "what to include" list. No new
  binaries; mostly a UI rewrite + a markdown/HTML writer.
- **A. Attack-chain orchestration** — a new `attack_chain` tool that runs a
  list of operator-defined tool calls in sequence, with shared findings.
  Forces a small `runInner` seam on the executor; agent loop stays unchanged.
- **D. Multi-target / scope-file support** — a new `targetsFromFile: true` flag
  on `Tool<I,O>`; the executor reads the file and runs the tool once per target.
  Additive, no chokepoint contract change.

**Why this phase exists:** §5 of the master v0.1 plan deferred these until the
underlying plumbing (chokepoint, tool registry, executor, findings store,
agent loop with tools, type-to-confirm) was in place. Phase 5 (PR #3) closed
out that plumbing. Phase 6 builds the operator-facing features on top of it.

**Test budget:** ~31 new tests (C: ~6, B: ~7, A: ~13, D: ~5). 288 → **~319**
passing, 0 svelte/tsc errors. Exact count will be locked in the implementation
plan.

**Tech stack:** TypeScript ESM, vitest 2.1, ink-testing-library 4.0, ai SDK
4.3.19. **No new top-level dependencies.** `zod` is already a transitive dep.
All new tools run through the existing `@gmft/core` `Tool<I,O>` shape and the
existing `@gmft/tools` `run` runner + `assertBinary` prereq helper.

**Branch / worktree:** `phase6-chains-reports` cut from `main` HEAD `939dc1a`
(post-PR #3). Single branch, single PR at the end. Per-feature work happens
as separate commits on the branch so the diffs are reviewable; the PR body
groups them as **C / B / A / D** sections.

---

## 1. Scope and ordering rationale

| # | Feature       | New files (est.) | Lines (est.) | New tests | Risk   | Why this slot     |
|---|---------------|------------------|--------------|-----------|--------|-------------------|
| C | more wifi     | 4                | ~400         | ~6        | low    | pattern match on phase 5 evil_twin |
| B | report + tab  | 4                | ~700         | ~7        | medium | UI rewrite + writer; no agent-loop change |
| A | attack chain  | 5                | ~900         | ~13       | high   | executor seam + chain semantics |
| D | scope file    | 3                | ~350         | ~5        | medium | additive flag; per-tool opt-in |

C is the lowest-risk warmup post-merge. B touches the UI and writes a file,
but no new agent-loop or chokepoint code. A is the most architecturally
interesting (forces a `runInner` hook) and gets the freshest code so the
patterns are clean. D comes last because its executor-loop concept reuses the
chokepoint's per-target validation that A's chain model already plumbed.

If we hit issues in A that ripple back, D's implementation is a cheap
extension of the same executor change. If we land C+B+A+D cleanly, the
cumulative test count moves from 288 → ~319.

---

## 2. Feature C — Two more wifi tools

### 2.1 `wifi_deauth`

Sends 802.11 deauth frames to a target AP (and optionally a specific client).
This is a single-shot tool; the operator picks the BSSID, the runner invokes
`aireplay-ng` with `--deauth`, and the tool returns when the count is reached
or the timeout fires.

```ts
// packages/tools/src/wifi/wifi-deauth.ts
export const WifiDeauthInput = z.object({
  bssid: z.string().regex(/^[0-9A-Fa-f:]{17}$/, 'BSSID must be aa:bb:cc:dd:ee:ff form'),
  clientMac: z.string().regex(/^[0-9A-Fa-f:]{17}$/).optional(),
  interface: z.string().min(1),
  count: z.number().int().min(1).max(1000).default(10),
  timeoutSec: z.number().int().min(1).max(600).default(30),
});
export type WifiDeauthInputT = z.infer<typeof WifiDeauthInput>;

export const WifiDeauthOutput = z.object({
  framesSent: z.number().int().nonnegative(),
  dryRun: z.boolean(),
  durationMs: z.number(),
  aireplayArgs: z.array(z.string()),
});

export const wifiDeauthTool: Tool<typeof WifiDeauthInput, typeof WifiDeauthOutput> = {
  name: 'wifi_deauth',
  category: 'binary',
  description: 'Send 802.11 deauth frames to a target BSSID via aireplay-ng',
  input: WifiDeauthInput,
  output: WifiDeauthOutput,
  flags: ['destructive', 'requiresElevation', 'targetRequired'],
  typeToConfirm: 'attack',
  async run({ bssid, clientMac, interface, count, timeoutSec }) {
    // ... execFileNoShell('aireplay-ng', [...args], { timeoutSec * 1000 })
  },
};
```

### 2.2 `wifite_scan`

Wraps `wifite` in a "scan + auto-handshake-capture" mode. Like `evil_twin`,
it spawns the binary in a detached `tmux` session (so the operator can
reattach with `tmux attach -t gmft-wifite-…`) and returns when wifite exits
or the timeout fires. Honors `GMFT_DRY=1` like the other wifi tools.

```ts
// packages/tools/src/wifi/wifite-scan.ts
export const WifiteScanInput = z.object({
  interface: z.string().min(1),
  channels: z.array(z.number().int().min(1).max(165)).optional(),
  durationSec: z.number().int().min(1).max(3600).default(300),
  // wifite-specific: target a single ESSID, capture handshakes, etc.
  targetEssid: z.string().optional(),
  captureHandshake: z.boolean().default(true),
});
export type WifiteScanInputT = z.infer<typeof WifiteScanInput>;

export const WifiteScanOutput = z.object({
  findings: z.array(z.any()),  // populated from the wifite log
  mode: z.enum(['host', 'docker']),
  fellBack: z.boolean(),
  durationMs: z.number(),
  wifiteArgs: z.array(z.string()),
  dryRun: z.boolean(),
  tmuxSession: z.string().optional(),
});
```

### 2.3 Shared concerns

- Both use the existing `packages/tools/src/shared/runner.ts` `run` helper.
- `flags: ['destructive', 'requiresElevation']` + `typeToConfirm: 'attack'`
  mirrors `evil_twin` exactly. The chokepoint's `checkTypeToConfirm` rule
  fires first (per phase 5's aggregator order), so the user must type
  `attack` to approve.
- `category: 'binary'` (matches all 11 existing tools).
- Docker fallback uses a new `docker/Dockerfile.wifi` image (phase 5
  shipped `Dockerfile.network` and `Dockerfile.web` but not wifi; we
  add it here alongside deauth + wifite + evil_twin).

### 2.4 Catalog update

`packages/tools/src/catalog.ts` grows 2 entries, taking the total from 11 to
**13 tools**.

---

## 3. Feature B — Report writer + Findings tab depth

### 3.1 `report_write` tool

A new tool that reads the session's `findings.jsonl` (the existing
`FindingsStore`), filters them by severity and a per-finding "include"
flag, and writes a single self-contained file.

```ts
// packages/tools/src/file/report-write.ts (new file/ subdir)
export const ReportWriteInput = z.object({
  format: z.enum(['markdown', 'html']),
  title: z.string().min(1).max(200).default('GMFT session report'),
  minSeverity: z.enum(['info', 'low', 'medium', 'high', 'critical']).default('medium'),
  outputPath: z.string().min(1),  // absolute path; chokepoint restricts to ~/.local/share/gmft/reports/
  includeInfo: z.boolean().default(false),  // override: include info findings even if minSeverity is higher
});
export type ReportWriteInputT = z.infer<typeof ReportWriteInput>;

export const ReportWriteOutput = z.object({
  written: z.boolean(),
  outputPath: z.string(),
  findingsIncluded: z.number().int().nonnegative(),
  bytesWritten: z.number().int().nonnegative(),
  format: z.enum(['markdown', 'html']),
});
```

**Chokepoint:** the `outputPath` is restricted to `~/.local/share/gmft/reports/`
by a new chokepoint rule `checkReportPath` (added in `rules.ts`). The rule
denies any path outside that directory, any path containing `..`, and any
symlink (resolved with `realpathSync`). The chokepoint also flags
`report_write` as `destructive` (it creates a file outside the session dir)
and `requiresElevation` only if the user has set the path to a system
location (we never do in v0.1 — the path is always under `~/.local/share`,
so `requiresElevation` is **not** in the flags).

**Selection sidecar:** the FindingsTab's per-finding checkboxes write to
`{baseDir}/{sessionId}.selections.json` (a simple `{ findingId: boolean }`
map). The `report_write` tool reads this sidecar at write time and only
includes findings whose id is `true` in the map. If the sidecar doesn't
exist, the tool falls back to "include everything that meets the severity
filter." This is a feature, not a bug — the operator can drive the report
from the UI, or just call `report_write` directly with no UI interaction.

### 3.2 FindingsTab rewrite

The current `apps/gmft/src/ui/tabs/FindingsTab.tsx` is a placeholder. The
rewrite:

- Reads findings from the session's `findings.jsonl` via a new
  `useFindings` hook (synchronous read on mount, refresh on a
  `findings-updated` event from the agent loop).
- Renders a scrollable list: `severity-badge tool target title`.
- Per-row `<Checkbox>` (ink primitive; we'll inline it as `[x]` / `[ ]`
  since ink has no built-in checkbox) toggles the selection sidecar.
- Key nav: `j/k` or arrow keys move the cursor; `space` toggles; `a`
  toggles all. No need for a full text-list primitive — we cap the
  rendered list to the visible viewport and let scroll handle overflow.
- A status line at the bottom: "12 of 34 findings selected · press `r` to
  write report" — the `r` key dispatches a slash command `/report` that
  triggers the existing `useAgent.handleSubmit` flow with a synthetic
  prompt of the form `write a report of this session's findings to
  /home/<user>/.local/share/gmft/reports/<sessionId>.md`.

### 3.3 Test budget (B)

- 3 `report_write` tests: markdown format, html format, severity filter
  + selection sidecar interaction (write sidecar → assert included set
  is filtered).
- 1 chokepoint test: `checkReportPath` denies paths outside the reports
  dir, denies `..`, denies a symlink that points outside.
- 3 FindingsTab tests: renders N findings, `space` toggles selection
  (assert sidecar file), `a` toggles all (assert sidecar file).

---

## 4. Feature A — Attack-chain orchestration

This is the most architecturally interesting feature. It is also the
smallest in raw LoC after the design is settled.

### 4.1 The `attack_chain` tool

```ts
// packages/tools/src/chain/attack-chain.ts (new chain/ subdir)
export const ChainStep = z.object({
  tool: z.string().min(1),
  args: z.record(z.unknown()),
  // optional: name the step for the UI + audit log
  name: z.string().min(1).max(64).optional(),
});

export const AttackChainInput = z.object({
  steps: z.array(ChainStep).min(1).max(20),
  // what to do if a step is denied by the chokepoint mid-chain
  stopOnDeny: z.boolean().default(true),
  // what to do if a step's `run` throws
  stopOnError: z.boolean().default(true),
});
export type AttackChainInputT = z.infer<typeof AttackChainInput>;

export const AttackChainOutput = z.object({
  totalSteps: z.number().int().positive(),
  completed: z.number().int().nonnegative(),
  denied: z.number().int().nonnegative(),
  erred: z.number().int().nonnegative(),
  stepResults: z.array(z.object({
    index: z.number().int().nonnegative(),
    tool: z.string(),
    name: z.string().optional(),
    status: z.enum(['ok', 'denied', 'erred', 'skipped']),
    durationMs: z.number(),
    findingCount: z.number().int().nonnegative(),
    reason: z.string().optional(),
  })),
});
```

**Flags:** `['destructive', 'requiresElevation']` + `typeToConfirm: 'attack'`.
The chain as a whole requires operator approval (because the chain is
destructive and elevated). Per-step `typeToConfirm` is **not** collapsed
— if a step's tool has `typeToConfirm: 'attack'`, the operator must type
`attack` again at that step (defense in depth: the chain approval covers
"this is a chain," the per-step approval covers "this specific action").

### 4.2 The `runInner` seam

The chain tool needs to invoke other tools from inside its own `run`. We
expose this as a new public function in the executor module — kept as a
function (not a class method) so the chain tool can call it without
holding a reference to the executor instance.

```ts
// packages/core/src/tools/executor.ts (additive, ~30 lines)

/** Options for `runInner`. Extends `ExecuteOpts` with chain-specific flags. */
export interface RunInnerOpts extends ExecuteOpts {
  /**
   * When true, the inner call's `typeToConfirm` rule is suppressed —
   * the chain's own outer approval (`attack_chain` has
   * `typeToConfirm: 'attack'`) covers the per-step type prompt. Plain
   * `confirm` (y/n) still fires; `checkDestructive` and `checkTarget`
   * still fire. Default: false.
   */
  suppressTypeToConfirm?: boolean;
}

/**
 * Run a tool from inside another tool's `run` (e.g. an `attack_chain`
 * step). Re-uses the same registry + chokepoint + ctx as the outer call.
 * The agent loop's existing call site (`runTurn` → `execute`) is
 * unchanged; `runInner` is the seam macro tools plug into.
 */
export async function runInner(
  tool: string,
  args: Record<string, unknown>,
  registry: ToolRegistry,
  chokepoint: Chokepoint,
  ctx: ToolContext,
  opts: RunInnerOpts = {},
): Promise<ExecuteResult>;
```

The `runInner` function is exposed to the chain tool via a new
`ToolContext` field `innerRunner: typeof runInner` (curried with the
outer call's registry/chokepoint/ctx so the chain tool doesn't have to
thread them). This keeps `@gmft/tools` from depending on
`@gmft/core`'s internals beyond the public types.

**Why public and not private:** future "macro" tools
(repeat-with-backoff, best-of-n, parallel-fan-out) plug into the same
hook. ~30 lines of code, naturally testable, single seam.

### 4.3 Chokepoint semantics for chains

The chokepoint's `checkElevation` and `checkTypeToConfirm` rules fire
once for the chain tool itself. Per-step tool calls go through
`runInner`, which:
- Does **not** re-check elevation (the chain's elevation flag covers it).
- Does **not** re-check `typeToConfirm` when `RunInnerOpts.suppressTypeToConfirm`
  is `true`. The chain's own `typeToConfirm: 'attack'` covers it.
- **Does** still check `checkDestructive` (so a step's destructive flag
  fires a plain y/n confirmation, even inside a chain).
- **Does** still check `checkTarget` (per-step target validation).

This is the rule set that emerged from the brainstorming session; it's
the minimum that preserves the "operator can deny a specific step"
property.

### 4.4 New `AgentEvent` variants

```ts
// packages/core/src/agent/loop.ts
export type AgentEvent =
  // ... existing variants
  | { type: 'chain-started'; chainId: string; stepCount: number }
  | { type: 'chain-step-started'; chainId: string; stepIndex: number; tool: string; name?: string }
  | { type: 'chain-step-finished'; chainId: string; stepIndex: number; status: 'ok' | 'denied' | 'erred' | 'skipped'; durationMs: number; findingCount: number; reason?: string }
  | { type: 'chain-finished'; chainId: string; totalSteps: number; completed: number; denied: number; erred: number };
```

The `useAgent` hook (in `apps/gmft/src/ui/hooks/useAgent.ts`) handles these
new variants and pushes them into a `chainState` ref. The TUI's right rail
(AuditDetail equivalent) shows the chain progress.

### 4.5 New UI: ChainPane

`apps/gmft/src/ui/components/ChainPane.tsx` — a new right-rail component
(visible when a chain is running). Renders the step list with status
badges (`ok` / `denied` / `erred` / `skipped` / `running`). Auto-scrolls
to the active step. No new deps.

### 4.6 Test budget (A)

- 6 `attack_chain` tests: happy path (3 steps, all ok), mid-chain deny
  (step 2 denied, step 3 skipped), mid-chain error (step 2 throws,
  step 3 skipped), `stopOnDeny: false` (continues on deny), per-step
  `name` field surfaces in output, `runInner` propagates findings to
  the session's `findings.jsonl`.
- 4 chokepoint integration tests: chain-level elevation covers per-step
  elevation, chain-level `typeToConfirm: 'attack'` covers per-step
  `typeToConfirm` when `suppressTypeToConfirm: true`, per-step
  `destructive` still prompts (y/n), per-step `target` validation still
  fires.
- 2 AgentEvent tests: `chain-started` / `chain-finished` events emitted
  with the right counts; `chain-step-started` / `chain-step-finished`
  emitted per step in order.
- 1 ChainPane test: renders 3 rows with the right status badges after
  receiving 3 events.

---

## 5. Feature D — Multi-target / scope-file support

### 5.1 The new `targetsFromFile` flag

Additive on `Tool<I,O>`:

```ts
// packages/core/src/tools/types.ts (additive)
export interface Tool<I extends z.ZodTypeAny, O extends z.ZodTypeAny> {
  // ... existing fields
  /**
   * v0.1 phase 6 — when true, the tool's `args.target` is a file path
   * (one target per line, `#` comments allowed). The executor reads
   * the file and invokes the tool once per target, accumulating
   * findings. The chokepoint sees the file path as the target for
   * the "is this a private network / on the denylist" check.
   */
  targetsFromFile?: boolean;
}
```

The first tool to use this is `nmap` (it already accepts a `target`
arg). The other 5 `targetRequired` tools (`dnsenum`, `theharvester`,
`nuclei`, `nikto`, `gobuster`, `ffuf`, `sqlmap`) opt in one at a time
in follow-up phases if/when the operator wants it. **Phase 6 ships the
mechanism + nmap as the only consumer.**

### 5.2 Executor loop

`packages/core/src/tools/executor.ts` gains:

```ts
async function executeWithScope(
  call: ExecuteCall,
  ctx: ToolContext,
  chokepoint: Chokepoint,
  registry: ToolRegistry,
  opts: ExecuteOpts,
): Promise<ExecuteResult> {
  const tool = registry.get(call.name);
  if (!tool?.targetsFromFile) {
    return execute(call, ctx, chokepoint, registry, opts);
  }
  // Read the file, split on newlines, drop blanks + comments
  const path = call.args.target as string;
  const targets = readTargetsFile(path);
  if (targets.length === 0) {
    return { ok: false, reason: `scope file "${path}" is empty`, decision: { kind: 'deny', reason: 'empty scope file' } };
  }
  // Run once per target, accumulate
  const perTargetResults: ExecuteResult[] = [];
  for (const t of targets) {
    const sub = await execute({ ...call, args: { ...call.args, target: t } }, ctx, chokepoint, registry, opts);
    perTargetResults.push(sub);
  }
  // Combine: ok if at least one succeeded, with the union of outputs
  return combineScopeResults(perTargetResults, targets);
}
```

**Chokepoint:** the per-target chokepoint check uses the looped
`target` value (not the file path), so the private-network + denylist
checks fire correctly per target. The file path itself is not
network-resolvable so it skips those checks naturally.

**Findings:** the loop appends a `{ tool, target: t, ... }` finding
per target run via the existing `FindingsStore` hook. The existing
`onToolResult` callback in the agent loop fires once per target so the
TUI's AuditLog shows N entries.

### 5.3 `readTargetsFile` helper

```ts
// packages/core/src/tools/scope.ts (new file)
export function readTargetsFile(path: string): string[] {
  // sync read; v0.1 scope files are small (<10k lines)
  const text = readFileSync(path, 'utf8');
  return text
    .split('\n')
    .map((l) => l.replace(/#.*$/, '').trim())  // strip comments
    .filter((l) => l.length > 0);
}
```

### 5.4 Test budget (D)

- 3 `executeWithScope` tests: empty file denies, 3-target file runs 3
  times and combines, denylist target mid-loop is denied and the
  combined result is `ok: true` with the 2 successful runs.
- 1 chokepoint test: scope file with a private-IP target denies that
  one target only; the others pass.
- 1 `readTargetsFile` test: comments + blank lines + trailing
  whitespace are stripped.

---

## 6. Test budget summary

| Feature | New tests | Cumulative |
|---------|-----------|------------|
| (start) | 0         | 288        |
| C       | ~6        | ~294       |
| B       | ~7        | ~301       |
| A       | ~13       | ~314       |
| D       | ~5        | ~319       |

The implementation plan will lock the exact count and name each test.
The contract: **zero new failures, zero svelte-check errors, zero tsc
errors** at the end of each feature.

---

## 7. Dependencies and ordering inside the branch

```
C ──► B ──► A ──► D
│     │     │     │
│     │     │     └── depends on: A's per-step findings
│     │     └── depends on: B's report_write can be the "last step"
│     │                   of a chain (so the FindingsTab → /report
│     │                   flow chains naturally)
│     └── depends on: C (just to keep the wifi family complete
│                       when the report includes a wifi finding)
└── independent
```

Per the table in §1, the implementation order is C → B → A → D. Each
feature lands as one or more commits with passing tests before the next
begins. The PR body groups the diffs as C / B / A / D sections for
reviewability.

---

## 8. Risks and mitigations

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| `runInner` seam turns into a god-object (every macro tool grabs it) | medium | document the seam in `executor.ts`; cap at 5 callers; if exceeded, promote to a `MacroToolContext` interface |
| Chain's `suppressTypeToConfirm: true` accidentally suppresses a per-step prompt the operator wanted | low | the `typeToConfirm` is still in the per-step tool's flags; the executor logs a warning when it suppresses; the audit log records the suppression explicitly |
| Scope file is huge (100k targets) and the loop is too slow | low | v0.1 caps `readTargetsFile` at 10k lines (throws otherwise); 10k nmap scans is already a multi-day engagement |
| FindingsTab rewrite breaks the existing `useFindings` test | low | the new FindingsTab is a drop-in replacement; the existing test asserts only "renders N findings" and continues to pass |
| Report writer is slow for large finding sets | low | markdown is generated in a single string concat; HTML uses a tagged template; both O(n) in finding count. For 1000 findings, both are sub-100ms. |
| `attack_chain` is too powerful — an LLM could be tricked into running a 20-step chain | low | the chain is operator-confirmed (`typeToConfirm: 'attack'` + destructive + elevated); the LLM can't bypass it; the audit log records the full step list before the first step runs |

---

## 9. Non-goals (deferred to later phases)

- **D2. Top-level `scope: string[]` on `ChokepointCall`** — would replace
  the per-tool `target` arg. Cleaner long-term but a breaking change to
  the chokepoint's contract. Deferred to v0.2 with an ADR when we
  actually need it. **Phase 6 ships D1 only.**
- **Cross-chain findings correlation** (e.g. "this SQLi was discovered
  by the nmap + nikto chain, not the nikto alone") — out of scope. The
  `Finding` model already has `tool` and `target`; correlation can come
  later via a `chain_id` field if/when needed.
- **HTML report with embedded screenshots / interactive findings** —
  markdown only this phase. HTML is a static table; no JS, no images.
- **Chain DSL** (YAML/TOML files that describe a chain) — out of scope.
  Phase 6 chains are operator-defined at runtime via the chat ("recon
  scanme.nmap.org, then nikto, then nuclei"). The LLM translates
  natural language to an `attack_chain` invocation. If operators want
  to define chains in files later, the `AttackChainInput` schema is the
  file format.
- **More wifi tools beyond deauth + wifite** — out of scope. The
  family has 3 tools (evil_twin + deauth + wifite) after phase 6. Adding
  more is its own phase if/when the operator asks.

---

## 10. Success criteria

Phase 6 is done when **all** of the following hold:

1. `pnpm -r test` is green at the end of each feature (C, B, A, D
   individually). Cumulative count is in §6.
2. `pnpm -r typecheck` is clean (no tsc errors, no svelte-check errors).
3. The CHANGELOG has a new entry per feature (consistent with the
   per-phase entries in phase 3 / 4 / 5).
4. The PR body groups the diffs as C / B / A / D sections.
5. A new `v0.1.0-phase6` tag is pushed.
6. The 4 design ADRs (one per feature, explaining the chosen approach
   over the alternatives) are in `docs/superpowers/adr/` — the
   brainstorming alternatives in this spec are the ADR bodies.
7. `attack_chain` works end-to-end: a chat prompt "recon scanme.nmap.org,
   then nikto, then nuclei" produces a chain the operator can watch run
   in the ChainPane with per-step status + findings flowing to the
   FindingsTab.
8. `report_write` works end-to-end: running the chain above, ticking
   3 findings in the FindingsTab, pressing `r`, produces a markdown file
   at `~/.local/share/gmft/reports/<sessionId>.md` containing exactly
   those 3 findings.
9. `wifi_deauth` and `wifite_scan` work end-to-end (in `GMFT_DRY=1`
   mode) — the chokepoint prompts `type-to-confirm: 'attack'`, the
   runner reports a fake duration, and the output is Zod-valid.

If any of (1)-(9) fails, the phase is not done. No partial credit.
