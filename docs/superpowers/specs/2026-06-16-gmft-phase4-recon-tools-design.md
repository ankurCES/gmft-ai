# Phase 4 — Network & OSINT recon tools

> Companion to §4 of the v0.1 master plan (`docs/plans/2026-06-08-gmft-ai-v0.1.md`).
> This spec brings the master plan forward into the current codebase, locks the design
> decisions, and is the contract for the implementation plan that follows.

**Goal:** Four read-only recon tools (nmap, dnsenum, theharvester, whatweb) ship as
real, registered `Tool<I,O>` implementations. The agent loop is wired so the LLM can
actually call them via `useAgent` → `runTurn` with `tools` + `chokepoint` + a working
streaming helper. A `Finding` model + persistent findings store + a populated
`FindingsTab` close the loop: ask "recon `scanme.nmap.org`", watch the chat stream,
the Findings tab fills with structured results. A network Docker image ships (so the
runner can sandbox the binaries) and the existing chokepoint gates everything with
`targetRequired` + a `destructive=false` allow.

**Why this phase exists:** §3 (tool catalog) + §4.4 (phase 4 plan) + §6 (threat model) of
the master v0.1 plan. Phase 3 shipped the spine (chokepoint, tool registry, executor,
`shell_exec`); the TUI is wired for `onConfirmation`. But `useAgent` and `AgentApp`
never actually pass `tools`/`chokepoint` to `runTurn`, so the LLM cannot call any tool
yet. Phase 4 fixes the wiring AND ships the first four real recon tools.

**Test budget:** 8 new tests (4 tool fixture tests, 1 streaming test, 1 findings-store
test, 1 useAgent-tools-wiring test, 1 findings-tab test). 233 → **241** passing.

**Tech stack:** TypeScript ESM, vitest 2.1, ink-testing-library 4.0, ai SDK 4.3.19. No
new top-level deps. `zod` is already a transitive dep. The new tools run through the
existing `@gmft/core` `Tool<I,O>` shape and the existing `@gmft/tools` `run` runner
+ `assertBinary` prereq helper — same pattern as `shell_exec`.

**Branch / worktree:** `phase4-recon-tools` cut from `main` HEAD `da6ee31` (post-PR #1
merge). Worktree at `/home/ankur/test/test-mob/gmft-ai/.worktrees/phase4-recon-tools`.

---

## What this phase ships

1. **Findings model** in `@gmft/core/findings` — typed `Finding` (id, tool, target,
   severity, title, description, evidence, ts) + `FindingsStore` (in-memory +
   JSONL-on-disk at `~/.local/share/gmft/findings/<sessionId>.jsonl`, append-only,
   redacted like the session log). Re-exports through `@gmft/core`'s barrel.
2. **Streaming helper** in `@gmft/tools/shared/stream.ts` — `spawnStreaming(cmd, args,
   onStdout, onStderr): Promise<{exitCode, durationMs}>`. Wraps `node:child_process.spawn`
   with stream listeners. Used by `nmap` and (later) `nuclei`. Distinct from the existing
   `run` (which buffers stdout); streaming is for tools that emit enough output that the
   chat should see it live.
3. **Four new tools** in `@gmft/tools/network/`:
   - `nmap.ts` — `nmap -oX - <target>` + tiny XML parser. Output: `{ xml, hosts[], durationMs }`.
   - `dnsenum.ts` — `dnsenum --noreverse -o - <domain>` (forced `-o -` for stdout).
     Output: `{ records, nameservers, mx }`.
   - `theharvester.ts` — `theHarvester -d <domain> -b <sources> -l <limit> -f -`. Output:
     `{ emails[], hosts[], urls[] }`.
   - `whatweb.ts` — `whatweb --no-errors -q --log-json=- <url>`. Output: `{ technologies[] }`.
   All four register with `category: 'recon'`, `flags: ['targetRequired']` (NOT
   destructive, NOT elevation-required). Chokepoint will require a target + format
   check + private-network denylist as the master plan prescribes.
4. **Network Docker image** — `docker/Dockerfile.network` extending `alpine:3.20` with
   `nmap bind-tools theharvester whatweb perl`. Tagged `gmft/network:0.1`. Runner uses
   this as the `image` for the four tools. Host-fallback works (host must have the
   binaries installed).
5. **`useAgent` + `AgentApp` wiring fix** — `useAgent` now accepts `tools` +
   `chokepoint` + `onConfirmation` opts and threads them to `runTurn`. `AgentApp`
   constructs a `ToolRegistry` from `@gmft/tools`'s `tools` array, builds a
   `createChokepoint(...)` from `cfg.chokepoint`, and passes both. The TUI then
   actually has an LLM that can call tools.
6. **`FindingsTab` upgrade** — no longer a placeholder. Subscribes to the agent loop's
   `tool-result` events; for any `result.findings: Finding[]` it appends to the
   `FindingsStore` and re-renders the table (target, severity, title, tool). StatusRail
   `findings` count goes up live.
7. **System prompt delta** — one paragraph added instructing the model to "emit one
   `Finding` per discovered service/host/email" by returning `{ findings: [...] }` in
   the tool's structured output. Tools already include a `findings` field in their
   Zod output schemas.
8. **CHANGELOG entry** for `0.1.0-phase4`. Tag `v0.1.0-phase4`.

---

## What this phase does NOT ship

- No destructive tools (sqlmap is phase 5).
- No elevation-gated tools (evil-twin is phase 5).
- No reports (markdown/json/pdf rendering is phase 6).
- No findings-export slash command (`/report` is phase 6).
- No `target` CLI flag (`--target <host>` is phase 6 task 6.7).
- No `gmft-cli` binary update (the in-TUI `FindingsTab` is the surface for now).
- No live integration tests against `scanme.nmap.org` in CI (the `runner` requires
  Docker; the test fixture uses pre-recorded XML output).

---

## File map

### New files
- `packages/core/src/findings/index.ts` — `Finding` type + `Severity` union + zod schema
- `packages/core/src/findings/store.ts` — `FindingsStore` class (in-memory + JSONL persistence)
- `packages/tools/src/shared/stream.ts` — `spawnStreaming(cmd, args, callbacks)`
- `packages/tools/src/network/nmap.ts` — `nmapTool`
- `packages/tools/src/network/dnsenum.ts` — `dnsenumTool`
- `packages/tools/src/network/theharvester.ts` — `theHarvesterTool`
- `packages/tools/src/network/whatweb.ts` — `whatwebTool`
- `packages/tools/src/network/index.ts` — barrel
- `docker/Dockerfile.network` — alpine + recon binaries
- `packages/core/test/findings.test.ts` — store CRUD + JSONL roundtrip
- `packages/tools/test/network/nmap.test.ts` — fixture + parse
- `packages/tools/test/network/dnsenum.test.ts` — fixture + parse
- `packages/tools/test/network/theharvester.test.ts` — fixture + parse
- `packages/tools/test/network/whatweb.test.ts` — fixture + parse
- `packages/tools/test/shared/stream.test.ts` — long-output cmd fires callback multiple times
- `apps/gmft/test/useAgent-tools.test.tsx` — useAgent forwards tools+chokepoint to runTurn
- `apps/gmft/test/findings-tab.test.tsx` — FindingsTab renders store contents

### Modified files
- `packages/core/src/index.ts` — re-export `findings/`; bump `VERSION` to `'0.1.0-phase4'`
- `packages/tools/src/index.ts` — re-export `network/` and `shared/stream`
- `packages/tools/src/catalog.ts` — append the 4 recon tools to the `tools` array
- `apps/gmft/src/ui/hooks/useAgent.ts` — accept `tools`/`chokepoint`/`onConfirmation` opts
- `apps/gmft/src/AgentApp.tsx` — build `ToolRegistry` + `createChokepoint`; pass to `useAgent`;
  subscribe to `tool-result` events; append to `FindingsStore`; render `FindingsTab` from store
- `apps/gmft/src/ui/tabs/FindingsTab.tsx` — real table view (sortable columns: target, severity, title, tool, ts)
- `packages/core/src/llm/prompts.ts` — one paragraph: "return `{ findings: [...] }` from recon tools"
- `CHANGELOG.md` — new `0.1.0-phase4` entry

---

## Design decisions (push back if you disagree)

### 1. Tools are `recon` category, `targetRequired` only — not `destructive`, not `elevation-required`

The master plan (§3 catalog) and ADR-0006 (chokepoint-first) both agree: a port-scan
is read-only. The chokepoint's `checkTarget` rule already gates the target format +
private-network denylist. We do NOT need a Confirm prompt for these tools. The
`<ApprovalPrompt>` is reserved for the phase 5 sqlmap/evil-twin work.

This means `nmap` cannot, by configuration, do `nmap --script=exploit` style things
— it would have to be a separate tool if added later. Phase 4 = the safe, read-only
subset. Documented in the tool's `description` and in the CHANGELOG.

### 2. `useAgent` opts are additive — existing tests pass unchanged

`useAgent` already accepts `{ system, initialHistory, runTurn, onError }`. We add
`tools?`, `chokepoint?`, `onConfirmation?` as **optional** fields. When they're
absent, `useAgent` runs in phase 2 mode (no tool calls), which is the existing test
contract. The 3 existing `useAgent.test.tsx` cases continue to pass without edits.

The `runTurn` opt's type signature is the structural one from the existing file —
`tools`/`chokepoint`/`onConfirmation` are only forwarded when present. We do not
tighten the type; we widen it.

### 3. Findings come BACK through the tool's structured output, not as a side-channel

We considered an event bus (`bus.emit('finding', f)`) but the AI SDK's tool-result
chunk already carries structured data — putting `findings: Finding[]` in the
Zod output schema means the model "sees" the findings, can reason over them, and
can summarize them in its reply. This is the cleanest seam: the tool returns
*everything* the model needs.

The system prompt's new paragraph tells the model: "After running a recon tool, the
tool returns `{ findings: Finding[] }`. Surface the high-severity findings in your
reply."

### 4. `FindingsStore` is append-only JSONL, redacted like the session log

Phase 6 will need a `readAll(findingsDir, sessionId)` for `/report`. Building the
JSONL-on-disk model now means phase 6 is purely a read path — no schema migration.

`~/.local/share/gmft/findings/<sessionId>.jsonl` — one JSON object per line, trailing
`\n` (the same read_line-trailing-newline rule from blackglass that bit us in
phase 1.5g). Reuses the redactor from `@gmft/core/session/log.js`.

### 5. No live `scanme.nmap.org` test in CI

`GMFT_LIVE_TESTS=1` will exist for manual + future CI, but the default test
suite uses pre-recorded fixture files in `packages/tools/test/network/fixtures/`.
The fixtures are committed; the `runner` is bypassed by mocking the `run` function
in the test (the same pattern `shell-exec.test.ts` uses).

### 6. Docker image is `gmft/network:0.1`, alpine + apk

We could use the existing `alpine:3.20` image and `apk add` at container start
inside the tool. That would be cheaper (no rebuild needed) but slower per-invocation
(apt mirror roundtrip). For a v0.1 tool the image-build approach is fine — the
image is ~200 MB, built once, cached by Docker.

The runner accepts an `image` override, so `nmapTool` passes `image: 'gmft/network:0.1'`
explicitly. Phase 5 web tools will do the same with `gmft/web:0.1`.

### 7. XML parsing is hand-rolled (no extra dep)

`nmap -oX -` emits ~50 KB of XML for a typical scan. The relevant fields (host,
address, ports/port, state, service name) are a small subset. A 60-line
`parseNmapXml` function with regex + state machine handles it. We considered
`fast-xml-parser` (already a transitive of `pnpm`) but adding it as a direct
dep is scope creep for 4 tool definitions. Documented in the tool's source
comment as "v0.1 = hand-rolled; revisit if nmap -sV output needs DOM-level fidelity."

### 8. FindingsTab is sortable, not paginated

Phase 4's expected finding count is <100 for a single recon session. Sortable
by severity / target / tool. Pagination is phase 6.

---

## Component shapes (sketch — full code in the implementation plan)

### `Finding` type

```ts
// packages/core/src/findings/index.ts
import { z } from 'zod';

export const SeveritySchema = z.enum(['info', 'low', 'medium', 'high', 'critical']);
export type Severity = z.infer<typeof SeveritySchema>;

export const FindingSchema = z.object({
  id: z.string(),                          // ulid
  tool: z.string(),                        // 'nmap', 'dnsenum', etc.
  target: z.string(),                      // what we scanned
  severity: SeveritySchema,
  title: z.string(),                       // 'Open port 22/tcp (ssh)'
  description: z.string().optional(),      // 1-2 sentences
  evidence: z.string().optional(),         // raw tool output snippet
  ts: z.number().int(),                    // epoch ms
});
export type Finding = z.infer<typeof FindingSchema>;
```

### `nmapTool` input/output

```ts
// packages/tools/src/network/nmap.ts (sketch)
import { z } from 'zod';
import type { Tool, ToolContext } from '@gmft/core';
import { run } from '../shared/runner';
import { FindingSchema, type Finding } from '@gmft/core';

export const NmapInput = z.object({
  target: z.string().describe('Hostname or IPv4 to scan'),
  ports: z.string().optional().describe('e.g. "22,80,443" or "1-1024"'),
  scripts: z.string().optional().describe('nmap --script argument'),
  timing: z.enum(['T0', 'T1', 'T2', 'T3', 'T4', 'T5']).default('T4'),
});

export const NmapOutput = z.object({
  xml: z.string(),
  hosts: z.array(z.object({
    address: z.string(),
    hostname: z.string().optional(),
    ports: z.array(z.object({
      port: z.number().int(),
      protocol: z.string(),
      state: z.string(),
      service: z.string().optional(),
    })),
  })),
  findings: z.array(FindingSchema),
  durationMs: z.number().int().nonnegative(),
  mode: z.enum(['docker', 'host']),
  fellBack: z.boolean(),
});

export const nmapTool: Tool<typeof NmapInput, typeof NmapOutput> = {
  name: 'nmap',
  category: 'recon',
  description: 'TCP port scan via nmap. Read-only; chokepoint gates the target format + private-network denylist.',
  input: NmapInput,
  output: NmapOutput,
  flags: ['targetRequired'],
  async run(input, ctx) {
    const argv = [
      'nmap', '-oX', '-',
      ...(input.ports ? ['-p', input.ports] : []),
      ...(input.scripts ? ['--script', input.scripts] : []),
      `-${input.timing}`,
      input.target,
    ];
    const r = await run({ argv, image: 'gmft/network:0.1', timeoutMs: 120_000 });
    const { hosts, findings } = parseNmapXml(r.stdout, input.target);
    return { xml: r.stdout, hosts, findings, durationMs: r.durationMs, mode: r.mode, fellBack: r.fellBack };
  },
};
```

### `useAgent` opts delta

```ts
// apps/gmft/src/ui/hooks/useAgent.ts (sketch)
export interface UseAgentOpts {
  system: string;
  initialHistory?: readonly ChatMessage[];
  runTurn: (args: {
    system: string;
    history: readonly ChatMessage[];
    signal?: AbortSignal;
    tools?: ReadonlyArray<{ name: string; /* ... */ }>;
    chokepoint?: { decide: (c: unknown) => unknown };
    onConfirmation?: (c: { id: string; name: string; args: Record<string, unknown>; reason: string }) => Promise<boolean>;
  }) => AsyncIterable<AgentEvent>;
  onError?: (err: Error) => void;
  tools?: ReadonlyArray<{ name: string }>;
  chokepoint?: { decide: (c: unknown) => unknown };
  onConfirmation?: (c: { id: string; name: string; args: Record<string, unknown>; reason: string }) => Promise<boolean>;
  onToolResult?: (r: { name: string; output: unknown }) => void;  // NEW: for FindingsTab
}
```

### `FindingsTab` table view

```tsx
// apps/gmft/src/ui/tabs/FindingsTab.tsx (sketch)
export function FindingsTab({ store, theme }: { store: FindingsStore; theme: Theme }) {
  const findings = store.list(); // sorted by severity desc, then ts desc
  if (findings.length === 0) {
    return <EmptyState message="No findings yet. Run a recon tool from the chat to see results here." />;
  }
  return (
    <Box flexDirection="column">
      <Header columns={['severity', 'tool', 'target', 'title', 'ts']} />
      {findings.map((f) => <FindingRow key={f.id} f={f} theme={theme} />)}
    </Box>
  );
}
```

---

## Acceptance criteria

- [ ] `nmap --version` runs in the runner and the output is parsed into `hosts[]` + `findings[]`
- [ ] `nmap -p 22,80,443 -T4 scanme.nmap.org` produces ≥ 1 finding for an open port (live, manual)
- [ ] `dnsenum --noreverse -o - example.com` returns `records[]` + `nameservers[]` + `mx[]` + `findings[]`
- [ ] `theHarvester -d example.com -b google -l 100 -f -` returns `emails[]` + `hosts[]` + `urls[]` + `findings[]`
- [ ] `whatweb --no-errors -q --log-json=- https://example.com` returns `technologies[]` + `findings[]`
- [ ] `nmapTool` is registered in `@gmft/tools/catalog.ts` with `category: 'recon'`, `flags: ['targetRequired']`
- [ ] `FindingsStore` writes JSONL, reads back identical, redacts API keys
- [ ] `useAgent` with `tools: [...]` actually calls `runTurn` with those tools (test verifies via mocked `runTurn` capturing the args)
- [ ] `FindingsTab` renders `store.list()` sorted by severity desc
- [ ] `pnpm -r test` is green end-to-end (241 tests)
- [ ] `pnpm -r typecheck` is green
- [ ] `docker build -f docker/Dockerfile.network -t gmft/network:0.1 .` succeeds
- [ ] CHANGELOG entry for `0.1.0-phase4` written. Tag `v0.1.0-phase4` created.
- [ ] The 233 prior tests still pass — no regressions in `chokepoint`, `tools-registry`, `tools-executor`, `shell-exec`, `agent-loop`, or the TUI.

---

## Risk register

| Risk | Mitigation |
|---|---|
| `useAgent` opts widening breaks existing tests | Make all 3 new opts optional. Existing tests don't pass them → behavior identical. |
| Hand-rolled nmap XML parser misses real-world edge cases | Tests use a recorded fixture (committed). Document the supported subset in the parser's source comment. |
| `dnsenum` flag set varies between distros | Use the most-portable subset: `--noreverse -o -`. Fall back to a friendlier `dig` wrapper if `dnsenum` is missing? **No** — fail loudly. The chokepoint already errors on bad input. |
| `theHarvester` Python tooling not in alpine | `Dockerfile.network` adds `python3 py3-pip git` + `pip install theHarvester`. Verify in `docker build`. |
| `whatweb --log-json` output is JSONL not single JSON | Stream it line-by-line in `parseWhatwebOutput`. Each line is a `Target` object. |
| Findings count grows unbounded across sessions | `FindingsStore.list(opts?: { sinceMs?: number })` lets the UI cap. No hard cap yet. |
| Docker image build adds CI time | Phase 4 build is local-only; CI runs the unit tests which mock `run`. |

---

## Out-of-scope (deferred to phase 5/6)

- `/report` slash command + PDF rendering (phase 6)
- `--target <host>` CLI flag (phase 6)
- High-friction destructive tools: sqlmap, evil-twin (phase 5)
- Web vuln tools: nuclei, nikto, gobuster, ffuf (phase 5)
- Live `scanme.nmap.org` integration test in CI (post-v0.1)
- `target` field on `StatusInfo` (already present, not used) — wired up in phase 6
- Findings export to JSON/MD/PDF (phase 6)
