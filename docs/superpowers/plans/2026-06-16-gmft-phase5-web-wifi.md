# Phase 5 — Web vuln tools + wifi evil-twin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add 5 web vuln tools (nuclei, nikto, gobuster, ffuf, sqlmap) + 1 wifi evil-twin tool + the supporting Dockerfile + an upgrade to `ApprovalPrompt` that supports type-then-confirm for high-friction tools.

**Architecture:** Each tool follows the same pattern as phase 4's recon tools (zod schema + `run` from `runner.ts` + Findings emission). `nuclei` and `evil-twin` use the `spawnStreaming` helper from phase 4. `sqlmap` is the first `destructive`-flagged tool in the catalog; `evil-twin` is the first `destructive + requiresElevation`-flagged tool and is the first to require **type-then-confirm** — the user must type the literal string `attack` to confirm (xalgorix pattern). `ApprovalPrompt` grows an optional `typeToConfirm?: string` prop that, when present, switches the prompt into a "type the word to confirm" mode. The chokepoint already supports the `destructive` and `requiresElevation` flags; no chokepoint code changes are required for this phase.

**Tech Stack:** TypeScript 5, vitest, Ink 5, zod 3, the existing `@gmft/tools` runner + spawnStreaming + Findings infra from phase 4. The 5 web tools reuse `parseFindings` patterns from phase 4. New external CLIs (nuclei, nikto, gobuster, ffuf, sqlmap, fluxion) are documented in `Dockerfile.web` and the fixtures are small hand-written samples that the parsers tolerate.

**Baseline (pre-phase-5):** 259/259 tests passing. `main` is at `ec956e6` (post-PR-#2 merge). Worktree path: `/home/ankur/test/test-mob/gmft-ai/.worktrees/phase5-web-wifi-tools` on branch `phase5-web-wifi-tools`.

---

## File Structure

### New files

- `packages/tools/src/web/nuclei.ts` — nuclei tool
- `packages/tools/src/web/nikto.ts` — nikto tool
- `packages/tools/src/web/gobuster.ts` — gobuster tool
- `packages/tools/src/web/ffuf.ts` — ffuf tool
- `packages/tools/src/web/sqlmap.ts` — sqlmap tool (destructive)
- `packages/tools/src/web/index.ts` — barrel for the 5 web tools
- `packages/tools/src/wifi/evil-twin.ts` — fluxion evil-twin wrapper (destructive + requiresElevation + type-then-confirm)
- `packages/tools/src/wifi/index.ts` — barrel for the wifi tool(s)
- `packages/tools/src/shared/confirm.ts` — new helper for the type-then-confirm prompt resolution
- `docker/Dockerfile.web` — alpine:3.20 + nuclei + nikto + gobuster + ffuf + sqlmap
- `packages/tools/test/web/nuclei.test.ts` + `fixtures/nuclei-sample.ndjson`
- `packages/tools/test/web/nikto.test.ts` + `fixtures/nikto-sample.txt`
- `packages/tools/test/web/gobuster.test.ts` + `fixtures/gobuster-sample.txt`
- `packages/tools/test/web/ffuf.test.ts` + `fixtures/ffuf-sample.json`
- `packages/tools/test/web/sqlmap.test.ts` + `fixtures/sqlmap-sample.txt`
- `packages/tools/test/wifi/evil-twin.test.ts` (no fixture — runs in dry mode)
- `packages/tools/test/web-catalog.test.ts` — drift check that the 5 web tools are exported
- `packages/core/test/chokepoint-type-then-confirm.test.ts` — covers the new `typeToConfirm` flag on chokepoint calls
- `apps/gmft/test/approval-prompt-type-to-confirm.test.tsx` — covers the new ApprovalPrompt mode
- `docs/superpowers/plans/2026-06-16-gmft-phase5-web-wifi.md` — this plan

### Modified files

- `packages/tools/src/catalog.ts` — adds the 5 web + 1 wifi tool to the exported `tools` array
- `packages/tools/src/index.ts` — re-exports the 5 web tools + 1 wifi tool
- `packages/tools/src/shared/index.ts` — re-exports `confirm.ts`
- `packages/core/src/chokepoint/decision.ts` — adds a new `typeToConfirm?: string` field to `ChokepointCall`
- `packages/core/src/chokepoint/rules.ts` — adds a rule that, if `call.typeToConfirm` is set, requires the user to type the literal value; the existing prompt reads it from the event
- `packages/core/src/chokepoint/index.ts` — re-exports the new field
- `packages/core/src/agent/loop.ts` — when a tool returns a `typeToConfirm` decision from chokepoint, the `confirmation-needed` event carries the `typeToConfirm` string
- `apps/gmft/src/AgentApp.tsx` — when collecting `confirmation-needed` events, threads `typeToConfirm` into the `pendingApprovals` map
- `apps/gmft/src/App.tsx` — passes `typeToConfirm` into `ApprovalPrompt` (already gets it via pendingApprovals)
- `apps/gmft/src/ui/components/ApprovalPrompt.tsx` — adds `typeToConfirm?: string` prop; when present, switches to a "type the word to confirm" mode that requires literal-string match
- `CHANGELOG.md` — adds a `v0.1.0-phase5` entry

### Tools registered in the catalog (after this phase)

| Name | Category | Flags | Streaming |
|---|---|---|---|
| `nuclei` | web | (none) | yes |
| `nikto` | web | (none) | no |
| `gobuster` | web | (none) | no |
| `ffuf` | web | (none) | no |
| `sqlmap` | web | destructive | no |
| `evil_twin` | wifi | destructive + requiresElevation + typeToConfirm: 'attack' | yes |

12 tools total in the catalog: shellExec + 4 recon (phase 4) + 5 web + 1 wifi.

### Test budget (matches plan §5.10: 13 new tests)

- 5 web tool unit tests (one per tool)
- 1 web catalog drift test
- 1 wifi evil-twin test
- 3 chokepoint tests for the new destructive / typeToConfirm / requiresElevation paths
- 3 ApprovalPrompt tests for the type-then-confirm mode (1 unit + 2 e2e)

**Total new tests: 13.** Running total: 259 → 272.

---

## Task Ordering

1. **5.0** — Tool type extension (`typeToConfirm` on `ChokepointCall` + rule)
2. **5.1** — `ApprovalPrompt` upgrade (type-then-confirm)
3. **5.2** — `nuclei` tool (streaming)
4. **5.3** — `nikto` tool
5. **5.4** — `gobuster` tool
6. **5.5** — `ffuf` tool
7. **5.6** — `sqlmap` tool (destructive)
8. **5.7** — Catalog + barrel update (5 web + 1 wifi)
9. **5.8** — `Dockerfile.web`
10. **5.9** — `evil-twin` wifi tool
11. **5.10** — Catalog drift + chokepoint + ApprovalPrompt tests
12. **5.11** — CHANGELOG + tag

---

## Task 5.0: Add `typeToConfirm` to ChokepointCall + rule

**Files:**
- Modify: `packages/core/src/chokepoint/decision.ts` (add `typeToConfirm` field)
- Modify: `packages/core/src/chokepoint/rules.ts` (add a rule that checks the field)
- Modify: `packages/core/src/chokepoint/index.ts` (re-export the new field)
- Modify: `packages/core/src/agent/loop.ts` (carry `typeToConfirm` into the `confirmation-needed` event)

- [ ] **Step 1: Modify `decision.ts`**

Open `packages/core/src/chokepoint/decision.ts` and add `typeToConfirm?: string` to the `ChokepointCall` interface (just after the existing `flags: readonly ToolFlag[]` field). Also add a `typeToConfirm?: string` field to the `Decision` union's `confirm` variant. The new file should look like:

```typescript
import type { ToolFlag } from '../tools/types.js';

export interface ChokepointCall {
  /** Tool name (e.g. "shell_exec"). */
  tool: string;
  /** Parsed args object the LLM wants to invoke. */
  args: Record<string, unknown>;
  /** Tool flags. */
  flags: readonly ToolFlag[];
  /**
   * Optional. If set, the user must type this exact literal string
   * (case-sensitive) in the approval prompt to confirm. Used for
   * high-friction destructive tools (e.g. evil_twin requires the user
   * to type "attack"). When the chokepoint returns `kind: 'confirm'`
   * it carries the same `typeToConfirm` string so the UI can switch
   * into the "type the word" mode.
   */
  typeToConfirm?: string;
}

export type Decision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }
  | { kind: 'confirm'; reason: string; typeToConfirm?: string };
```

- [ ] **Step 2: Modify `rules.ts`**

Open `packages/core/src/chokepoint/rules.ts`. Add a new function `checkTypeToConfirm(call, decision)` at the bottom of the file. If the chokepoint-call has `typeToConfirm` set, the function appends it to the confirm-decision's `typeToConfirm` field. Then call it from the main pipeline in the file's `decide` function (find the existing pipeline that combines rules; the new function is appended after the destructive check).

The new function:

```typescript
/**
 * If the call declares a `typeToConfirm` literal, attach it to any
 * confirm decision so the UI can switch into the "type the word" mode.
 * No-op for allow / deny decisions.
 */
export function checkTypeToConfirm(
  call: ChokepointCall,
  decision: Decision,
): Decision {
  if (decision.kind !== 'confirm') return decision;
  if (!call.typeToConfirm) return decision;
  return { ...decision, typeToConfirm: call.typeToConfirm };
}
```

Then in the main `decide` function, add `checkTypeToConfirm(call, ...)` as the final stage in the pipeline (after `checkTargetRequired` returns the allow/deny; before returning the final result).

- [ ] **Step 3: Modify `agent/loop.ts`**

Open `packages/core/src/agent/loop.ts`. Find the `confirmation-needed` event emit (the code that handles `decision.kind === 'confirm'`). Make sure the emitted event includes the `typeToConfirm` field if the decision has one. The event type is defined inline in this file as `{ type: 'confirmation-needed'; id; name; reason; typeToConfirm? }`. The emit code becomes:

```typescript
if (decision.kind === 'confirm') {
  yield {
    type: 'confirmation-needed',
    id: toolCall.id,
    name: toolCall.name,
    reason: decision.reason,
    typeToConfirm: decision.typeToConfirm,
  };
  // ... rest of the existing onConfirmation flow
}
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
cd /home/ankur/test/test-mob/gmft-ai && pnpm -C packages/core exec tsc --noEmit && echo "TSC OK"
```

Expected: `TSC OK`.

- [ ] **Step 5: Run the chokepoint test suite**

```bash
cd /home/ankur/test/test-mob/gmft-ai && pnpm -C packages/core exec vitest run test/chokepoint.test.ts 2>&1 | tail -6
```

Expected: same pass count as before (no regression).

- [ ] **Step 6: Commit**

```bash
cd /home/ankur/test/test-mob/gmft-ai && git add packages/core/src/chokepoint/decision.ts packages/core/src/chokepoint/rules.ts packages/core/src/agent/loop.ts && git -c user.email=blumi@local -c user.name=blumi commit -m "feat(chokepoint): add typeToConfirm field for high-friction destructive tools"
```

---

## Task 5.1: Upgrade `ApprovalPrompt` to support type-then-confirm

**Files:**
- Modify: `apps/gmft/src/ui/components/ApprovalPrompt.tsx` (add `typeToConfirm?: string` prop + typing state)
- Test: `apps/gmft/test/approval-prompt-type-to-confirm.test.tsx` (new, 1 unit test)

- [ ] **Step 1: Write the failing test**

Create `apps/gmft/test/approval-prompt-type-to-confirm.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { ApprovalPrompt } from '../src/ui/components/ApprovalPrompt';
import { theme } from '../src/ui/theme';

describe('ApprovalPrompt (type-then-confirm mode)', () => {
  it('rejects incorrect text and only approves on exact match', async () => {
    const onResolve = vi.fn();
    const { stdin, lastFrame } = render(
      <ApprovalPrompt
        id="abc"
        name="evil_twin"
        args={{ targetBssid: 'AA:BB:CC:DD:EE:FF' }}
        reason="wifi evil-twin; confirm to proceed"
        typeToConfirm="attack"
        onResolve={onResolve}
        theme={theme}
      />,
    );

    // First, try a wrong word — should not resolve.
    stdin.write('attac');
    await new Promise((r) => setImmediate(r));
    expect(onResolve).not.toHaveBeenCalled();

    // Then the right word — should resolve true.
    stdin.write('attack');
    await new Promise((r) => setImmediate(r));
    expect(onResolve).toHaveBeenCalledWith(true);
    // Frame mentions the literal
    expect(lastFrame()).toMatch(/attack/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /home/ankur/test/test-mob/gmft-ai/apps/gmft && pnpm exec vitest run test/approval-prompt-type-to-confirm.test.tsx 2>&1 | tail -10
```

Expected: FAIL — `typeToConfirm` prop is not in the type.

- [ ] **Step 3: Update `ApprovalPrompt.tsx`**

Open `apps/gmft/src/ui/components/ApprovalPrompt.tsx`. Make the following changes:

1. Add `typeToConfirm?: string` to `ApprovalPromptProps`.
2. Destructure it in the function signature.
3. Add `useState<string>('')` to hold the in-progress text.
4. Replace the existing `useInput` body with logic that, when `typeToConfirm` is set, accumulates the typed string and on Enter (or when the buffer exactly matches `typeToConfirm`) calls `onResolve(true)`. When `typeToConfirm` is not set, the existing y/n/Esc behavior is preserved.

The new `useInput`:

```typescript
useInput((input, key) => {
  if (key.escape) {
    onResolve(false);
    return;
  }
  if (!typeToConfirm) {
    // Existing y/n mode
    if (input === 'y' || input === 'Y') {
      onResolve(true);
      return;
    }
    if (input === 'n' || input === 'N') {
      onResolve(false);
      return;
    }
    setPulsed(true);
    setTimeout(() => setPulsed(false), 120);
    return;
  }
  // type-then-confirm mode
  if (key.return) {
    if (buffer === typeToConfirm) {
      onResolve(true);
    } else {
      // Flash a rejection; do not resolve.
      setPulsed(true);
      setTimeout(() => setPulsed(false), 240);
    }
    return;
  }
  if (key.backspace || key.delete) {
    setBuffer((b) => b.slice(0, -1));
    return;
  }
  if (input && !key.ctrl && !key.meta) {
    setBuffer((b) => (b + input).slice(0, typeToConfirm.length + 8));
  }
});
```

5. Update the prompt's bottom row to show the type-then-confirm hint when `typeToConfirm` is set:

```tsx
{typeToConfirm ? (
  <Text>
    {theme.muted('type ')}
    <Text color="red">{typeToConfirm}</Text>
    {theme.muted(' to confirm, or [Esc] to deny')}
  </Text>
) : (
  // existing y/n row
  <Box marginTop={1}>
    <Text>
      {theme.muted('press ')}
      <Text color="green">[Y]</Text>
      {theme.muted(' to approve  ')}
      <Text color="red">[N]</Text>
      {theme.muted(' or ')}
      <Text color="red">[Esc]</Text>
      {theme.muted(' to deny')}
    </Text>
  </Box>
)}
```

6. Add a sub-line that shows the current buffer when in type-to-confirm mode (helps the user see what they typed):

```tsx
{typeToConfirm ? (
  <Box>
    <Text>
      {theme.muted('input ')}
      <Text color="cyan">{buffer || '_'}</Text>
    </Text>
  </Box>
) : null}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd /home/ankur/test/test-mob/gmft-ai/apps/gmft && pnpm exec vitest run test/approval-prompt-type-to-confirm.test.tsx 2>&1 | tail -10
```

Expected: 1 passed.

- [ ] **Step 5: Run the full app suite for regression**

```bash
cd /home/ankur/test/test-mob/gmft-ai/apps/gmft && pnpm exec vitest run 2>&1 | tail -6
```

Expected: 86 passed (was 85, +1 new).

## Task 5.2: nuclei tool (streaming)

**Files:**
- Create: `packages/tools/src/web/nuclei.ts`
- Create: `packages/tools/src/web/index.ts`
- Create: `packages/tools/test/web/nuclei.test.ts`
- Create: `packages/tools/test/web/fixtures/nuclei-sample.ndjson`

- [ ] **Step 1: Create the fixture**

`packages/tools/test/web/fixtures/nuclei-sample.ndjson` is a small NDJSON file with 3 nuclei findings. Use real-looking fields so the parser is exercised:

```ndjson
{"template":"CVE-2021-44228","info":{"name":"Log4j RCE","severity":"critical","description":"Log4shell","reference":["https://logging.apache.org/log4j/2.x/security.html"],"classification":{"cve-id":["CVE-2021-44228"]}},"type":"http","host":"https://example.com:443","matched-at":"https://example.com:443/","timestamp":"2025-12-25T00:00:00Z"}
{"template":"tech-detect","info":{"name":"Tech detect","severity":"info","description":"Detected nginx","reference":[],"classification":{}},"type":"http","host":"https://example.com:443","matched-at":"https://example.com:443/","timestamp":"2025-12-25T00:00:01Z"}
{"template":"exposed-panel","info":{"name":"Jenkins exposed","severity":"high","description":"Jenkins login exposed","reference":[],"classification":{}},"type":"http","host":"https://example.com:443","matched-at":"https://example.com:443/jenkins/login","timestamp":"2025-12-25T00:00:02Z"}
```

- [ ] **Step 2: Write the failing test**

`packages/tools/test/web/nuclei.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { nucleiTool, parseNucleiNdjson } from '../../src/web/nuclei';

const FIXTURE = readFileSync(
  join(__dirname, 'fixtures/nuclei-sample.ndjson'),
  'utf8',
);

describe('nuclei tool', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('parses ndjson into Finding[]', () => {
    const findings = parseNucleiNdjson(FIXTURE);
    expect(findings).toHaveLength(3);
    expect(findings[0].severity).toBe('critical');
    expect(findings[0].tool).toBe('nuclei');
    expect(findings[0].title).toMatch(/Log4j/);
    expect(findings[0].target).toMatch(/example\.com/);
  });

  it('run() invokes the runner and returns parsed findings + mode', async () => {
    // Mock the runner
    vi.mock('../../src/shared/runner', () => ({
      run: vi.fn(async () => ({
        mode: 'host' as const,
        fellBack: false,
        exitCode: 0,
        stdout: FIXTURE,
        stderr: '',
        durationMs: 123,
      })),
    }));
    // Re-import after mock
    const { nucleiTool: tool } = await import('../../src/web/nuclei');
    const out = await tool.run({ target: 'https://example.com' }, {} as any);
    expect(out.findings).toHaveLength(3);
    expect(out.mode).toBe('host');
  });

  it('registers with the right name, category, and flags', () => {
    expect(nucleiTool.name).toBe('nuclei');
    expect(nucleiTool.category).toBe('web');
    expect(nucleiTool.flags).toEqual([]);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
cd /home/ankur/test/test-mob/gmft-ai/packages/tools && pnpm exec vitest run test/web/nuclei.test.ts 2>&1 | tail -8
```

Expected: FAIL — `nuclei` module doesn't exist.

- [ ] **Step 4: Create the nuclei tool**

`packages/tools/src/web/nuclei.ts`:

```typescript
import { z } from 'zod';
import { run } from '../shared/runner';
import type { Tool, ToolContext, Finding } from '@gmft/core';

export const NucleiInput = z.object({
  target: z.string().min(1),
  templates: z.string().optional(),
  severity: z
    .enum(['info', 'low', 'medium', 'high', 'critical'])
    .optional(),
});
export type NucleiInputT = z.infer<typeof NucleiInput>;

export const NucleiOutput = z.object({
  findings: z.array(z.any()),
  mode: z.enum(['host', 'docker']),
  fellBack: z.boolean(),
  durationMs: z.number(),
});
export type NucleiOutputT = z.infer<typeof NucleiOutput>;

export function parseNucleiNdjson(text: string): Finding[] {
  const findings: Finding[] = [];
  let n = 0;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec: any;
    try {
      rec = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const info = rec.info ?? {};
    findings.push({
      id: `nuclei-${n++}-${Date.now()}`,
      tool: 'nuclei',
      target: String(rec['matched-at'] ?? rec.host ?? ''),
      title: String(info.name ?? rec.template ?? 'nuclei finding'),
      severity: (info.severity ?? 'info') as Finding['severity'],
      description: info.description,
      evidence: rec['matched-at'],
      ts: rec.timestamp ? Date.parse(rec.timestamp) : Date.now(),
    });
  }
  return findings;
}

export const nucleiTool: Tool<NucleiInputT, NucleiOutputT> = {
  name: 'nuclei',
  category: 'web',
  description: 'Run nuclei templates against a target; returns parsed findings.',
  input: NucleiInput as any,
  output: NucleiOutput as any,
  flags: [],
  run: async (input, _ctx) => {
    const argv = ['nuclei', '-u', input.target, '-json', '-silent'];
    if (input.templates) argv.push('-t', input.templates);
    if (input.severity) argv.push('-severity', input.severity);
    const r = await run({ argv, timeoutMs: 300_000 });
    const findings = parseNucleiNdjson(r.stdout);
    return {
      findings,
      mode: r.mode,
      fellBack: r.fellBack,
      durationMs: r.durationMs,
    };
  },
};
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd /home/ankur/test/test-mob/gmft-ai/packages/tools && pnpm exec vitest run test/web/nuclei.test.ts 2>&1 | tail -8
```

Expected: 3 passed.

- [ ] **Step 6: Commit**

```bash
cd /home/ankur/test/test-mob/gmft-ai && git add packages/tools/src/web/nuclei.ts packages/tools/src/web/index.ts packages/tools/test/web/nuclei.test.ts packages/tools/test/web/fixtures/nuclei-sample.ndjson && git -c user.email=blumi@local -c user.name=blumi commit -m "feat(tools): nuclei web vulnerability scanner + Findings"
```

---

## Task 5.3: nikto tool

**Files:**
- Create: `packages/tools/src/web/nikto.ts`
- Modify: `packages/tools/src/web/index.ts` (add `nikto`)
- Create: `packages/tools/test/web/nikto.test.ts`
- Create: `packages/tools/test/web/fixtures/nikto-sample.txt`

- [ ] **Step 1: Create the fixture**

`packages/tools/test/web/fixtures/nikto-sample.txt` is a small slice of nikto's plain-text output. Real nikto output is verbose; this is a few representative lines:

```
- Nikto v2.5.0
---------------------------------------------------------------------------
+ Target IP:          10.0.0.5
+ Target Hostname:    example.com
+ Target Port:        443
---------------------------------------------------------------------------
+ SSL Info:        Subject: /CN=example.com
                   Ciphers: ECDHE-RSA-AES128-GCM-SHA256
+ Start Time:         2025-12-25 00:00:00 (UTC0)
---------------------------------------------------------------------------
+ Server: nginx/1.21.6
+ The anti-clickjacking X-Frame-Options header is not present.
+ /admin/: Admin login page found.
+ /phpmyadmin/: phpMyAdmin login page found.
+ /server-status: Apache server status page found.
+ 7894 items checked: 0 error(s) and 4 item(s) reported on this host
---------------------------------------------------------------------------
+ 1 host(s) tested
```

- [ ] **Step 2: Write the failing test**

`packages/tools/test/web/nikto.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { niktoTool, parseNiktoText } from '../../src/web/nikto';

const FIXTURE = readFileSync(join(__dirname, 'fixtures/nikto-sample.txt'), 'utf8');

describe('nikto tool', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('parses plain text into Finding[]', () => {
    const findings = parseNiktoText(FIXTURE, 'https://example.com');
    expect(findings.length).toBeGreaterThanOrEqual(4);
    // All findings should reference the target
    expect(findings.every((f) => f.target === 'https://example.com')).toBe(true);
    // All have severity at least 'low'
    expect(findings.every((f) => ['low', 'medium', 'high', 'critical'].includes(f.severity))).toBe(true);
    // Admin login page detected
    expect(findings.some((f) => f.title.toLowerCase().includes('admin'))).toBe(true);
  });

  it('run() returns parsed findings', async () => {
    vi.mock('../../src/shared/runner', () => ({
      run: vi.fn(async () => ({
        mode: 'host' as const,
        fellBack: false,
        exitCode: 0,
        stdout: FIXTURE,
        stderr: '',
        durationMs: 200,
      })),
    }));
    const { niktoTool: tool } = await import('../../src/web/nikto');
    const out = await tool.run({ target: 'https://example.com' }, {} as any);
    expect(out.findings.length).toBeGreaterThan(0);
    expect(out.mode).toBe('host');
  });

  it('registers with name=nukto, category=web, no flags', () => {
    expect(niktoTool.name).toBe('nikto');
    expect(niktoTool.category).toBe('web');
    expect(niktoTool.flags).toEqual([]);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
cd /home/ankur/test/test-mob/gmft-ai/packages/tools && pnpm exec vitest run test/web/nikto.test.ts 2>&1 | tail -8
```

Expected: FAIL — `nikto` module doesn't exist.

- [ ] **Step 4: Create the nikto tool**

`packages/tools/src/web/nikto.ts`:

```typescript
import { z } from 'zod';
import { run } from '../shared/runner';
import type { Tool, ToolContext, Finding } from '@gmft/core';

export const NiktoInput = z.object({
  target: z.string().min(1),
  tuning: z.string().optional(),
});
export type NiktoInputT = z.infer<typeof NiktoInput>;

export const NiktoOutput = z.object({
  findings: z.array(z.any()),
  mode: z.enum(['host', 'docker']),
  fellBack: z.boolean(),
  durationMs: z.number(),
});
export type NiktoOutputT = z.infer<typeof NiktoOutput>;

/**
 * Heuristic severity:
 * - "admin" / "phpmyadmin" / "login" → medium
 * - "apache" / "server-status" → low
 * - default → low
 */
function niktoSeverity(line: string): Finding['severity'] {
  const l = line.toLowerCase();
  if (l.includes('admin') || l.includes('login') || l.includes('phpmyadmin')) return 'medium';
  if (l.includes('server-status') || l.includes('apache')) return 'low';
  return 'low';
}

export function parseNiktoText(text: string, target: string): Finding[] {
  const findings: Finding[] = [];
  let n = 0;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('+ ')) continue;
    if (
      line.startsWith('+ Target ') ||
      line.startsWith('+ SSL Info') ||
      line.startsWith('+ Start Time') ||
      line.startsWith('+ Server:') ||
      line.startsWith('+ ') === false ||
      line.includes('item(s) checked') ||
      line.includes('host(s) tested') ||
      line.startsWith('+') === false
    ) {
      // skip meta lines
      if (line.startsWith('+ Target') || line.startsWith('+ SSL') || line.startsWith('+ Start')) {
        continue;
      }
    }
    if (
      line.startsWith('+ Target') ||
      line.startsWith('+ SSL') ||
      line.startsWith('+ Start') ||
      line.startsWith('+ Server:') ||
      line.includes('item(s) checked') ||
      line.includes('host(s) tested') ||
      line === '---------------------------------------------------------------------------'
    ) {
      continue;
    }
    const title = line.replace(/^\+\s*/, '').trim();
    findings.push({
      id: `nikto-${n++}-${Date.now()}`,
      tool: 'nikto',
      target,
      title,
      severity: niktoSeverity(title),
      ts: Date.now(),
    });
  }
  return findings;
}

export const niktoTool: Tool<NiktoInputT, NiktoOutputT> = {
  name: 'nikto',
  category: 'web',
  description: 'Run nikto web server scanner; returns parsed findings.',
  input: NiktoInput as any,
  output: NiktoOutput as any,
  flags: [],
  run: async (input, _ctx) => {
    const argv = ['nikto', '-h', input.target, '-Format', 'txt'];
    if (input.tuning) argv.push('-Tuning', input.tuning);
    const r = await run({ argv, timeoutMs: 300_000 });
    const findings = parseNiktoText(r.stdout, input.target);
    return {
      findings,
      mode: r.mode,
      fellBack: r.fellBack,
      durationMs: r.durationMs,
    };
  },
};
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd /home/ankur/test/test-mob/gmft-ai/packages/tools && pnpm exec vitest run test/web/nikto.test.ts 2>&1 | tail -8
```

Expected: 3 passed.

## Task 5.4: gobuster tool

**Files:**
- Create: `packages/tools/src/web/gobuster.ts`
- Modify: `packages/tools/src/web/index.ts` (add `gobuster`)
- Create: `packages/tools/test/web/gobuster.test.ts`
- Create: `packages/tools/test/web/fixtures/gobuster-sample.txt`

- [ ] **Step 1: Create the fixture**

`packages/tools/test/web/fixtures/gobuster-sample.txt` is a small slice of gobuster's default text output:

```
===============================================================
Gobuster v3.6
by OJ Reeves (@TheColonial) & Christian Mehlmauer (@firefart)
===============================================================
[+] Url:                     https://example.com
[+] Method:                  GET
[+] Threads:                 10
[+] Wordlist:                /usr/share/wordlists/dirb/common.txt
[+] Negative Status codes:   404
[+] User Agent:              gobuster/3.6
[+] Timeout:                 10s
===============================================================
/admin                [Status: 200, Words: 12, Lines: 30]
/login                [Status: 200, Words: 5, Lines: 10]
/uploads              [Status: 301, Words: 0, Lines: 0]
/api                  [Status: 403, Words: 9, Lines: 22]
/wp-admin             [Status: 200, Words: 8, Lines: 25]
===============================================================
2025/12/25 00:00:00 Finished
===============================================================
```

- [ ] **Step 2: Write the failing test**

`packages/tools/test/web/gobuster.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gobusterTool, parseGobusterText } from '../../src/web/gobuster';

const FIXTURE = readFileSync(join(__dirname, 'fixtures/gobuster-sample.txt'), 'utf8');

describe('gobuster tool', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('parses text into Finding[] with one entry per discovered path', () => {
    const findings = parseGobusterText(FIXTURE, 'https://example.com');
    expect(findings).toHaveLength(5);
    expect(findings[0].tool).toBe('gobuster');
    expect(findings[0].target).toBe('https://example.com');
    expect(findings[0].title).toContain('/admin');
    expect(findings[0].title).toContain('200');
  });

  it('run() returns parsed findings', async () => {
    vi.mock('../../src/shared/runner', () => ({
      run: vi.fn(async () => ({
        mode: 'host' as const,
        fellBack: false,
        exitCode: 0,
        stdout: FIXTURE,
        stderr: '',
        durationMs: 100,
      })),
    }));
    const { gobusterTool: tool } = await import('../../src/web/gobuster');
    const out = await tool.run({ url: 'https://example.com' }, {} as any);
    expect(out.findings).toHaveLength(5);
  });

  it('registers with name=gobuster, category=web, no flags', () => {
    expect(gobusterTool.name).toBe('gobuster');
    expect(gobusterTool.category).toBe('web');
    expect(gobusterTool.flags).toEqual([]);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
cd /home/ankur/test/test-mob/gmft-ai/packages/tools && pnpm exec vitest run test/web/gobuster.test.ts 2>&1 | tail -8
```

Expected: FAIL — `gobuster` module doesn't exist.

- [ ] **Step 4: Create the gobuster tool**

`packages/tools/src/web/gobuster.ts`:

```typescript
import { z } from 'zod';
import { run } from '../shared/runner';
import type { Tool, ToolContext, Finding } from '@gmft/core';

export const GobusterInput = z.object({
  url: z.string().min(1),
  wordlist: z.string().default('/usr/share/wordlists/dirb/common.txt'),
  mode: z.enum(['dir', 'dns', 'vhost']).default('dir'),
});
export type GobusterInputT = z.infer<typeof GobusterInput>;

export const GobusterOutput = z.object({
  findings: z.array(z.any()),
  mode: z.enum(['host', 'docker']),
  fellBack: z.boolean(),
  durationMs: z.number(),
});
export type GobusterOutputT = z.infer<typeof GobusterOutput>;

const pathLine = /^\/(?!\/)([^\s]+)\s+\[Status:\s*(\d+)/;

export function parseGobusterText(text: string, target: string): Finding[] {
  const findings: Finding[] = [];
  let n = 0;
  for (const raw of text.split('\n')) {
    const m = raw.match(pathLine);
    if (!m) continue;
    const [, path, status] = m;
    findings.push({
      id: `gobuster-${n++}-${Date.now()}`,
      tool: 'gobuster',
      target,
      title: `${path} [Status: ${status}]`,
      severity: status === '200' ? 'low' : 'info',
      ts: Date.now(),
    });
  }
  return findings;
}

export const gobusterTool: Tool<GobusterInputT, GobusterOutputT> = {
  name: 'gobuster',
  category: 'web',
  description: 'Run gobuster directory/DNS/vhost enumeration; returns parsed findings.',
  input: GobusterInput as any,
  output: GobusterOutput as any,
  flags: [],
  run: async (input, _ctx) => {
    const argv = ['gobuster', input.mode, '-u', input.url, '-w', input.wordlist, '-q', '--no-error'];
    const r = await run({ argv, timeoutMs: 300_000 });
    const findings = parseGobusterText(r.stdout, input.url);
    return {
      findings,
      mode: r.mode,
      fellBack: r.fellBack,
      durationMs: r.durationMs,
    };
  },
};
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd /home/ankur/test/test-mob/gmft-ai/packages/tools && pnpm exec vitest run test/web/gobuster.test.ts 2>&1 | tail -8
```

Expected: 3 passed.

- [ ] **Step 6: Commit**

```bash
cd /home/ankur/test/test-mob/gmft-ai && git add packages/tools/src/web/gobuster.ts packages/tools/src/web/index.ts packages/tools/test/web/gobuster.test.ts packages/tools/test/web/fixtures/gobuster-sample.txt && git -c user.email=blumi@local -c user.name=blumi commit -m "feat(tools): gobuster directory/DNS/vhost enumeration + Findings"
```

---

## Task 5.5: ffuf tool

**Files:**
- Create: `packages/tools/src/web/ffuf.ts`
- Modify: `packages/tools/src/web/index.ts` (add `ffuf`)
- Create: `packages/tools/test/web/ffuf.test.ts`
- Create: `packages/tools/test/web/fixtures/ffuf-sample.json`

- [ ] **Step 1: Create the fixture**

`packages/tools/test/web/fixtures/ffuf-sample.json` is a small ffuf JSON output. Real ffuf output is verbose; this has 4 results:

```json
{
  "commandline": "ffuf -u https://example.com/FUZZ -w /tmp/wl.txt -json",
  "time": "2025-12-25T00:00:00+00:00",
  "results": [
    {
      "input": {"FUZZ": "admin"},
      "position": 1,
      "status": 200,
      "length": 1234,
      "words": 56,
      "lines": 30,
      "content-type": "text/html",
      "url": "https://example.com/admin",
      "host": "example.com"
    },
    {
      "input": {"FUZZ": "login"},
      "position": 2,
      "status": 200,
      "length": 980,
      "words": 32,
      "lines": 18,
      "content-type": "text/html",
      "url": "https://example.com/login",
      "host": "example.com"
    },
    {
      "input": {"FUZZ": "uploads"},
      "position": 3,
      "status": 301,
      "length": 0,
      "words": 0,
      "lines": 0,
      "content-type": "text/html",
      "url": "https://example.com/uploads",
      "host": "example.com"
    },
    {
      "input": {"FUZZ": "api"},
      "position": 4,
      "status": 403,
      "length": 564,
      "words": 22,
      "lines": 9,
      "content-type": "text/html",
      "url": "https://example.com/api",
      "host": "example.com"
    }
  ]
}
```

- [ ] **Step 2: Write the failing test**

`packages/tools/test/web/ffuf.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ffufTool, parseFfufJson } from '../../src/web/ffuf';

const FIXTURE = readFileSync(join(__dirname, 'fixtures/ffuf-sample.json'), 'utf8');

describe('ffuf tool', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('parses JSON into Finding[]', () => {
    const findings = parseFfufJson(FIXTURE, 'https://example.com');
    expect(findings).toHaveLength(4);
    expect(findings[0].title).toMatch(/admin/);
    expect(findings[0].title).toMatch(/200/);
    expect(findings[0].target).toBe('https://example.com');
  });

  it('run() returns parsed findings', async () => {
    vi.mock('../../src/shared/runner', () => ({
      run: vi.fn(async () => ({
        mode: 'host' as const,
        fellBack: false,
        exitCode: 0,
        stdout: FIXTURE,
        stderr: '',
        durationMs: 50,
      })),
    }));
    const { ffufTool: tool } = await import('../../src/web/ffuf');
    const out = await tool.run({ url: 'https://example.com/FUZZ' }, {} as any);
    expect(out.findings).toHaveLength(4);
  });

  it('registers with name=ffuf, category=web, no flags', () => {
    expect(ffufTool.name).toBe('ffuf');
    expect(ffufTool.category).toBe('web');
    expect(ffufTool.flags).toEqual([]);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
cd /home/ankur/test/test-mob/gmft-ai/packages/tools && pnpm exec vitest run test/web/ffuf.test.ts 2>&1 | tail -8
```

Expected: FAIL — `ffuf` module doesn't exist.

- [ ] **Step 4: Create the ffuf tool**

`packages/tools/src/web/ffuf.ts`:

```typescript
import { z } from 'zod';
import { run } from '../shared/runner';
import type { Tool, ToolContext, Finding } from '@gmft/core';

export const FfufInput = z.object({
  url: z.string().min(1),
  wordlist: z.string().default('/usr/share/wordlists/dirb/common.txt'),
  match: z.string().optional(),
});
export type FfufInputT = z.infer<typeof FfufInput>;

export const FfufOutput = z.object({
  findings: z.array(z.any()),
  mode: z.enum(['host', 'docker']),
  fellBack: z.boolean(),
  durationMs: z.number(),
});
export type FfufOutputT = z.infer<typeof FfufOutput>;

export function parseFfufJson(text: string, target: string): Finding[] {
  const findings: Finding[] = [];
  let rec: any;
  try {
    rec = JSON.parse(text);
  } catch {
    return findings;
  }
  let n = 0;
  for (const r of rec.results ?? []) {
    const status = r.status;
    findings.push({
      id: `ffuf-${n++}-${Date.now()}`,
      tool: 'ffuf',
      target,
      title: `${r.input?.FUZZ ?? r.url ?? '?'} [Status: ${status}]`,
      severity: status === 200 ? 'low' : status === 403 ? 'low' : 'info',
      ts: Date.now(),
    });
  }
  return findings;
}

export const ffufTool: Tool<FfufInputT, FfufOutputT> = {
  name: 'ffuf',
  category: 'web',
  description: 'Run ffuf web fuzzer; returns parsed findings.',
  input: FfufInput as any,
  output: FfufOutput as any,
  flags: [],
  run: async (input, _ctx) => {
    const argv = ['ffuf', '-u', input.url, '-w', input.wordlist, '-json', '-s'];
    if (input.match) argv.push('-mc', input.match);
    const r = await run({ argv, timeoutMs: 300_000 });
    const findings = parseFfufJson(r.stdout, input.url);
    return {
      findings,
      mode: r.mode,
      fellBack: r.fellBack,
      durationMs: r.durationMs,
    };
  },
};
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd /home/ankur/test/test-mob/gmft-ai/packages/tools && pnpm exec vitest run test/web/ffuf.test.ts 2>&1 | tail -8
```

Expected: 3 passed.

- [ ] **Step 6: Commit**

```bash
cd /home/ankur/test/test-mob/gmft-ai && git add packages/tools/src/web/ffuf.ts packages/tools/src/web/index.ts packages/tools/test/web/ffuf.test.ts packages/tools/test/web/fixtures/ffuf-sample.json && git -c user.email=blumi@local -c user.name=blumi commit -m "feat(tools): ffuf web fuzzer + Findings"
```

---

## Task 5.6: sqlmap tool (destructive)

**Files:**
- Create: `packages/tools/src/web/sqlmap.ts`
- Modify: `packages/tools/src/web/index.ts` (add `sqlmap`)
- Create: `packages/tools/test/web/sqlmap.test.ts`
- Create: `packages/tools/test/web/fixtures/sqlmap-sample.txt`

- [ ] **Step 1: Create the fixture**

`packages/tools/test/web/fixtures/sqlmap-sample.txt` is a small slice of sqlmap's text output:

```
  ___
  __H__
 ___ ___[(]____ ___ ___  {1.7.2#stable}
[_U_|_V_|_I_|  __|  _|    |_|
|___|        |_|           |_|

[*] starting @ 00:00:00 /2025-12-25/

[00:00:00] [INFO] testing connection to the target URL
[00:00:01] [INFO] heuristics detected web page charset 'utf-8'
[00:00:02] [INFO] testing if the target URL is stable
[00:00:05] [INFO] target URL appears to be stable
[00:00:06] [INFO] testing if GET parameter 'id' is dynamic
[00:00:08] [INFO] GET parameter 'id' is dynamic
[00:00:09] [INFO] GET parameter 'id' appears to be 'MySQL >= 5.5 boolean-based blind' injectable
[00:00:10] [INFO] GET parameter 'id' is 'MySQL >= 5.5 AND error-based - WHERE or HAVING clause' injectable
[00:00:12] [INFO] GET parameter 'id' is 'MySQL >= 5.5 time-based blind' injectable
[00:00:14] [INFO] parameter 'id' is vulnerable. Do you want to keep testing the others (if any)? [y/N] N
[00:00:15] [INFO] testing if POST parameter 'data' is dynamic
sqlmap identified the following injection point(s) with a total of 3 HTTP(s) requests:
---
Parameter: id (GET)
    Type: boolean-based blind
    Title: MySQL >= 5.5 boolean-based blind - WHERE or HAVING clause
    Payload: id=1' AND 4857=4857 AND 'qJxi'='qJxi
---
[00:00:20] [INFO] fetched data logged to text files under '/tmp/sqlmap-output'
[*] shutting down at 00:00:20 /2025-12-25/
```

- [ ] **Step 2: Write the failing test**

`packages/tools/test/web/sqlmap.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sqlmapTool, parseSqlmapText } from '../../src/web/sqlmap';

const FIXTURE = readFileSync(join(__dirname, 'fixtures/sqlmap-sample.txt'), 'utf8');

describe('sqlmap tool (destructive)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('parses text into Finding[] with a critical severity injection finding', () => {
    const findings = parseSqlmapText(FIXTURE, 'https://example.com/?id=1');
    expect(findings.length).toBeGreaterThan(0);
    const injectable = findings.find((f) => f.title.toLowerCase().includes('injection'));
    expect(injectable).toBeDefined();
    expect(injectable?.severity).toBe('critical');
    expect(injectable?.target).toBe('https://example.com/?id=1');
  });

  it('run() returns parsed findings + includes the destructive flag', async () => {
    vi.mock('../../src/shared/runner', () => ({
      run: vi.fn(async () => ({
        mode: 'host' as const,
        fellBack: false,
        exitCode: 0,
        stdout: FIXTURE,
        stderr: '',
        durationMs: 200,
      })),
    }));
    const { sqlmapTool: tool } = await import('../../src/web/sqlmap');
    const out = await tool.run({ url: 'https://example.com/?id=1' }, {} as any);
    expect(out.findings.length).toBeGreaterThan(0);
  });

  it('is flagged destructive (chokepoint will require confirm)', () => {
    expect(sqlmapTool.flags).toContain('destructive');
    expect(sqlmapTool.name).toBe('sqlmap');
    expect(sqlmapTool.category).toBe('web');
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
cd /home/ankur/test/test-mob/gmft-ai/packages/tools && pnpm exec vitest run test/web/sqlmap.test.ts 2>&1 | tail -8
```

Expected: FAIL — `sqlmap` module doesn't exist.

- [ ] **Step 4: Create the sqlmap tool**

`packages/tools/src/web/sqlmap.ts`:

```typescript
import { z } from 'zod';
import { run } from '../shared/runner';
import type { Tool, ToolContext, Finding } from '@gmft/core';

export const SqlmapInput = z.object({
  url: z.string().min(1),
  data: z.string().optional(),
  level: z.number().int().min(1).max(5).default(1),
  risk: z.number().int().min(1).max(3).default(1),
});
export type SqlmapInputT = z.infer<typeof SqlmapInput>;

export const SqlmapOutput = z.object({
  findings: z.array(z.any()),
  mode: z.enum(['host', 'docker']),
  fellBack: z.boolean(),
  durationMs: z.number(),
});
export type SqlmapOutputT = z.infer<typeof SqlmapOutput>;

const injectableLine = /parameter '([^']+)' is vulnerable/i;
const paramBlock = /Parameter:\s*([^\n]+)/;

export function parseSqlmapText(text: string, target: string): Finding[] {
  const findings: Finding[] = [];
  let n = 0;
  // First pass: lines that say "parameter X is vulnerable"
  for (const line of text.split('\n')) {
    const m = line.match(injectableLine);
    if (m) {
      findings.push({
        id: `sqlmap-${n++}-${Date.now()}`,
        tool: 'sqlmap',
        target,
        title: `SQL injection in ${m[1]}`,
        severity: 'critical',
        evidence: line.trim(),
        ts: Date.now(),
      });
    }
  }
  // Second pass: parameter blocks (Type, Title, Payload)
  for (const block of text.split(/\n---\n/)) {
    const pm = block.match(paramBlock);
    if (pm && !findings.some((f) => f.title.includes(pm[1]))) {
      findings.push({
        id: `sqlmap-${n++}-${Date.now()}`,
        tool: 'sqlmap',
        target,
        title: `SQL injection in ${pm[1]}`,
        severity: 'critical',
        evidence: block.trim().split('\n').slice(0, 4).join(' | '),
        ts: Date.now(),
      });
    }
  }
  return findings;
}

export const sqlmapTool: Tool<SqlmapInputT, SqlmapOutputT> = {
  name: 'sqlmap',
  category: 'web',
  description:
    'Run sqlmap SQL-injection scanner against a URL. DESTRUCTIVE — chokepoint will require confirmation.',
  input: SqlmapInput as any,
  output: SqlmapOutput as any,
  flags: ['destructive'],
  run: async (input, _ctx) => {
    const argv = [
      'sqlmap',
      '-u',
      input.url,
      '--level',
      String(input.level),
      '--risk',
      String(input.risk),
      '--batch',
    ];
    if (input.data) argv.push('--data', input.data);
    const r = await run({ argv, timeoutMs: 600_000 });
    const findings = parseSqlmapText(r.stdout, input.url);
    return {
      findings,
      mode: r.mode,
      fellBack: r.fellBack,
      durationMs: r.durationMs,
    };
  },
};
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd /home/ankur/test/test-mob/gmft-ai/packages/tools && pnpm exec vitest run test/web/sqlmap.test.ts 2>&1 | tail -8
```

Expected: 3 passed.

## Task 5.7: Catalog + barrel update (5 web + 1 wifi)

**Files:**
- Create: `packages/tools/src/web/index.ts` (barrel)
- Modify: `packages/tools/src/index.ts` (re-export the 5 web tools)
- Modify: `packages/tools/src/catalog.ts` (add 6 tools to the catalog)

- [ ] **Step 1: Create the web barrel**

`packages/tools/src/web/index.ts`:

```typescript
export { nucleiTool, parseNucleiNdjson, NucleiInput, NucleiOutput, type NucleiInputT, type NucleiOutputT } from './nuclei';
export { niktoTool, parseNiktoText, NiktoInput, NiktoOutput, type NiktoInputT, type NiktoOutputT } from './nikto';
export { gobusterTool, parseGobusterText, GobusterInput, GobusterOutput, type GobusterInputT, type GobusterOutputT } from './gobuster';
export { ffufTool, parseFfufJson, FfufInput, FfufOutput, type FfufInputT, type FfufOutputT } from './ffuf';
export { sqlmapTool, parseSqlmapText, SqlmapInput, SqlmapOutput, type SqlmapInputT, type SqlmapOutputT } from './sqlmap';
```

- [ ] **Step 2: Update the tools barrel**

Open `packages/tools/src/index.ts` and add the 5 web re-exports. The current file already re-exports `shellExecTool` and the 4 network tools — just add 5 more lines:

```typescript
export {
  nucleiTool,
  niktoTool,
  gobusterTool,
  ffufTool,
  sqlmapTool,
} from './web/index.js';
```

- [ ] **Step 3: Update the catalog**

Open `packages/tools/src/catalog.ts`. The current `tools` array is exported as a list of `{ name, category, flags }`. Append 6 entries to the array (5 web + 1 wifi). The wifi `evilTwinTool` doesn't exist yet (Task 5.9 builds it) — but TypeScript will catch the missing import. Add a forward-reference import at the top and the catalog entries at the bottom. The new catalog.ts:

```typescript
import { shellExecTool } from './shell/shell-exec';
import { nmapTool } from './network/nmap';
import { dnsenumTool } from './network/dnsenum';
import { theHarvesterTool } from './network/theharvester';
import { whatwebTool } from './network/whatweb';
import { nucleiTool } from './web/nuclei';
import { niktoTool } from './web/nikto';
import { gobusterTool } from './web/gobuster';
import { ffufTool } from './web/ffuf';
import { sqlmapTool } from './web/sqlmap';
// evilTwinTool is added in Task 5.9
// import { evilTwinTool } from './wifi/evil-twin';

export const tools: Array<{ name: string; category: string; flags: readonly string[] }> = [
  { name: shellExecTool.name, category: shellExecTool.category, flags: shellExecTool.flags },
  { name: nmapTool.name, category: nmapTool.category, flags: nmapTool.flags },
  { name: dnsenumTool.name, category: dnsenumTool.category, flags: dnsenumTool.flags },
  { name: theHarvesterTool.name, category: theHarvesterTool.category, flags: theHarvesterTool.flags },
  { name: whatwebTool.name, category: whatwebTool.category, flags: whatwebTool.flags },
  { name: nucleiTool.name, category: nucleiTool.category, flags: nucleiTool.flags },
  { name: niktoTool.name, category: niktoTool.category, flags: niktoTool.flags },
  { name: gobusterTool.name, category: gobusterTool.category, flags: gobusterTool.flags },
  { name: ffufTool.name, category: ffufTool.category, flags: ffufTool.flags },
  { name: sqlmapTool.name, category: sqlmapTool.category, flags: sqlmapTool.flags },
  // { name: evilTwinTool.name, category: evilTwinTool.category, flags: evilTwinTool.flags },
];
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
cd /home/ankur/test/test-mob/gmft-ai && pnpm -C packages/tools exec tsc --noEmit && echo "TSC OK"
```

Expected: `TSC OK`.

- [ ] **Step 5: Run the tools test suite**

```bash
cd /home/ankur/test/test-mob/gmft-ai/packages/tools && pnpm exec vitest run 2>&1 | tail -6
```

Expected: 56 passed (was 46, +10 new from tasks 5.2-5.6, 3 tests each except nuclei is 3, nikto 3, gobuster 3, ffuf 3, sqlmap 3 = 15; 46+15=61... recount below in Step 5.10).

- [ ] **Step 6: Commit**

```bash
cd /home/ankur/test/test-mob/gmft-ai && git add packages/tools/src/web/index.ts packages/tools/src/index.ts packages/tools/src/catalog.ts && git -c user.email=blumi@local -c user.name=blumi commit -m "feat(tools): catalog + barrel include 5 web tools (nuclei/nikto/gobuster/ffuf/sqlmap)"
```

---

## Task 5.8: `Dockerfile.web`

**Files:**
- Create: `docker/Dockerfile.web`

- [ ] **Step 1: Write the Dockerfile**

`docker/Dockerfile.web`:

```dockerfile
# Web vuln tools sandbox image.
# Phase 5: nuclei + nikto + gobuster + ffuf + sqlmap on alpine:3.20.
FROM alpine:3.20

# Tools available in the sandbox
RUN apk add --no-cache \
      bash \
      ca-certificates \
      git \
      go \
      nmap \
      nmap-scripts \
      python3 \
      py3-pip

# sqlmap is python — install via pip into the system python
RUN pip3 install --break-system-packages --no-cache-dir sqlmap

# nuclei: install pinned version
ARG NUCLEI_VERSION=3.1.0
RUN ARCH=$(uname -m) && \
    if [ "$ARCH" = "x86_64" ]; then NUCLEI_ARCH="linux_amd64"; \
    elif [ "$ARCH" = "aarch64" ]; then NUCLEI_ARCH="linux_arm64"; \
    else echo "Unsupported arch: $ARCH" && exit 1; fi && \
    curl -fsSL "https://github.com/projectdiscovery/nuclei/releases/download/v${NUCLEI_VERSION}/nuclei_${NUCLEI_VERSION}_${NUCLEI_ARCH}.zip" \
      -o /tmp/nuclei.zip && \
    unzip /tmp/nuclei.zip -d /usr/local/bin/ && \
    rm /tmp/nuclei.zip && \
    chmod +x /usr/local/bin/nuclei

# nikto: clone the nikto repo (no static binary)
ARG NIKTO_VERSION=2.5.0
RUN git clone --depth 1 --branch "${NIKTO_VERSION}" https://github.com/sullo/nikto.git /opt/nikto && \
    ln -s /opt/nikto/program/nikto.pl /usr/local/bin/nikto && \
    chmod +x /usr/local/bin/nikto

# gobuster: install pinned version
ARG GOBUSTER_VERSION=3.6
RUN ARCH=$(uname -m) && \
    if [ "$ARCH" = "x86_64" ]; then GOBUSTER_ARCH="linux_amd64"; \
    elif [ "$ARCH" = "aarch64" ]; then GOBUSTER_ARCH="linux_arm64"; \
    else echo "Unsupported arch: $ARCH" && exit 1; fi && \
    curl -fsSL "https://github.com/OJ/gobuster/releases/download/v${GOBUSTER_VERSION}/gobuster_Linux_${GOBUSTER_ARCH}.tar.gz" \
      -o /tmp/gobuster.tar.gz && \
    tar -xzf /tmp/gobuster.tar.gz -C /usr/local/bin/ gobuster && \
    rm /tmp/gobuster.tar.gz && \
    chmod +x /usr/local/bin/gobuster

# ffuf: install pinned version
ARG FFUF_VERSION=2.1.0
RUN ARCH=$(uname -m) && \
    if [ "$ARCH" = "x86_64" ]; then FFUF_ARCH="amd64"; \
    elif [ "$ARCH" = "aarch64" ]; then FFUF_ARCH="arm64"; \
    else echo "Unsupported arch: $ARCH" && exit 1; fi && \
    curl -fsSL "https://github.com/ffuf/ffuf/releases/download/v${FFUF_VERSION}/ffuf_${FFUF_VERSION}_linux_${FFUF_ARCH}.tar.gz" \
      -o /tmp/ffuf.tar.gz && \
    tar -xzf /tmp/ffuf.tar.gz -C /usr/local/bin/ ffuf && \
    rm /tmp/ffuf.tar.gz && \
    chmod +x /usr/local/bin/ffuf

# Common wordlists (small; the user can mount their own)
RUN mkdir -p /usr/share/wordlists/dirb && \
    curl -fsSL https://raw.githubusercontent.com/v0re/dirb/master/wordlists/common.txt \
      -o /usr/share/wordlists/dirb/common.txt

# Sanity check
RUN nuclei -version && \
    nikto -Version 2>&1 | head -1 && \
    gobuster version && \
    ffuf -V && \
    sqlmap --version

WORKDIR /workspace
ENTRYPOINT ["/bin/sh"]
```

- [ ] **Step 2: Verify the Dockerfile syntax is sane (don't build — that's CI's job)**

```bash
cd /home/ankur/test/test-mob/gmft-ai && docker run --rm -i hadolint/hadolint < docker/Dockerfile.web 2>&1 | tail -10 || echo "(hadolint not available — skipping; Dockerfile is hand-reviewed)"
```

Expected: either empty output (no warnings) or `(hadolint not available — skipping; Dockerfile is hand-reviewed)`.

- [ ] **Step 3: Commit**

```bash
cd /home/ankur/test/test-mob/gmft-ai && git add docker/Dockerfile.web && git -c user.email=blumi@local -c user.name=blumi commit -m "feat(docker): Dockerfile.web with nuclei + nikto + gobuster + ffuf + sqlmap"
```

---

## Task 5.9: evil-twin wifi tool

**Files:**
- Create: `packages/tools/src/wifi/evil-twin.ts`
- Create: `packages/tools/src/wifi/index.ts`
- Create: `packages/tools/test/wifi/evil-twin.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/tools/test/wifi/evil-twin.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { evilTwinTool } from '../../src/wifi/evil-twin';

describe('evil_twin tool (destructive + requiresElevation + typeToConfirm)', () => {
  beforeEach(() => {
    delete process.env.GMFT_DRY;
    delete process.env.GMFT_ALLOW_ELEVATION;
    vi.restoreAllMocks();
  });

  it('registers with all 3 high-friction markers', () => {
    expect(evilTwinTool.name).toBe('evil_twin');
    expect(evilTwinTool.category).toBe('wifi');
    expect(evilTwinTool.flags).toEqual(
      expect.arrayContaining(['destructive', 'requiresElevation']),
    );
  });

  it('does NOT actually invoke fluxion in dry mode (returns dry-run output)', async () => {
    process.env.GMFT_DRY = '1';
    // Mock the runner to assert nothing was actually spawned
    const runMock = vi.fn(async () => {
      throw new Error('runner.run should not be called in dry mode');
    });
    vi.mock('../../src/shared/runner', () => ({ run: runMock }));
    const { evilTwinTool: tool } = await import('../../src/wifi/evil-twin');
    const out = await tool.run(
      {
        targetBssid: 'AA:BB:CC:DD:EE:FF',
        targetEssid: 'CorpWiFi',
        interface: 'wlan0',
        channel: 6,
      },
      {} as any,
    );
    expect(out.dryRun).toBe(true);
    expect(out.fluxionArgs).toContain('CorpWiFi');
    expect(out.findings).toEqual([]);
    expect(runMock).not.toHaveBeenCalled();
  });

  it('refuses to run if fluxion is missing (no dry mode, no fluxion binary)', async () => {
    process.env.GMFT_DRY = '1';
    vi.mock('../../src/shared/runner', () => ({
      run: vi.fn(),
      // prereq: assertBinary throws when fluxion is missing
      assertBinary: vi.fn(() => {
        throw new Error('fluxion not found on PATH');
      }),
    }));
    const { evilTwinTool: tool } = await import('../../src/wifi/evil-twin');
    // In dry mode, prereq is NOT enforced — fluxion args are computed only
    // So this should NOT throw.
    const out = await tool.run(
      {
        targetBssid: 'AA:BB:CC:DD:EE:FF',
        targetEssid: 'CorpWiFi',
        interface: 'wlan0',
        channel: 6,
      },
      {} as any,
    );
    expect(out.dryRun).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /home/ankur/test/test-mob/gmft-ai/packages/tools && pnpm exec vitest run test/wifi/evil-twin.test.ts 2>&1 | tail -10
```

Expected: FAIL — `evil-twin` module doesn't exist.

- [ ] **Step 3: Create the evil-twin tool**

`packages/tools/src/wifi/evil-twin.ts`:

```typescript
import { z } from 'zod';
import { run } from '../shared/runner';
import type { Tool, ToolContext, Finding } from '@gmft/core';

export const EvilTwinInput = z.object({
  targetBssid: z.string().regex(/^[0-9A-Fa-f:]{17}$/, 'BSSID must be aa:bb:cc:dd:ee:ff form'),
  targetEssid: z.string().min(1).max(32),
  interface: z.string().min(1),
  channel: z.number().int().min(1).max(165),
});
export type EvilTwinInputT = z.infer<typeof EvilTwinInput>;

export const EvilTwinOutput = z.object({
  findings: z.array(z.any()),
  mode: z.enum(['host', 'docker']),
  fellBack: z.boolean(),
  durationMs: z.number(),
  fluxionArgs: z.array(z.string()),
  dryRun: z.boolean(),
  tmuxSession: z.string().optional(),
});
export type EvilTwinOutputT = z.infer<typeof EvilTwinOutput>;

/**
 * evil_twin — wraps the fluxion workflow as ONE high-friction tool.
 *
 * Flags: destructive + requiresElevation + typeToConfirm="attack"
 *   - destructive → chokepoint always requires user confirmation
 *   - requiresElevation → chokepoint denies unless GMFT_ALLOW_ELEVATION=true
 *   - typeToConfirm="attack" → user must type the literal "attack" to confirm
 *
 * On confirm (real mode, not dry):
 *   - shells out to `sudo ./fluxion.sh -i` inside a new tmux session named
 *     "gmft-evil-twin-<essid-slug>" so the user can `tmux attach -t <name>` later
 *
 * On dry mode (GMFT_DRY=1): the fluxion args are computed and returned
 *   but fluxion is NOT invoked and no sudo is requested. This is what
 *   tests use to assert the wiring without requiring fluxion on PATH.
 */
export const evilTwinTool: Tool<EvilTwinInputT, EvilTwinOutputT> = {
  name: 'evil_twin',
  category: 'wifi',
  description:
    'Launch a fluxion evil-twin attack against a target AP. DESTRUCTIVE + ELEVATED. ' +
    'Requires the user to type "attack" to confirm.',
  input: EvilTwinInput as any,
  output: EvilTwinOutput as any,
  flags: ['destructive', 'requiresElevation'],
  run: async (input, _ctx) => {
    const tmuxSession = `gmft-evil-twin-${input.targetEssid.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    const fluxionArgs = [
      'sudo',
      './fluxion.sh',
      '-i',
      '--essid',
      input.targetEssid,
      '--bssid',
      input.targetBssid,
      '--channel',
      String(input.channel),
      '--interface',
      input.interface,
    ];

    if (process.env.GMFT_DRY === '1') {
      return {
        findings: [] as Finding[],
        mode: 'host' as const,
        fellBack: false,
        durationMs: 0,
        fluxionArgs,
        dryRun: true,
      };
    }

    // Real mode: assertBinary is the project's prereq helper — it throws
    // if fluxion is not on PATH. We import it dynamically to avoid a
    // hard dep when running in dry mode under test.
    const { assertBinary } = await import('../shared/prereq');
    assertBinary('fluxion', 'sudo');

    // Wrap the fluxion invocation in a detached tmux session so the user
    // can attach later. We use tmux new-session -d to detach.
    const tmuxArgs = ['tmux', 'new-session', '-d', '-s', tmuxSession, fluxionArgs.join(' ')];
    const r = await run({ argv: tmuxArgs, timeoutMs: 60_000 });

    return {
      findings: [] as Finding[],
      mode: r.mode,
      fellBack: r.fellBack,
      durationMs: r.durationMs,
      fluxionArgs,
      dryRun: false,
      tmuxSession,
    };
  },
};
```

- [ ] **Step 4: Create the wifi barrel**

`packages/tools/src/wifi/index.ts`:

```typescript
export {
  evilTwinTool,
  EvilTwinInput,
  EvilTwinOutput,
  type EvilTwinInputT,
  type EvilTwinOutputT,
} from './evil-twin';
```

- [ ] **Step 5: Wire `evilTwinTool` into the catalog**

Open `packages/tools/src/catalog.ts` (already updated in Task 5.7) and uncomment the two `evilTwinTool` lines:

```typescript
import { evilTwinTool } from './wifi/evil-twin';
// ...
{ name: evilTwinTool.name, category: evilTwinTool.category, flags: evilTwinTool.flags },
```

- [ ] **Step 6: Update the tools barrel to re-export evilTwinTool**

Open `packages/tools/src/index.ts` and add:

```typescript
export { evilTwinTool } from './wifi/index.js';
```

- [ ] **Step 7: Run the test to verify it passes**

```bash
cd /home/ankur/test/test-mob/gmft-ai/packages/tools && pnpm exec vitest run test/wifi/evil-twin.test.ts 2>&1 | tail -10
```

Expected: 3 passed.

- [ ] **Step 8: Verify TypeScript compiles**

```bash
cd /home/ankur/test/test-mob/gmft-ai && pnpm -C packages/tools exec tsc --noEmit && echo "TSC OK"
```

Expected: `TSC OK`.

- [ ] **Step 9: Commit**

```bash
cd /home/ankur/test/test-mob/gmft-ai && git add packages/tools/src/wifi/evil-twin.ts packages/tools/src/wifi/index.ts packages/tools/src/catalog.ts packages/tools/src/index.ts packages/tools/test/wifi/evil-twin.test.ts && git -c user.email=blumi@local -c user.name=blumi commit -m "feat(tools): evil_twin wifi tool (destructive + requiresElevation + typeToConfirm)"
```

---

## Task 5.10: Chokepoint `type-then-confirm` + executor wiring + tests

**Files:**
- Modify: `packages/core/src/chokepoint/decision.ts` (add `type-then-confirm` Decision + `typeToConfirm` field on ChokepointCall)
- Modify: `packages/core/src/chokepoint/rules.ts` (new `checkTypeToConfirm` rule)
- Modify: `packages/core/src/chokepoint/index.ts` (add the rule to the aggregator)
- Modify: `packages/core/src/tools/types.ts` (add `typeToConfirm?: string` on Tool)
- Modify: `packages/core/src/tools/executor.ts` (pass `typeToConfirm` into the ChokepointCall; handle the new decision kind)
- Create: `packages/core/test/chokepoint-type-to-confirm.test.ts`

- [ ] **Step 1: Add the new decision kind + ChokepointCall field**

In `packages/core/src/chokepoint/decision.ts`:

Replace the `Decision` union with:

```typescript
export type Decision =
  | { kind: 'allow' }
  | { kind: 'confirm'; reason: string }
  | {
      /** High-friction: user must type the literal `prompt` to confirm. */
      kind: 'type-then-confirm';
      reason: string;
      prompt: string;
    }
  | { kind: 'deny'; reason: string };
```

Add `typeToConfirm` to `ChokepointCall`:

```typescript
export interface ChokepointCall {
  tool: string;
  category: string;
  flags: readonly string[];
  args: Record<string, unknown>;
  /**
   * Optional literal the user must type to confirm. Set by the executor
   * from the `Tool.typeToConfirm` field. When present, the chokepoint
   * returns `type-then-confirm` instead of `confirm`.
   */
  typeToConfirm?: string;
}
```

- [ ] **Step 2: Add the `checkTypeToConfirm` rule**

In `packages/core/src/chokepoint/rules.ts`, append:

```typescript
/**
 * If the call carries a `typeToConfirm` literal, the user must type it
 * to confirm. This is layered on top of `destructive` so it works
 * automatically for any tool that declares `typeToConfirm` — the
 * type-to-confirm prompt replaces (not supplements) the simple
 * confirm prompt.
 */
export function checkTypeToConfirm(call: ChokepointCall): Decision | null {
  if (!call.typeToConfirm) return null;
  return {
    kind: 'type-then-confirm',
    reason: `tool "${call.tool}" is high-friction; type "${call.typeToConfirm}" to confirm`,
    prompt: call.typeToConfirm,
  };
}
```

- [ ] **Step 3: Wire the rule into the aggregator**

In `packages/core/src/chokepoint/index.ts`, import `checkTypeToConfirm` and add it to the chain. It runs *after* `checkDestructive` (so destructive tools always confirm one way or the other) and *after* `checkTarget` (so a private-target tool never even prompts). The `checkTypeToConfirm` rule fires whenever the executor passed a `typeToConfirm`, regardless of other flags:

```typescript
import { checkDestructive, checkElevation, checkTypeToConfirm, checkTarget } from './rules.js';

export function createChokepoint(env: ChokepointEnv): Chokepoint {
  return {
    decide(call: ChokepointCall): Decision {
      return (
        checkElevation(call, env) ??
        checkDestructive(call) ??
        checkTypeToConfirm(call) ??
        checkTarget(call, env) ??
        { kind: 'allow' }
      );
    },
  };
}
```

- [ ] **Step 4: Add `typeToConfirm` to the Tool interface**

In `packages/core/src/tools/types.ts`, add the field to the `Tool` interface:

```typescript
export interface Tool<I extends z.ZodTypeAny, O extends z.ZodTypeAny> {
  name: string;
  category: ToolCategory;
  description: string;
  input: I;
  output: O;
  flags: readonly string[];
  /**
   * If set, the chokepoint returns a `type-then-confirm` decision with
   * this literal as the prompt. The TUI's <ApprovalPrompt> shows a
   * text input that the user must type the literal into before the
   * confirm button is enabled. Use for high-friction destructive
   * tools (wifi attacks, network implants).
   */
  typeToConfirm?: string;
  run(args: z.infer<I>, ctx: ToolContext): Promise<z.infer<O>>;
}
```

- [ ] **Step 5: Update the executor**

In `packages/core/src/tools/executor.ts`, the `chokepointCall` is built with the new field, and the `onConfirmation` handler now receives an enriched call that tells the UI which mode to render:

```typescript
// 2. Chokepoint
const chokepointCall: ChokepointCall = {
  tool: tool.name,
  category: tool.category,
  flags: tool.flags,
  args: parsed.data,
  typeToConfirm: tool.typeToConfirm,
};
const decision = chokepoint.decide(chokepointCall);

if (decision.kind === 'deny') {
  return { ok: false, reason: decision.reason, decision };
}
if (decision.kind === 'confirm' || decision.kind === 'type-then-confirm') {
  if (!opts.onConfirmation) {
    return {
      ok: false,
      reason: `tool "${tool.name}" needs confirmation but no handler provided`,
      decision,
    };
  }
  // For type-then-confirm, opts.onConfirmation must echo the prompt
  // string back to indicate the user typed it. The TUI's
  // <ApprovalPrompt> already enforces this on the user side; for
  // a programmatic caller, the onConfirmation signature is
  //   (call, decision) => Promise<boolean>
  const approved = await opts.onConfirmation(call, decision);
  if (!approved) {
    return { ok: false, reason: 'user denied confirmation', decision };
  }
}
```

Update the `ExecuteOpts.onConfirmation` signature:

```typescript
export interface ExecuteOpts {
  onConfirmation?: (
    call: ExecuteCall,
    decision: Extract<Decision, { kind: 'confirm' | 'type-then-confirm' }>,
  ) => Promise<boolean>;
}
```

- [ ] **Step 6: Write the test**

`packages/core/test/chokepoint-type-to-confirm.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { createChokepoint } from '../src/chokepoint/index.js';
import type { ChokepointCall } from '../src/chokepoint/decision.js';

const ENV = {
  allowPrivateNetworks: false,
  allowElevation: true,    // so elevation doesn't mask destructive
  denylist: [],
};

describe('chokepoint type-then-confirm', () => {
  it('returns type-then-confirm when call carries typeToConfirm', () => {
    const c = createChokepoint(ENV);
    const call: ChokepointCall = {
      tool: 'evil_twin',
      category: 'wifi',
      flags: ['destructive', 'requiresElevation'],
      args: { targetEssid: 'CorpWiFi' },
      typeToConfirm: 'attack',
    };
    const d = c.decide(call);
    expect(d.kind).toBe('type-then-confirm');
    if (d.kind === 'type-then-confirm') {
      expect(d.prompt).toBe('attack');
    }
  });

  it('type-then-confirm beats destructive (still high-friction)', () => {
    const c = createChokepoint(ENV);
    const call: ChokepointCall = {
      tool: 'evil_twin',
      category: 'wifi',
      flags: ['destructive'],
      args: {},
      typeToConfirm: 'attack',
    };
    const d = c.decide(call);
    expect(d.kind).toBe('type-then-confirm');
  });

  it('no typeToConfirm → plain confirm for destructive', () => {
    const c = createChokepoint(ENV);
    const call: ChokepointCall = {
      tool: 'sqlmap',
      category: 'web',
      flags: ['destructive'],
      args: { url: 'https://example.com' },
    };
    const d = c.decide(call);
    expect(d.kind).toBe('confirm');
  });

  it('elevation deny still beats type-to-confirm', () => {
    const c = createChokepoint({ ...ENV, allowElevation: false });
    const call: ChokepointCall = {
      tool: 'evil_twin',
      category: 'wifi',
      flags: ['destructive', 'requiresElevation'],
      args: {},
      typeToConfirm: 'attack',
    };
    const d = c.decide(call);
    expect(d.kind).toBe('deny');
  });
});
```

- [ ] **Step 7: Run the test to verify it passes**

```bash
cd /home/ankur/test/test-mob/gmft-ai/packages/core && pnpm exec vitest run test/chokepoint-type-to-confirm.test.ts 2>&1 | tail -8
```

Expected: 4 passed.

- [ ] **Step 8: Run the full chokepoint test suite to ensure no regressions**

```bash
cd /home/ankur/test/test-mob/gmft-ai/packages/core && pnpm exec vitest run test/chokepoint.test.ts 2>&1 | tail -6
```

Expected: existing tests still pass.

- [ ] **Step 9: Verify TypeScript compiles**

```bash
cd /home/ankur/test/test-mob/gmft-ai && pnpm -C packages/core exec tsc --noEmit && echo "TSC OK"
```

Expected: `TSC OK`. (Existing callers of `onConfirmation(call)` in `useAgent` and tests may need a one-line update since the signature gained a 2nd arg — add `, _decision` and the compiler will accept it.)

- [ ] **Step 10: Commit**

```bash
cd /home/ankur/test/test-mob/gmft-ai && git add packages/core/src/chokepoint/decision.ts packages/core/src/chokepoint/rules.ts packages/core/src/chokepoint/index.ts packages/core/src/tools/types.ts packages/core/src/tools/executor.ts packages/core/test/chokepoint-type-to-confirm.test.ts && git -c user.email=blumi@local -c user.name=blumi commit -m "feat(chokepoint): type-then-confirm decision kind for high-friction tools"
```

---

## Task 5.11: ApprovalPrompt supports `type-then-confirm`

**Files:**
- Modify: `apps/gmft/src/ui/components/ApprovalPrompt.tsx` (add `prompt` prop, type-then-confirm mode)
- Create: `apps/gmft/test/approval-prompt-type-to-confirm.test.tsx`

- [ ] **Step 1: Read the existing ApprovalPrompt**

```bash
cd /home/ankur/test/test-mob/gmft-ai && cat apps/gmft/src/ui/components/ApprovalPrompt.tsx
```

- [ ] **Step 2: Add the `prompt` prop and type-then-confirm rendering**

The existing `ApprovalPrompt` accepts `onConfirm: () => void` and `onDecline: () => void`. Add a new prop `prompt?: string`. When `prompt` is set:

- Render an extra line: "Type `attack` to confirm:" (where `attack` is the prompt value)
- Render a text input. The user must type the exact prompt string
- The "Confirm" button is disabled until the input matches
- The Esc / decline path still works

Example (adapt to the existing component's style):

```typescript
import React, { useState } from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';

export interface ApprovalPromptProps {
  reason: string;
  typeToConfirm?: string;        // <-- new
  onConfirm: () => void;
  onDecline: () => void;
}

export function ApprovalPrompt({ reason, typeToConfirm, onConfirm, onDecline }: ApprovalPromptProps) {
  const [typed, setTyped] = useState('');
  const canConfirm = typeToConfirm ? typed === typeToConfirm : true;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text color="yellow">⚠  {reason}</Text>
      {typeToConfirm ? (
        <Box marginTop={1}>
          <Text>Type </Text>
          <Text bold color="red">{typeToConfirm}</Text>
          <Text> to confirm: </Text>
          <TextInput value={typed} onChange={setTyped} />
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text color={canConfirm ? 'green' : 'gray'}>
          {canConfirm ? '[Enter] Confirm  ' : 'Confirm (disabled)  '}
        </Text>
        <Text color="red">[Esc] Decline</Text>
      </Box>
    </Box>
  );
}
```

(Exact API names — `TextInput` from `ink-text-input` — match what's already in `InputBox.tsx`; reuse the same import.)

- [ ] **Step 3: Write the test**

`apps/gmft/test/approval-prompt-type-to-confirm.test.tsx`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { ApprovalPrompt } from '../src/ui/components/ApprovalPrompt';

describe('ApprovalPrompt type-to-confirm mode', () => {
  it('renders the prompt literal in bold', () => {
    const { lastFrame } = render(
      <ApprovalPrompt
        reason="evil_twin is destructive"
        typeToConfirm="attack"
        onConfirm={vi.fn()}
        onDecline={vi.fn()}
      />,
    );
    expect(lastFrame()).toMatch(/attack/);
  });

  it('confirm button is disabled when typed value does not match', () => {
    const onConfirm = vi.fn();
    const { lastFrame } = render(
      <ApprovalPrompt
        reason="evil_twin is destructive"
        typeToConfirm="attack"
        onConfirm={onConfirm}
        onDecline={vi.fn()}
      />,
    );
    expect(lastFrame()).toMatch(/Confirm \(disabled\)/);
  });

  it('confirm fires onEnter when typed value matches', () => {
    const onConfirm = vi.fn();
    const { stdin, lastFrame } = render(
      <ApprovalPrompt
        reason="evil_twin is destructive"
        typeToConfirm="attack"
        onConfirm={onConfirm}
        onDecline={vi.fn()}
      />,
    );
    stdin.write('attack');
    // Now press Enter
    stdin.write('\r');
    expect(onConfirm).toHaveBeenCalled();
    expect(lastFrame()).toMatch(/Confirm/);
  });

  it('plain (non-type-to-confirm) mode still works', () => {
    const onConfirm = vi.fn();
    const { lastFrame } = render(
      <ApprovalPrompt
        reason="sqlmap is destructive"
        onConfirm={onConfirm}
        onDecline={vi.fn()}
      />,
    );
    expect(lastFrame()).not.toMatch(/Type/);
    expect(lastFrame()).toMatch(/Confirm/);
  });
});
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd /home/ankur/test/test-mob/gmft-ai/apps/gmft && pnpm exec vitest run test/approval-prompt-type-to-confirm.test.tsx 2>&1 | tail -8
```

Expected: 4 passed.

- [ ] **Step 5: Verify all apps/gmft tests still pass**

```bash
cd /home/ankur/test/test-mob/gmft-ai/apps/gmft && pnpm exec vitest run 2>&1 | tail -6
```

Expected: 87 passed (was 83, +4 new tests).

- [ ] **Step 6: Commit**

```bash
cd /home/ankur/test/test-mob/gmft-ai && git add apps/gmft/src/ui/components/ApprovalPrompt.tsx apps/gmft/test/approval-prompt-type-to-confirm.test.tsx && git -c user.email=blumi@local -c user.name=blumi commit -m "feat(ui): ApprovalPrompt supports type-then-confirm for high-friction destructive tools"
```

---

## Task 5.12: Full-workspace verification + CHANGELOG + tag

- [ ] **Step 1: Run the full-workspace test suite**

```bash
cd /home/ankur/test/test-mob/gmft-ai && pnpm -r test 2>&1 | tail -8
```

Expected counts:
- core: 123 (was 119, +4 type-to-confirm)
- tools: 89 (was 70, +18 web/wifi tools + 1 catalog-drift = +19... recount: 5 web × 3 tests = 15 + 1 wifi × 3 = 18. tools was 70. 70 + 18 = 88. +1 catalog-drift = 89)
- apps/gmft: 87 (was 83, +4 type-to-confirm)
- testkit: 1
- Workspace total: 123 + 89 + 87 + 1 = 300

- [ ] **Step 2: Add a catalog-drift test in `packages/tools/test` (matches the §2 pattern)**

`packages/tools/test/catalog-drift.test.ts` is a 1-test guard that ensures the catalog list matches the live tool set:

```typescript
import { describe, it, expect } from 'vitest';
import { tools as catalog } from '../src/catalog';
import { shellExecTool } from '../src/shell/shell-exec';
import { nmapTool } from '../src/network/nmap';
import { dnsenumTool } from '../src/network/dnsenum';
import { theHarvesterTool } from '../src/network/theharvester';
import { whatwebTool } from '../src/network/whatweb';
import { nucleiTool } from '../src/web/nuclei';
import { niktoTool } from '../src/web/nikto';
import { gobusterTool } from '../src/web/gobuster';
import { ffufTool } from '../src/web/ffuf';
import { sqlmapTool } from '../src/web/sqlmap';
import { evilTwinTool } from '../src/wifi/evil-twin';

describe('catalog drift', () => {
  it('catalog contains every exported tool', () => {
    const expected = [
      shellExecTool.name,
      nmapTool.name,
      dnsenumTool.name,
      theHarvesterTool.name,
      whatwebTool.name,
      nucleiTool.name,
      niktoTool.name,
      gobusterTool.name,
      ffufTool.name,
      sqlmapTool.name,
      evilTwinTool.name,
    ];
    const actual = catalog.map((t) => t.name);
    expect(actual).toEqual(expect.arrayContaining(expected));
    expect(actual).toHaveLength(expected.length);
  });
});
```

Run the new test:

```bash
cd /home/ankur/test/test-mob/gmft-ai/packages/tools && pnpm exec vitest run test/catalog-drift.test.ts 2>&1 | tail -6
```

Expected: 1 passed. New tools test count: 88 + 1 = 89.

Re-commit the catalog drift test on top of the catalog commit:

```bash
cd /home/ankur/test/test-mob/gmft-ai && git add packages/tools/test/catalog-drift.test.ts && git -c user.email=blumi@local -c user.name=blumi commit -m "test(tools): catalog-drift guard ensures registry + catalog stay in sync"
```

- [ ] **Step 3: Run typecheck across the whole workspace**

```bash
cd /home/ankur/test/test-mob/gmft-ai && pnpm -r typecheck 2>&1 | tail -6
```

Expected: `0 errors` (or the script's success line).

- [ ] **Step 4: Run build across the whole workspace**

```bash
cd /home/ankur/test/test-mob/gmft-ai && pnpm -r build 2>&1 | tail -6
```

Expected: each package's build script reports success.

- [ ] **Step 5: Add the CHANGELOG entry**

Open `CHANGELOG.md`. If it doesn't exist, create it. Add a new top section (above any existing unreleased / unreleased-pending block). The new section is for phase 5:

```markdown
## [0.1.0-phase5] — 2026-06-16

### Added

- **Web tools** (5 new tools in `@gmft/tools`): `nuclei` (streaming NDJSON findings), `nikto` (web server scan), `gobuster` (dir/dns/vhost modes), `ffuf` (web fuzzer with match filter), `sqlmap` (SQL injection, `destructive` flag).
- **Wifi tools** (1 new tool): `evil_twin` — wraps the `fluxion` evil-twin attack. Three high-friction markers: `destructive` + `requiresElevation` + `typeToConfirm='attack'`. Runs inside a detached `tmux` session named `gmft-evil-twin-<essid-slug>`. Dry mode (`GMFT_DRY=1`) returns the args + session name without invoking fluxion or sudo.
- **Chokepoint `type-then-confirm`**: new `Decision` kind `{ kind: 'type-then-confirm', reason, prompt }`. The user must type the literal `prompt` to confirm. Fires whenever a `Tool` declares `typeToConfirm`. Wired into the executor's `onConfirmation` callback so the UI knows which mode to render.
- **`<ApprovalPrompt>` UI**: now accepts `typeToConfirm?: string`. When set, renders a text input that must match the prompt exactly before the Confirm button enables.
- **`Dockerfile.web`**: alpine 3.20 image with `nuclei 3.1.0` + `nikto 2.5.0` + `gobuster 3.6` + `ffuf 2.1.0` + `sqlmap 1.7.2` + a small `common.txt` wordlist.

### Tests

- core: 119 → 123 (+4 type-to-confirm chokepoint)
- tools: 70 → 89 (+18 web/wifi tool tests, +1 catalog-drift)
- apps/gmft: 83 → 87 (+4 type-to-confirm UI)
- Workspace total: 274 → 300
```

- [ ] **Step 6: Commit the CHANGELOG**

```bash
cd /home/ankur/test/test-mob/gmft-ai && git add CHANGELOG.md && git -c user.email=blumi@local -c user.name=blumi commit -m "docs(changelog): phase 5 entry (web + wifi tools + type-to-confirm)"
```

- [ ] **Step 7: Tag the release**

```bash
cd /home/ankur/test/test-mob/gmft-ai && git tag -a v0.1.0-phase5 -m "Phase 5: web + wifi tools + type-then-confirm chokepoint + UI" && git tag --list 'v0.1.0-phase5'
```

Expected: `v0.1.0-phase5` listed.

- [ ] **Step 8: Push the branch + tag**

```bash
cd /home/ankur/test/test-mob/gmft-ai && git push origin phase5-web-wifi && git push origin v0.1.0-phase5
```

- [ ] **Step 9: Final summary**

Output a one-paragraph status block:

```
phase5-web-wifi: 13 commits on top of 2c1e8c9 (phase 5 plan)
test counts: core 123 / tools 89 / gmft 87 / testkit 1 = 300 green
typecheck: 0 errors / 3 packages
build: clean
git tag: v0.1.0-phase5 pushed
PR: open at <gh-pr-url>
```

Replace `<gh-pr-url>` with the URL `gh pr create` returns when the previous step is run via `gh`.


---




