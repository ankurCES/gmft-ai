# Phase 4 — Network & OSINT recon tools

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship 4 read-only recon tools (nmap, dnsenum, theharvester, whatweb) + `Finding` model + JSONL `FindingsStore` + `useAgent`/AgentApp wiring (LLM can actually call tools) + populated `FindingsTab` + network Docker image. Reconnaissance via chat becomes a real user story.

**Architecture:** New `Finding` + `FindingsStore` in `@gmft/core/findings/` (append-only JSONL, redacted like session log). New `stream.ts` helper in `@gmft/tools/shared/` (vs the existing `run` which buffers). Four `Tool<I,O>` implementations in `@gmft/tools/network/`, each in `category: 'recon'` with `flags: ['targetRequired']` (no destructive, no elevation). `useAgent` opts widen additively (all new opts optional). `AgentApp` builds a `ToolRegistry` + `createChokepoint` and threads them through. `FindingsTab` subscribes to the `FindingsStore`.

**Tech Stack:** TypeScript ESM, vitest 2.1, ink-testing-library 4.0, ai SDK 4.3.19, zod 3.23 (already a dep). Zero new top-level deps. Docker for the network sandbox image.

**Test budget:** 32 new tests. 233 → **265** passing.

**Branch:** `phase4-recon-tools` (created from `main` HEAD `da6ee31`).

**Worktree:** `/home/ankur/test/test-mob/gmft-ai/.worktrees/phase4-recon-tools`. The worktree is fresh; pnpm install + a per-package `pnpm build` are required to make the existing 233 tests pass (workspace packages are not pre-built).

**Plan conventions:**
- **Working directory for `pnpm`:** `pwd` resets to `/home/ankur` per Bash tool behavior. Always `cd /home/ankur/test/test-mob/gmft-ai/.worktrees/phase4-recon-tools && pnpm ...` or use `pnpm -C <path> ...`.
- **All file paths below are relative to repo root** unless noted.
- **TDD discipline:** every task starts with a failing test, then the minimum impl to make it pass, then a commit.

**Acceptance criteria (this plan is "done" when all true):**

- [ ] `packages/core` exports `Finding`, `FindingSeverity`, `FindingsStore`, `findingsPath`, `findingsDir`.
- [ ] `FindingsStore.append(...)` writes one redacted JSONL line atomically; `FindingsStore.list()` returns `Finding[]`.
- [ ] `nmap`, `dnsenum`, `theharvester`, `whatweb` each pass: (a) `parseNmapXml(...)` roundtrip test against a fixture, (b) `tool.run(input, ctx)` test that mocks the runner and asserts the right `argv` + parsed output.
- [ ] `useAgent` accepts `tools` + `chokepoint` + `onConfirmation` + `onToolResult`; forwards to `runTurn`. Existing 3 `useAgent.test.tsx` cases pass unchanged.
- [ ] `AgentApp` builds a real chokepoint and passes `tools` + `chokepoint` + `onToolResult` to `useAgent`.
- [ ] `FindingsTab` shows a sortable table; empty-state still works.
- [ ] `prompts.ts` agent prompt has the "Tool use" section instructing the model to surface findings.
- [ ] `docker/Dockerfile.network` builds.
- [ ] `pnpm -r build` green. `pnpm -r test` green (265 tests). `pnpm -r typecheck` green. The 233 prior tests still pass — no regressions in `chokepoint`, `tools-registry`, `tools-executor`, `shell-exec`, `agent-loop`, or the TUI.
- [ ] CHANGELOG entry for v0.1.0-phase4. Tag `v0.1.0-phase4` created.
- [ ] PR opened from `phase4-recon-tools` → `main`.

---

## File map

### New files
- `packages/core/src/findings/index.ts` — `Finding` zod schema + type
- `packages/core/src/findings/store.ts` — `FindingsStore` (in-memory + JSONL persistence, append-only, redacted)
- `packages/core/test/findings.test.ts` — 1 test file (5 tests)
- `packages/tools/src/shared/stream.ts` — `spawnStreaming` helper
- `packages/tools/src/network/nmap.ts` — nmap tool
- `packages/tools/src/network/dnsenum.ts` — dnsenum tool
- `packages/tools/src/network/theharvester.ts` — theHarvester tool
- `packages/tools/src/network/whatweb.ts` — whatweb tool
- `packages/tools/src/network/index.ts` — barrel
- `packages/tools/test/shared/stream.test.ts` — 1 test file (4 tests)
- `packages/tools/test/network/nmap.test.ts` — 1 test file (4 tests)
- `packages/tools/test/network/dnsenum.test.ts` — 1 test file (4 tests)
- `packages/tools/test/network/theharvester.test.ts` — 1 test file (4 tests)
- `packages/tools/test/network/whatweb.test.ts` — 1 test file (4 tests)
- `packages/tools/test/network/fixtures/{nmap,dnsenum,theharvester,whatweb}-sample.{xml,txt,ndjson}` — recorded sample outputs
- `docker/Dockerfile.network` — alpine + recon binaries
- `apps/gmft/test/findings-tab.test.tsx` — 1 test file (3 tests)
- `apps/gmft/test/useAgent-tools.test.tsx` — 1 test file (3 tests)

### Modified files
- `packages/core/src/index.ts` — re-export `findings/`, bump `VERSION` to `'0.1.0-phase4'`
- `packages/tools/src/index.ts` — re-export `network/` and `shared/stream`
- `packages/tools/src/catalog.ts` — append the 4 recon tools
- `apps/gmft/src/ui/hooks/useAgent.ts` — widen opts (additive)
- `apps/gmft/src/AgentApp.tsx` — build registry + chokepoint; pass to useAgent; wire tool-result → store
- `apps/gmft/src/ui/tabs/FindingsTab.tsx` — real table view
- `packages/core/src/llm/prompts.ts` — one new "Tool use" section
- `packages/core/test/prompts.test.ts` — 1 new test
- `CHANGELOG.md` — `0.1.0-phase4` entry

### Not changing
- `agent/loop.ts` — `runTurn` already accepts `tools` + `chokepoint` + `onConfirmation` from phase 3. No change.
- `tools/executor.ts` — unchanged. The 4 new tools go through the same `Allow` flow.
- `chokepoint/{decision,rules,index,policy}.ts` — unchanged. The new tools have `targetRequired` only.
- `tools/registry.ts` — unchanged. The new tools are registered in `useAgent`/`AgentApp`, not in a static registry.
- Config schema (`config.ts`) — unchanged. `chokepoint.allowPrivateNetworks` and `allowElevation` already exist.

---

## Tasks

## Task 1: Finding type + FindingsStore

**Files:**
- Create: `packages/core/src/findings/index.ts`
- Create: `packages/core/src/findings/store.ts`
- Create: `packages/core/test/findings.test.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/findings.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FindingsStore, type Finding } from '../src/findings/store.js';

const sampleFinding: Finding = {
  id: '01HZX5K9P3Y8V2M4F6T8B0N7QC',
  tool: 'nmap',
  target: 'scanme.nmap.org',
  severity: 'medium',
  title: 'Open port 22/tcp (ssh)',
  description: 'SSH service exposed',
  evidence: '22/tcp open ssh OpenSSH 6.6.1p1',
  ts: 1700000000000,
};

describe('FindingsStore', () => {
  let dir: string;
  let store: FindingsStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gmft-findings-'));
    store = new FindingsStore({ sessionId: 'test-session', baseDir: dir });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('append + list roundtrips in memory', async () => {
    await store.append(sampleFinding);
    expect(store.list()).toEqual([sampleFinding]);
  });

  it('persists to JSONL on disk', async () => {
    await store.append(sampleFinding);
    const path = join(dir, 'test-session.jsonl');
    expect(existsSync(path)).toBe(true);
    const text = readFileSync(path, 'utf8');
    expect(text.endsWith('\n')).toBe(true); // trailing newline (read_line rule)
    const parsed = JSON.parse(text.trim());
    expect(parsed).toEqual(sampleFinding);
  });

  it('redacts secret-shaped values in evidence', async () => {
    await store.append({
      ...sampleFinding,
      evidence: 'curl -H "Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz1234567890" https://x',
    });
    const text = readFileSync(join(dir, 'test-session.jsonl'), 'utf8');
    expect(text).toContain('Authorization: [REDACTED]');
    expect(text).not.toContain('sk-abcdefghijklmnopqrstuvwxyz');
  });

  it('list() reloads from disk if baseDir is set on a fresh instance', async () => {
    await store.append(sampleFinding);
    const store2 = new FindingsStore({ sessionId: 'test-session', baseDir: dir });
    expect(store2.list()).toEqual([sampleFinding]);
  });

  it('list() returns [] when file does not exist', () => {
    expect(store.list()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/ankur/test/test-mob/gmft-ai/.worktrees/phase4-recon-tools && pnpm vitest run packages/core/test/findings.test.ts`
Expected: FAIL with "Cannot find module '../src/findings/store.js'"

- [ ] **Step 3: Write the Finding type**

Create `packages/core/src/findings/index.ts`:

```ts
import { z } from 'zod';

export const SeveritySchema = z.enum(['info', 'low', 'medium', 'high', 'critical']);
export type Severity = z.infer<typeof SeveritySchema>;

export const FindingSchema = z.object({
  id: z.string().min(1),
  tool: z.string().min(1),
  target: z.string().min(1),
  severity: SeveritySchema,
  title: z.string().min(1),
  description: z.string().optional(),
  evidence: z.string().optional(),
  ts: z.number().int().nonnegative(),
});

export type Finding = z.infer<typeof FindingSchema>;
```

- [ ] **Step 4: Write the FindingsStore**

Create `packages/core/src/findings/store.ts`:

```ts
import { appendFile, readFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { redactSecrets } from '../session/log.js';
import { FindingSchema, type Finding } from './index.js';

export interface FindingsStoreOpts {
  sessionId: string;
  baseDir: string;
}

export class FindingsStore {
  private readonly path: string;
  private cache: Finding[] | null = null;

  constructor(private readonly opts: FindingsStoreOpts) {
    this.path = join(opts.baseDir, `${opts.sessionId}.jsonl`);
  }

  /**
   * Append a finding. Validates against the Zod schema, redacts
   * secret-shaped strings from `evidence` + `description`, writes
   * one JSON object per line, trailing newline (the read_line rule
   * from the session log work).
   */
  async append(finding: Finding): Promise<void> {
    const parsed = FindingSchema.parse(finding);
    const line = JSON.stringify(parsed) + '\n';
    const safe = redactSecrets(line);
    if (!existsSync(this.opts.baseDir)) {
      await mkdir(this.opts.baseDir, { recursive: true });
    }
    await appendFile(this.path, safe, 'utf8');
    this.cache = null;
  }

  /**
   * Read all findings for this session. Returns `[]` if the file
   * doesn't exist. Results are parsed through `FindingSchema.parse`
   * so malformed lines throw clearly.
   *
   * Synchronous because the in-memory cache is synchronous. For
   * larger logs this would move to async; v0.1 findings count is
   * <100 per session.
   */
  list(): Finding[] {
    if (this.cache) return this.cache;
    if (!existsSync(this.path)) {
      this.cache = [];
      return this.cache;
    }
    const text = readFileSync(this.path, 'utf8');
    const out: Finding[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      out.push(FindingSchema.parse(JSON.parse(line)));
    }
    this.cache = out;
    return out;
  }
}
```

- [ ] **Step 5: Re-export from core barrel**

Modify `packages/core/src/index.ts`. Find the existing exports and add (in the appropriate section — right after the `chokepoint/` exports, before `tools/`):

```ts
export { FindingSchema, SeveritySchema, type Finding, type Severity } from './findings/index.js';
export { FindingsStore, type FindingsStoreOpts } from './findings/store.js';
```

Also change the `VERSION` const at the top:
```ts
export const VERSION = '0.1.0-phase4';
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd /home/ankur/test/test-mob/gmft-ai/.worktrees/phase4-recon-tools && pnpm vitest run packages/core/test/findings.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 7: Confirm no regression**

Run: `cd /home/ankur/test/test-mob/gmft-ai/.worktrees/phase4-recon-tools && pnpm -C packages/core build && pnpm vitest run packages/core/test/`
Expected: 128 tests pass (123 prior + 5 new)

- [ ] **Step 8: Commit**

```bash
cd /home/ankur/test/test-mob/gmft-ai/.worktrees/phase4-recon-tools
git add packages/core/src/findings/ packages/core/src/index.ts packages/core/test/findings.test.ts
git -c user.email=blumi@local -c user.name=blumi commit -m "feat(findings): Finding type + FindingsStore (append-only JSONL, redacted)"
```

---

## Task 2: spawnStreaming helper

**Files:**
- Create: `packages/tools/src/shared/stream.ts`
- Create: `packages/tools/test/shared/stream.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/tools/test/shared/stream.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { spawnStreaming } from '../../src/shared/stream';

describe('spawnStreaming', () => {
  it('collects stdout and stderr to completion', async () => {
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const r = await spawnStreaming({
      argv: ['node', '-e', 'process.stdout.write("hi"); process.stderr.write("bye")'],
      onStdout: (b) => stdoutChunks.push(b),
      onStderr: (b) => stderrChunks.push(b),
      timeoutMs: 5000,
    });
    expect(r.exitCode).toBe(0);
    expect(stdoutChunks.join('')).toBe('hi');
    expect(stderrChunks.join('')).toBe('bye');
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('fires onStdout multiple times for chunked output', async () => {
    let count = 0;
    await spawnStreaming({
      argv: [
        'node',
        '-e',
        'for (let i=0;i<10;i++) process.stdout.write(`chunk ${i}\\n`)',
      ],
      onStdout: () => count++,
      timeoutMs: 5000,
    });
    expect(count).toBeGreaterThan(1);
  });

  it('rejects on non-zero exit code', async () => {
    await expect(
      spawnStreaming({
        argv: ['node', '-e', 'process.exit(7)'],
        onStdout: () => {},
        timeoutMs: 5000,
      }),
    ).rejects.toThrow(/exit code 7/);
  });

  it('rejects on timeout', async () => {
    await expect(
      spawnStreaming({
        argv: ['node', '-e', 'setTimeout(() => {}, 60000)'],
        onStdout: () => {},
        timeoutMs: 100,
      }),
    ).rejects.toThrow(/timed out/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/ankur/test/test-mob/gmft-ai/.worktrees/phase4-recon-tools && pnpm vitest run packages/tools/test/shared/stream.test.ts`
Expected: FAIL with "Cannot find module '../../src/shared/stream'"

- [ ] **Step 3: Write the helper**

Create `packages/tools/src/shared/stream.ts`:

```ts
import { spawn } from 'node:child_process';

export interface SpawnStreamingOpts {
  /** Args to exec. No shell, no chaining. */
  argv: string[];
  /** Called for every stdout chunk. */
  onStdout: (chunk: string) => void;
  /** Called for every stderr chunk. */
  onStderr: (chunk: string) => void;
  /** Default 30s. */
  timeoutMs?: number;
  /** Working directory. */
  cwd?: string;
  /** Env override. Defaults to filtered process.env. */
  env?: NodeJS.ProcessEnv;
}

export interface SpawnStreamingResult {
  exitCode: number;
  durationMs: number;
}

/**
 * Spawn a child process and stream its stdout/stderr to the given
 * callbacks. Distinct from `run` in `./runner.ts` which buffers
 * stdout — this is for tools that produce a lot of output and the
 * caller wants to see it live (nuclei, nikto in phase 5; reserved
 * for those, not used by the 4 phase 4 tools which all use the
 * existing buffered `run`).
 */
export function spawnStreaming(opts: SpawnStreamingOpts): Promise<SpawnStreamingResult> {
  const { argv, onStdout, onStderr, timeoutMs = 30_000, cwd, env } = opts;
  if (argv.length === 0) {
    return Promise.reject(new Error('spawnStreaming called with empty argv'));
  }
  const [bin, ...rest] = argv;
  const start = Date.now();
  return new Promise<SpawnStreamingResult>((resolve, reject) => {
    const child = spawn(bin!, rest, {
      cwd,
      env: env ?? { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    child.stdout.on('data', (b: Buffer) => onStdout(b.toString()));
    child.stderr.on('data', (b: Buffer) => onStderr(b.toString()));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`spawnStreaming timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`spawnStreaming: ${bin} exited with code ${code}`));
        return;
      }
      resolve({ exitCode: code, durationMs: Date.now() - start });
    });
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/ankur/test/test-mob/gmft-ai/.worktrees/phase4-recon-tools && pnpm vitest run packages/tools/test/shared/stream.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
cd /home/ankur/test/test-mob/gmft-ai/.worktrees/phase4-recon-tools
git add packages/tools/src/shared/stream.ts packages/tools/test/shared/stream.test.ts
git -c user.email=blumi@local -c user.name=blumi commit -m "feat(tools): spawnStreaming helper for live-output tool processes"
```

---

## Task 3: nmap tool

**Files:**
- Create: `packages/tools/test/network/fixtures/nmap-sample.xml`
- Create: `packages/tools/src/network/nmap.ts`
- Create: `packages/tools/test/network/nmap.test.ts`

- [ ] **Step 1: Create the fixture**

Create `packages/tools/test/network/fixtures/nmap-sample.xml`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE nmaprun>
<nmaprun scanner="nmap" args="nmap -oX - scanme.nmap.org" start="1700000000" version="7.94">
  <host>
    <status state="up"/>
    <address addr="45.33.32.156" addrtype="ipv4"/>
    <hostnames><hostname name="scanme.nmap.org" type="user"/></hostnames>
    <ports>
      <port protocol="tcp" portid="22">
        <state state="open" reason="syn-ack"/>
        <service name="ssh" product="OpenSSH" version="6.6.1p1"/>
      </port>
      <port protocol="tcp" portid="80">
        <state state="open" reason="syn-ack"/>
        <service name="http" product="Apache httpd" version="2.4.7"/>
      </port>
      <port protocol="tcp" portid="443">
        <state state="closed" reason="reset"/>
        <service name="https"/>
      </port>
    </ports>
  </host>
  <runstats>
    <finished time="1700000123" elapsed="123.45"/>
  </runstats>
</nmaprun>
```

- [ ] **Step 2: Write the failing test**

Create `packages/tools/test/network/nmap.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Mock the runner so we don't actually shell out in tests.
vi.mock('../../src/shared/runner', () => ({
  run: vi.fn(async () => ({
    mode: 'docker' as const,
    stdout: readFileSync(join(__dirname, 'fixtures/nmap-sample.xml'), 'utf8'),
    stderr: '',
    exitCode: 0,
    durationMs: 1234,
    fellBack: false,
  })),
}));

import { nmapTool } from '../../src/network/nmap';
import { run } from '../../src/shared/runner';

const HOST_CTX = {
  cwd: process.cwd(),
  env: { ...process.env },
  cfg: { sandbox: { mode: 'host' as const } },
};

describe('nmapTool', () => {
  it('has the right metadata', () => {
    expect(nmapTool.name).toBe('nmap');
    expect(nmapTool.category).toBe('recon');
    expect(nmapTool.flags).toEqual(['targetRequired']);
  });

  it('parses nmap XML into hosts + findings', async () => {
    const out = await nmapTool.run({ target: 'scanme.nmap.org', timing: 'T4' }, HOST_CTX);
    expect(out.hosts).toHaveLength(1);
    const host = out.hosts[0]!;
    expect(host.address).toBe('45.33.32.156');
    expect(host.hostname).toBe('scanme.nmap.org');
    expect(host.ports).toHaveLength(3);
    const open22 = out.findings.find((f) => f.title.includes('22/tcp'));
    expect(open22?.severity).toBe('medium');
    expect(open22?.evidence).toContain('ssh');
    expect(out.xml).toContain('<nmaprun');
    expect(out.durationMs).toBe(1234);
    expect(out.mode).toBe('docker');
  });

  it('emits one finding per open port', async () => {
    const out = await nmapTool.run({ target: 'scanme.nmap.org' }, HOST_CTX);
    const openFindings = out.findings.filter((f) =>
      f.title.startsWith('Open port') || f.title.startsWith('Filtered port'),
    );
    // 2 open + 1 closed. Closed = no finding (per the parser spec).
    expect(openFindings).toHaveLength(2);
  });

  it('forwards the target to nmap and uses gmft/network:0.1 image', async () => {
    await nmapTool.run({ target: 'scanme.nmap.org', ports: '22,80', timing: 'T5' }, HOST_CTX);
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        argv: expect.arrayContaining(['nmap', '-oX', '-', '-p', '22,80', '-T5', 'scanme.nmap.org']),
        image: 'gmft/network:0.1',
      }),
    );
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd /home/ankur/test/test-mob/gmft-ai/.worktrees/phase4-recon-tools && pnpm vitest run packages/tools/test/network/nmap.test.ts`
Expected: FAIL with "Cannot find module '../../src/network/nmap'"

- [ ] **Step 4: Write the nmap tool**

Create `packages/tools/src/network/nmap.ts`:

```ts
import { z } from 'zod';
import type { Tool, ToolContext } from '@gmft/core';
import { FindingSchema, type Finding } from '@gmft/core';
import { run } from '../shared/runner';

export const NmapInput = z.object({
  target: z.string().describe('Hostname or IPv4 to scan'),
  ports: z.string().optional().describe('e.g. "22,80,443" or "1-1024"'),
  scripts: z.string().optional().describe('nmap --script argument (phase 5+)'),
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
      product: z.string().optional(),
      version: z.string().optional(),
    })),
  })),
  findings: z.array(FindingSchema),
  durationMs: z.number().int().nonnegative(),
  mode: z.enum(['docker', 'host']),
  fellBack: z.boolean(),
});

export type NmapInputT = z.infer<typeof NmapInput>;
export type NmapOutputT = z.infer<typeof NmapOutput>;

interface ParsedHost {
  address: string;
  hostname?: string;
  ports: Array<{
    port: number;
    protocol: string;
    state: string;
    service?: string;
    product?: string;
    version?: string;
  }>;
}

/**
 * Hand-rolled nmap -oX XML parser. v0.1 supports the subset of fields
 * the Finding model needs: host address, hostname, port number,
 * protocol, state, service name, product, version. Re-evaluate if
 * -sV output needs DOM-level fidelity (we currently do regex on
 * attribute strings, which is good enough for the 4-field shape).
 */
export function parseNmapXml(xml: string): ParsedHost[] {
  const hosts: ParsedHost[] = [];
  const hostBlocks = xml.match(/<host>[\s\S]*?<\/host>/g) ?? [];
  for (const block of hostBlocks) {
    const statusMatch = block.match(/<status\s+state="([^"]+)"/);
    if (statusMatch?.[1] !== 'up') continue;
    const addrMatch = block.match(/<address\s+addr="([^"]+)"\s+addrtype="ipv4"/);
    if (!addrMatch) continue;
    const hostnameMatch = block.match(/<hostname\s+name="([^"]+)"\s+type="user"/);
    const ports: ParsedHost['ports'] = [];
    const portBlocks = block.match(/<port[\s\S]*?<\/port>/g) ?? [];
    for (const p of portBlocks) {
      const protoMatch = p.match(/<port\s+protocol="([^"]+)"\s+portid="(\d+)"/);
      if (!protoMatch) continue;
      const protocol = protoMatch[1]!;
      const port = parseInt(protoMatch[2]!, 10);
      const stateMatch = p.match(/<state\s+state="([^"]+)"/);
      const state = stateMatch?.[1] ?? 'unknown';
      const svcName = p.match(/<service\s+name="([^"]+)"/)?.[1];
      const svcProduct = p.match(/<service\s+[^>]*product="([^"]+)"/)?.[1];
      const svcVersion = p.match(/<service\s+[^>]*version="([^"]+)"/)?.[1];
      ports.push({
        port,
        protocol,
        state,
        service: svcName,
        product: svcProduct,
        version: svcVersion,
      });
    }
    hosts.push({
      address: addrMatch[1]!,
      hostname: hostnameMatch?.[1],
      ports,
    });
  }
  return hosts;
}

export function nmapFindings(hosts: ParsedHost[], target: string, now: number): Finding[] {
  const out: Finding[] = [];
  for (const h of hosts) {
    for (const p of h.ports) {
      if (p.state !== 'open' && p.state !== 'filtered') continue;
      const severity = p.state === 'open' ? 'medium' : 'low';
      const product = [p.product, p.version].filter(Boolean).join(' ');
      out.push({
        id: `${target}-${p.port}-${p.protocol}-${now}`.replace(/[^a-zA-Z0-9-]/g, '-'),
        tool: 'nmap',
        target,
        severity,
        title: `${p.state === 'open' ? 'Open' : 'Filtered'} port ${p.port}/${p.protocol}${p.service ? ` (${p.service})` : ''}`,
        description: product ? `${p.service ?? 'service'} ${product}`.trim() : undefined,
        evidence: `${p.port}/${p.protocol} ${p.state} ${p.service ?? ''} ${product}`.trim(),
        ts: now,
      });
    }
  }
  return out;
}

export const nmapTool: Tool<typeof NmapInput, typeof NmapOutput> = {
  name: 'nmap',
  category: 'recon',
  description:
    'TCP port scan via nmap. Read-only; chokepoint gates the target format + private-network denylist. ' +
    'Returns parsed hosts + ports and one Finding per open or filtered port.',
  input: NmapInput,
  output: NmapOutput,
  flags: ['targetRequired'],
  async run(input: NmapInputT, _ctx: ToolContext): Promise<NmapOutputT> {
    const argv = [
      'nmap', '-oX', '-',
      ...(input.ports ? ['-p', input.ports] : []),
      ...(input.scripts ? ['--script', input.scripts] : []),
      `-${input.timing}`,
      input.target,
    ];
    const r = await run({ argv, image: 'gmft/network:0.1', timeoutMs: 120_000 });
    const hosts = parseNmapXml(r.stdout);
    const findings = nmapFindings(hosts, input.target, Date.now());
    return {
      xml: r.stdout,
      hosts,
      findings,
      durationMs: r.durationMs,
      mode: r.mode,
      fellBack: r.fellBack,
    };
  },
};
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd /home/ankur/test/test-mob/gmft-ai/.worktrees/phase4-recon-tools && pnpm vitest run packages/tools/test/network/nmap.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 6: Commit**

```bash
cd /home/ankur/test/test-mob/gmft-ai/.worktrees/phase4-recon-tools
git add packages/tools/src/network/nmap.ts packages/tools/test/network/nmap.test.ts packages/tools/test/network/fixtures/nmap-sample.xml
git -c user.email=blumi@local -c user.name=blumi commit -m "feat(tools): nmap tool — TCP port scan with hand-rolled XML parser + Findings"
```

---

## Task 4: dnsenum tool

**Files:**
- Create: `packages/tools/test/network/fixtures/dnsenum-sample.txt`
- Create: `packages/tools/src/network/dnsenum.ts`
- Create: `packages/tools/test/network/dnsenum.test.ts`

- [ ] **Step 1: Create the fixture**

Create `packages/tools/test/network/fixtures/dnsenum-sample.txt`:

```
Host's addresses:
example.com                                  93.184.216.34

Name Servers:
ns1.example.com                              93.184.216.34
ns2.example.com                              93.184.216.35

MX (Mail Exchange) record(s):
mail.example.com                             pref=10

Trying zone transfer on example.com...
AXFR failed.

Brute forcing hostnames on example.com:
www.example.com                              93.184.216.34
mail.example.com                             93.184.216.34
```

- [ ] **Step 2: Write the failing test**

Create `packages/tools/test/network/dnsenum.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('../../src/shared/runner', () => ({
  run: vi.fn(async () => ({
    mode: 'docker' as const,
    stdout: readFileSync(join(__dirname, 'fixtures/dnsenum-sample.txt'), 'utf8'),
    stderr: '',
    exitCode: 0,
    durationMs: 567,
    fellBack: false,
  })),
}));

import { dnsenumTool } from '../../src/network/dnsenum';

const HOST_CTX = {
  cwd: process.cwd(),
  env: { ...process.env },
  cfg: { sandbox: { mode: 'host' as const } },
};

describe('dnsenumTool', () => {
  it('has the right metadata', () => {
    expect(dnsenumTool.name).toBe('dnsenum');
    expect(dnsenumTool.category).toBe('recon');
    expect(dnsenumTool.flags).toEqual(['targetRequired']);
  });

  it('parses host addresses + nameservers + MX', async () => {
    const out = await dnsenumTool.run({ domain: 'example.com' }, HOST_CTX);
    expect(out.records.length).toBeGreaterThan(0);
    expect(out.records.find((r) => r.host === 'example.com')?.address).toBe('93.184.216.34');
    expect(out.nameservers).toContain('ns1.example.com');
    expect(out.nameservers).toContain('ns2.example.com');
    expect(out.mx.find((m) => m.host === 'mail.example.com')?.pref).toBe(10);
  });

  it('emits one Finding per discovered host', async () => {
    const out = await dnsenumTool.run({ domain: 'example.com' }, HOST_CTX);
    const hostFindings = out.findings.filter((f) => f.title.startsWith('Host '));
    expect(hostFindings.length).toBeGreaterThanOrEqual(4); // root + www + mail + 2 NS
  });

  it('forwards the domain to dnsenum and uses --noreverse -o -', async () => {
    const { run } = await import('../../src/shared/runner');
    await dnsenumTool.run({ domain: 'example.com' }, HOST_CTX);
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        argv: expect.arrayContaining(['dnsenum', '--noreverse', '-o', '-', 'example.com']),
        image: 'gmft/network:0.1',
      }),
    );
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd /home/ankur/test/test-mob/gmft-ai/.worktrees/phase4-recon-tools && pnpm vitest run packages/tools/test/network/dnsenum.test.ts`
Expected: FAIL with "Cannot find module '../../src/network/dnsenum'"

- [ ] **Step 4: Write the dnsenum tool**

Create `packages/tools/src/network/dnsenum.ts`:

```ts
import { z } from 'zod';
import type { Tool, ToolContext } from '@gmft/core';
import { FindingSchema, type Finding } from '@gmft/core';
import { run } from '../shared/runner';

export const DnsenumInput = z.object({
  domain: z.string().describe('Domain to enumerate (must not be an IP)'),
});

export const DnsenumRecord = z.object({
  host: z.string(),
  address: z.string().optional(),
});

export const DnsenumMx = z.object({
  host: z.string(),
  pref: z.number().int(),
});

export const DnsenumOutput = z.object({
  raw: z.string(),
  records: z.array(DnsenumRecord),
  nameservers: z.array(z.string()),
  mx: z.array(DnsenumMx),
  findings: z.array(FindingSchema),
  durationMs: z.number().int().nonnegative(),
  mode: z.enum(['docker', 'host']),
  fellBack: z.boolean(),
});

export type DnsenumInputT = z.infer<typeof DnsenumInput>;
export type DnsenumOutputT = z.infer<typeof DnsenumOutput>;

interface Parsed {
  records: Array<{ host: string; address?: string }>;
  nameservers: string[];
  mx: Array<{ host: string; pref: number }>;
}

/**
 * Parse dnsenum's plaintext output. We split by section headers
 * ("Host's addresses:", "Name Servers:", "MX (Mail Exchange) record(s):")
 * and parse each section. dnsenum emits lines like
 * `example.com    93.184.216.34` — split on 2+ spaces.
 */
export function parseDnsenum(text: string): Parsed {
  const out: Parsed = { records: [], nameservers: [], mx: [] };
  const lines = text.split('\n');

  let section: 'hosts' | 'ns' | 'mx' | null = null;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.startsWith("Host's addresses:") || line.includes("Host's addresses:")) {
      section = 'hosts'; continue;
    }
    if (line.startsWith('Name Servers:')) { section = 'ns'; continue; }
    if (line.startsWith('MX (Mail Exchange) record(s):')) { section = 'mx'; continue; }
    if (line === '' || line.startsWith('-') || line.startsWith('Trying') || line.startsWith('Brute')) {
      section = null; continue;
    }
    if (section === 'hosts') {
      const m = line.match(/^(\S+)\s{2,}(\S+)/);
      if (m) out.records.push({ host: m[1]!, address: m[2] });
    } else if (section === 'ns') {
      const m = line.match(/^(\S+)/);
      if (m) out.nameservers.push(m[1]!);
    } else if (section === 'mx') {
      const m = line.match(/^(\S+)\s+pref=(\d+)/);
      if (m) out.mx.push({ host: m[1]!, pref: parseInt(m[2]!, 10) });
    }
  }
  return out;
}

export function dnsenumFindings(parsed: Parsed, domain: string, now: number): Finding[] {
  const out: Finding[] = [];
  const seen = new Set<string>();
  const add = (host: string, address: string | undefined, title: string): void => {
    const key = `${host}|${address ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      id: `${domain}-${host}-${now}`.replace(/[^a-zA-Z0-9.-]/g, '-'),
      tool: 'dnsenum',
      target: domain,
      severity: 'info',
      title: title || `Host ${host}`,
      description: address ? `${host} → ${address}` : undefined,
      evidence: address ? `${host} ${address}` : host,
      ts: now,
    });
  };
  for (const r of parsed.records) add(r.host, r.address, `Host ${r.host}`);
  for (const ns of parsed.nameservers) add(ns, undefined, `Nameserver ${ns}`);
  for (const m of parsed.mx) add(m.host, undefined, `MX ${m.host} (pref ${m.pref})`);
  return out;
}

export const dnsenumTool: Tool<typeof DnsenumInput, typeof DnsenumOutput> = {
  name: 'dnsenum',
  category: 'recon',
  description:
    'DNS enumeration via dnsenum (--noreverse). Discovers host addresses, nameservers, and MX records. ' +
    'Read-only; chokepoint gates the target format + private-network denylist.',
  input: DnsenumInput,
  output: DnsenumOutput,
  flags: ['targetRequired'],
  async run(input: DnsenumInputT, _ctx: ToolContext): Promise<DnsenumOutputT> {
    const r = await run({
      argv: ['dnsenum', '--noreverse', '-o', '-', input.domain],
      image: 'gmft/network:0.1',
      timeoutMs: 60_000,
    });
    const parsed = parseDnsenum(r.stdout);
    const findings = dnsenumFindings(parsed, input.domain, Date.now());
    return {
      raw: r.stdout,
      records: parsed.records,
      nameservers: parsed.nameservers,
      mx: parsed.mx,
      findings,
      durationMs: r.durationMs,
      mode: r.mode,
      fellBack: r.fellBack,
    };
  },
};
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd /home/ankur/test/test-mob/gmft-ai/.worktrees/phase4-recon-tools && pnpm vitest run packages/tools/test/network/dnsenum.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 6: Commit**

```bash
cd /home/ankur/test/test-mob/gmft-ai/.worktrees/phase4-recon-tools
git add packages/tools/src/network/dnsenum.ts packages/tools/test/network/dnsenum.test.ts packages/tools/test/network/fixtures/dnsenum-sample.txt
git -c user.email=blumi@local -c user.name=blumi commit -m "feat(tools): dnsenum tool — DNS enumeration with --noreverse + Findings"
```

---

## Task 5: theHarvester tool

**Files:**
- Create: `packages/tools/test/network/fixtures/theharvester-sample.txt`
- Create: `packages/tools/src/network/theharvester.ts`
- Create: `packages/tools/test/network/theharvester.test.ts`

- [ ] **Step 1: Create the fixture**

Create `packages/tools/test/network/fixtures/theharvester-sample.txt`:

```
*******************************************************************
* _   _                           _              _                *
*| |_| |__   ___    /\  /\__ _  __| |_ __ ___  __| | ___ _ __      *
*| __| '_ \ / _ \  / /_/ / _` |/ _` | '__/ _ \/ _` |/ _ \ '__|     *
*| |_| | | |  __/ / __  / (_| | (_| | | |  __/ (_| |  __/ |        *
* \__|_| |_|\___| \/ /_/ \__,_|\__,_|_|  \___|\__,_|\___|_|        *
*                                                                 *
* theHarvester 4.4.0                                              *
* Coded by Christian Martorella                                   *
* Edge-Security Research                                          *
* cmartorella@edge-security.com                                    *
*******************************************************************

[*] Target domain: example.com
[*] Wordlist / DNS enum: too many results to enumerate

[*] Searching Google.
[*] Certificates databases: crt.sh
[*] Emails found: 3
---------------------
info@example.com
admin@example.com
noc@example.com

[*] Hosts found: 2
---------------------
example.com:93.184.216.34
www.example.com:93.184.216.34

[*] URLs found: 1
---------------------
https://example.com/about
```

- [ ] **Step 2: Write the failing test**

Create `packages/tools/test/network/theharvester.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('../../src/shared/runner', () => ({
  run: vi.fn(async () => ({
    mode: 'docker' as const,
    stdout: readFileSync(join(__dirname, 'fixtures/theharvester-sample.txt'), 'utf8'),
    stderr: '',
    exitCode: 0,
    durationMs: 8901,
    fellBack: false,
  })),
}));

import { theHarvesterTool } from '../../src/network/theharvester';

const HOST_CTX = {
  cwd: process.cwd(),
  env: { ...process.env },
  cfg: { sandbox: { mode: 'host' as const } },
};

describe('theHarvesterTool', () => {
  it('has the right metadata', () => {
    expect(theHarvesterTool.name).toBe('theharvester');
    expect(theHarvesterTool.category).toBe('recon');
    expect(theHarvesterTool.flags).toEqual(['targetRequired']);
  });

  it('parses emails + hosts + urls', async () => {
    const out = await theHarvesterTool.run(
      { domain: 'example.com', sources: ['google'], limit: 100 },
      HOST_CTX,
    );
    expect(out.emails).toEqual(['info@example.com', 'admin@example.com', 'noc@example.com']);
    expect(out.hosts).toEqual([
      { host: 'example.com', address: '93.184.216.34' },
      { host: 'www.example.com', address: '93.184.216.34' },
    ]);
    expect(out.urls).toEqual(['https://example.com/about']);
  });

  it('emits one finding per email/host/url', async () => {
    const out = await theHarvesterTool.run(
      { domain: 'example.com', sources: ['google'], limit: 100 },
      HOST_CTX,
    );
    // 3 emails + 2 hosts + 1 url = 6
    expect(out.findings).toHaveLength(6);
    expect(out.findings.filter((f) => f.title.startsWith('Email '))).toHaveLength(3);
    expect(out.findings.filter((f) => f.title.startsWith('Host '))).toHaveLength(2);
    expect(out.findings.filter((f) => f.title.startsWith('URL '))).toHaveLength(1);
  });

  it('forwards domain + sources + limit to theHarvester', async () => {
    const { run } = await import('../../src/shared/runner');
    await theHarvesterTool.run(
      { domain: 'example.com', sources: ['google', 'crtsh'], limit: 50 },
      HOST_CTX,
    );
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        argv: expect.arrayContaining([
          'theHarvester', '-d', 'example.com', '-b', 'google,crtsh', '-l', '50', '-f', '-',
        ]),
        image: 'gmft/network:0.1',
      }),
    );
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd /home/ankur/test/test-mob/gmft-ai/.worktrees/phase4-recon-tools && pnpm vitest run packages/tools/test/network/theharvester.test.ts`
Expected: FAIL with "Cannot find module '../../src/network/theharvester'"

- [ ] **Step 4: Write the theHarvester tool**

Create `packages/tools/src/network/theharvester.ts`:

```ts
import { z } from 'zod';
import type { Tool, ToolContext } from '@gmft/core';
import { FindingSchema, type Finding } from '@gmft/core';
import { run } from '../shared/runner';

export const TheHarvesterInput = z.object({
  domain: z.string().describe('Domain to harvest'),
  sources: z.array(z.string()).default(['google']).describe('Data sources (e.g. google, bing, crtsh)'),
  limit: z.number().int().positive().default(100).describe('Per-source result cap'),
});

export const TheHarvesterOutput = z.object({
  raw: z.string(),
  emails: z.array(z.string()),
  hosts: z.array(z.object({ host: z.string(), address: z.string().optional() })),
  urls: z.array(z.string()),
  findings: z.array(FindingSchema),
  durationMs: z.number().int().nonnegative(),
  mode: z.enum(['docker', 'host']),
  fellBack: z.boolean(),
});

export type TheHarvesterInputT = z.infer<typeof TheHarvesterInput>;
export type TheHarvesterOutputT = z.infer<typeof TheHarvesterOutput>;

interface Parsed {
  emails: string[];
  hosts: Array<{ host: string; address?: string }>;
  urls: string[];
}

/**
 * Parse theHarvester's plaintext output. Sections are:
 *   [*] Emails found: N
 *   [<list of emails>]
 *   [*] Hosts found: N
 *   [<list of host:ip>]
 *   [*] URLs found: N
 *   [<list of urls>]
 */
export function parseTheHarvester(text: string): Parsed {
  const out: Parsed = { emails: [], hosts: [], urls: [] };
  const lines = text.split('\n');
  let section: 'emails' | 'hosts' | 'urls' | null = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('[*] Emails found:')) { section = 'emails'; continue; }
    if (line.startsWith('[*] Hosts found:')) { section = 'hosts'; continue; }
    if (line.startsWith('[*] URLs found:')) { section = 'urls'; continue; }
    if (line === '' || line.startsWith('---') || line.startsWith('[*]') || line.startsWith('*')) {
      section = null; continue;
    }
    if (section === 'emails' && line.includes('@')) {
      out.emails.push(line);
    } else if (section === 'hosts') {
      const m = line.match(/^([^:]+):(\S+)/);
      if (m) out.hosts.push({ host: m[1]!, address: m[2] });
      else out.hosts.push({ host: line });
    } else if (section === 'urls' && (line.startsWith('http://') || line.startsWith('https://'))) {
      out.urls.push(line);
    }
  }
  return out;
}

export function theHarvesterFindings(parsed: Parsed, domain: string, now: number): Finding[] {
  const out: Finding[] = [];
  for (const e of parsed.emails) {
    out.push({
      id: `email-${e}-${now}`.replace(/[^a-zA-Z0-9.@_-]/g, '-'),
      tool: 'theharvester',
      target: domain,
      severity: 'low',
      title: `Email ${e}`,
      description: `Email address discovered via OSINT: ${e}`,
      evidence: e,
      ts: now,
    });
  }
  for (const h of parsed.hosts) {
    out.push({
      id: `host-${h.host}-${now}`.replace(/[^a-zA-Z0-9.-]/g, '-'),
      tool: 'theharvester',
      target: domain,
      severity: 'info',
      title: `Host ${h.host}`,
      description: h.address ? `${h.host} → ${h.address}` : undefined,
      evidence: h.address ? `${h.host} ${h.address}` : h.host,
      ts: now,
    });
  }
  for (const u of parsed.urls) {
    out.push({
      id: `url-${u}-${now}`.replace(/[^a-zA-Z0-9.:/_-]/g, '-'),
      tool: 'theharvester',
      target: domain,
      severity: 'info',
      title: `URL ${u}`,
      evidence: u,
      ts: now,
    });
  }
  return out;
}

export const theHarvesterTool: Tool<typeof TheHarvesterInput, typeof TheHarvesterOutput> = {
  name: 'theharvester',
  category: 'recon',
  description:
    'OSINT harvesting via theHarvester. Discovers emails, hosts, and URLs from public sources. ' +
    'Read-only; chokepoint gates the target format + private-network denylist.',
  input: TheHarvesterInput,
  output: TheHarvesterOutput,
  flags: ['targetRequired'],
  async run(input: TheHarvesterInputT, _ctx: ToolContext): Promise<TheHarvesterOutputT> {
    const r = await run({
      argv: [
        'theHarvester', '-d', input.domain,
        '-b', input.sources.join(','),
        '-l', String(input.limit),
        '-f', '-',
      ],
      image: 'gmft/network:0.1',
      timeoutMs: 120_000,
    });
    const parsed = parseTheHarvester(r.stdout);
    const findings = theHarvesterFindings(parsed, input.domain, Date.now());
    return {
      raw: r.stdout,
      emails: parsed.emails,
      hosts: parsed.hosts,
      urls: parsed.urls,
      findings,
      durationMs: r.durationMs,
      mode: r.mode,
      fellBack: r.fellBack,
    };
  },
};
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd /home/ankur/test/test-mob/gmft-ai/.worktrees/phase4-recon-tools && pnpm vitest run packages/tools/test/network/theharvester.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 6: Commit**

```bash
cd /home/ankur/test/test-mob/gmft-ai/.worktrees/phase4-recon-tools
git add packages/tools/src/network/theharvester.ts packages/tools/test/network/theharvester.test.ts packages/tools/test/network/fixtures/theharvester-sample.txt
git -c user.email=blumi@local -c user.name=blumi commit -m "feat(tools): theHarvester tool — OSINT email/host/URL harvesting + Findings"
```

---

## Task 6: whatweb tool

**Files:**
- Create: `packages/tools/test/network/fixtures/whatweb-sample.ndjson`
- Create: `packages/tools/src/network/whatweb.ts`
- Create: `packages/tools/test/network/whatweb.test.ts`

- [ ] **Step 1: Create the fixture (NDJSON, one Target per line)**

Create `packages/tools/test/network/fixtures/whatweb-sample.ndjson`:

```
{"target":"https://example.com","http_status":200,"plugins":{"HTTPServer":{"string":["Apache/2.4.7"]},"WebFramework":{"string":["PHP/5.6.40"]},"Title":{"string":["Example Domain"]},"IP":{"string":["93.184.216.34"]},"Country":{"string":["UNITED STATES","US"]}}}
{"target":"https://example.com","http_status":200,"plugins":{"HTTPServer":{"string":["Apache/2.4.7"]},"X-Powered-By":{"string":["PHP/5.6.40"]},"HTML5":{},"Script":{},"HTTPSupported":{}}}
```

- [ ] **Step 2: Write the failing test**

Create `packages/tools/test/network/whatweb.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('../../src/shared/runner', () => ({
  run: vi.fn(async () => ({
    mode: 'docker' as const,
    stdout: readFileSync(join(__dirname, 'fixtures/whatweb-sample.ndjson'), 'utf8'),
    stderr: '',
    exitCode: 0,
    durationMs: 432,
    fellBack: false,
  })),
}));

import { whatwebTool } from '../../src/network/whatweb';

const HOST_CTX = {
  cwd: process.cwd(),
  env: { ...process.env },
  cfg: { sandbox: { mode: 'host' as const } },
};

describe('whatwebTool', () => {
  it('has the right metadata', () => {
    expect(whatwebTool.name).toBe('whatweb');
    expect(whatwebTool.category).toBe('recon');
    expect(whatwebTool.flags).toEqual(['targetRequired']);
  });

  it('parses NDJSON into technologies', async () => {
    const out = await whatwebTool.run({ url: 'https://example.com' }, HOST_CTX);
    expect(out.technologies.length).toBeGreaterThan(0);
    const techs = out.technologies.map((t) => t.name);
    expect(techs).toContain('HTTPServer');
    expect(techs).toContain('WebFramework');
    expect(techs).toContain('Title');
    const apache = out.technologies.find((t) => t.name === 'HTTPServer');
    expect(apache?.value).toContain('Apache');
  });

  it('emits one finding per technology', async () => {
    const out = await whatwebTool.run({ url: 'https://example.com' }, HOST_CTX);
    expect(out.findings.length).toBe(out.technologies.length);
    out.findings.forEach((f) => {
      expect(f.tool).toBe('whatweb');
      expect(f.target).toBe('https://example.com');
      expect(f.title).toMatch(/^Tech /);
    });
  });

  it('forwards the url to whatweb with --log-json=- and --no-errors -q', async () => {
    const { run } = await import('../../src/shared/runner');
    await whatwebTool.run({ url: 'https://example.com', aggression: 1 }, HOST_CTX);
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        argv: expect.arrayContaining([
          'whatweb', '--no-errors', '-q', '--log-json=-', '-a', '1', 'https://example.com',
        ]),
        image: 'gmft/network:0.1',
      }),
    );
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd /home/ankur/test/test-mob/gmft-ai/.worktrees/phase4-recon-tools && pnpm vitest run packages/tools/test/network/whatweb.test.ts`
Expected: FAIL with "Cannot find module '../../src/network/whatweb'"

- [ ] **Step 4: Write the whatweb tool**

Create `packages/tools/src/network/whatweb.ts`:

```ts
import { z } from 'zod';
import type { Tool, ToolContext } from '@gmft/core';
import { FindingSchema, type Finding } from '@gmft/core';
import { run } from '../shared/runner';

export const WhatwebInput = z.object({
  url: z.string().url().describe('Target URL (https://...)'),
  aggression: z.number().int().min(1).max(4).default(1).describe('1=passive, 4=heavy'),
});

export const WhatwebOutput = z.object({
  technologies: z.array(z.object({
    name: z.string(),
    value: z.string().optional(),
  })),
  findings: z.array(FindingSchema),
  durationMs: z.number().int().nonnegative(),
  mode: z.enum(['docker', 'host']),
  fellBack: z.boolean(),
});

export type WhatwebInputT = z.infer<typeof WhatwebInput>;
export type WhatwebOutputT = z.infer<typeof WhatwebOutput>;

interface Tech { name: string; value?: string }

/**
 * Parse whatweb's --log-json=- NDJSON output. Each line is a Target
 * object; we flatten the `plugins` map into Technology rows. Multiple
 * lines per URL are merged (deduped by name+value).
 */
export function parseWhatweb(ndjson: string): Tech[] {
  const out: Tech[] = [];
  const seen = new Set<string>();
  for (const line of ndjson.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(trimmed); } catch { continue; }
    if (typeof parsed !== 'object' || parsed === null) continue;
    const plugins = (parsed as { plugins?: Record<string, { string?: string[] }> }).plugins;
    if (!plugins) continue;
    for (const [name, info] of Object.entries(plugins)) {
      const value = info?.string?.[0];
      const key = `${name}|${value ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ name, value });
    }
  }
  return out;
}

export function whatwebFindings(techs: Tech[], url: string, now: number): Finding[] {
  return techs.map((t) => ({
    id: `whatweb-${t.name}-${now}`.replace(/[^a-zA-Z0-9._-]/g, '-'),
    tool: 'whatweb',
    target: url,
    severity: 'info',
    title: `Tech ${t.name}${t.value ? ` (${t.value})` : ''}`,
    description: t.value,
    evidence: t.value,
    ts: now,
  }));
}

export const whatwebTool: Tool<typeof WhatwebInput, typeof WhatwebOutput> = {
  name: 'whatweb',
  category: 'recon',
  description:
    'Web technology fingerprinting via whatweb. Discovers HTTP server, frameworks, ' +
    'and other tech from response headers + body. Read-only.',
  input: WhatwebInput,
  output: WhatwebOutput,
  flags: ['targetRequired'],
  async run(input: WhatwebInputT, _ctx: ToolContext): Promise<WhatwebOutputT> {
    const r = await run({
      argv: [
        'whatweb', '--no-errors', '-q', '--log-json=-',
        '-a', String(input.aggression),
        input.url,
      ],
      image: 'gmft/network:0.1',
      timeoutMs: 60_000,
    });
    const techs = parseWhatweb(r.stdout);
    const findings = whatwebFindings(techs, input.url, Date.now());
    return {
      technologies: techs,
      findings,
      durationMs: r.durationMs,
      mode: r.mode,
      fellBack: r.fellBack,
    };
  },
};
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd /home/ankur/test/test-mob/gmft-ai/.worktrees/phase4-recon-tools && pnpm vitest run packages/tools/test/network/whatweb.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 6: Commit**

```bash
cd /home/ankur/test/test-mob/gmft-ai/.worktrees/phase4-recon-tools
git add packages/tools/src/network/whatweb.ts packages/tools/test/network/whatweb.test.ts packages/tools/test/network/fixtures/whatweb-sample.ndjson
git -c user.email=blumi@local -c user.name=blumi commit -m "feat(tools): whatweb tool — web tech fingerprinting + Findings"
```

---

## Task 7: catalog + barrel + Dockerfile

**Files:**
- Create: `packages/tools/src/network/index.ts`
- Modify: `packages/tools/src/index.ts`
- Modify: `packages/tools/src/catalog.ts`
- Create: `docker/Dockerfile.network`

- [ ] **Step 1: Create the network barrel**

Create `packages/tools/src/network/index.ts`:

```ts
export { nmapTool, NmapInput, NmapOutput, parseNmapXml, nmapFindings } from './nmap';
export { dnsenumTool, DnsenumInput, DnsenumOutput, parseDnsenum, dnsenumFindings } from './dnsenum';
export { theHarvesterTool, TheHarvesterInput, TheHarvesterOutput, parseTheHarvester, theHarvesterFindings } from './theharvester';
export { whatwebTool, WhatwebInput, WhatwebOutput, parseWhatweb, whatwebFindings } from './whatweb';
```

- [ ] **Step 2: Update the package barrel**

Modify `packages/tools/src/index.ts`. The current file is approximately:

```ts
export * from './shared/prereq';
export * from './shared/runner';
export * from './shell/shell-exec';
export { tools, shellExecTool } from './catalog';
```

Replace with:

```ts
export * from './shared/prereq';
export * from './shared/runner';
export * from './shared/stream';
export * from './shell/shell-exec';
export * from './network';
export { tools, shellExecTool, nmapTool, dnsenumTool, theHarvesterTool, whatwebTool } from './catalog';
```

- [ ] **Step 3: Update the catalog**

Modify `packages/tools/src/catalog.ts`. Replace its entire body with:

```ts
import { shellExecTool } from './shell/shell-exec';
import { nmapTool } from './network/nmap';
import { dnsenumTool } from './network/dnsenum';
import { theHarvesterTool } from './network/theharvester';
import { whatwebTool } from './network/whatweb';

/**
 * Default tool registry exposed by @gmft/tools. Apps that want a
 * different set of tools can build their own ToolRegistry via
 * `@gmft/core`.
 *
 * Phase 4 adds 4 read-only recon tools (nmap, dnsenum, theharvester,
 * whatweb). All four are `category: 'recon'` with
 * `flags: ['targetRequired']` — no destructive, no elevation. The
 * chokepoint's existing `checkTarget` rule gates target format +
 * private-network denylist.
 */
export const tools: Array<{ name: string; category: string; flags: readonly string[] }> = [
  { name: shellExecTool.name, category: shellExecTool.category, flags: shellExecTool.flags },
  { name: nmapTool.name, category: nmapTool.category, flags: nmapTool.flags },
  { name: dnsenumTool.name, category: dnsenumTool.category, flags: dnsenumTool.flags },
  { name: theHarvesterTool.name, category: theHarvesterTool.category, flags: theHarvesterTool.flags },
  { name: whatwebTool.name, category: whatwebTool.category, flags: whatwebTool.flags },
];

export { shellExecTool, nmapTool, dnsenumTool, theHarvesterTool, whatwebTool };
```

- [ ] **Step 4: Create the Dockerfile**

Create `docker/Dockerfile.network`:

```dockerfile
# gmft/network:0.1 — phase 4 recon tools sandbox image.
#
# Used by the runner when a recon tool (nmap, dnsenum, theharvester,
# whatweb) is invoked. Phase 5 web tools will get their own image
# (gmft/web:0.1).
#
# Build:  docker build -f docker/Dockerfile.network -t gmft/network:0.1 .
# Run:    pnpm vitest run packages/tools/test/network/

FROM alpine:3.20

RUN apk add --no-cache \
      bash \
      bind-tools \
      ca-certificates \
      git \
      nmap \
      perl \
      python3 \
      py3-pip \
      ruby \
    && pip install --no-cache-dir --break-system-packages theHarvester \
    && apk add --no-cache ruby-dev ruby-json build-base \
    && gem install --no-document whatweb \
    && apk del build-base \
    && mkdir -p /work
WORKDIR /work
```

- [ ] **Step 5: Build the new tools package**

Run: `cd /home/ankur/test/test-mob/gmft-ai/.worktrees/phase4-recon-tools && pnpm -C packages/tools build`
Expected: compiles clean.

- [ ] **Step 6: Run all tools tests to verify nothing regressed**

Run: `cd /home/ankur/test/test-mob/gmft-ai/.worktrees/phase4-recon-tools && pnpm vitest run packages/tools/`
Expected: PASS (26 prior + 4 stream + 4×4 tool = 42 tests; the 4×4 = 16 tool tests add on top of 26 prior, plus 4 stream = 46)

- [ ] **Step 7: Commit**

```bash
cd /home/ankur/test/test-mob/gmft-ai/.worktrees/phase4-recon-tools
git add packages/tools/src/network/index.ts packages/tools/src/index.ts packages/tools/src/catalog.ts docker/Dockerfile.network
git -c user.email=blumi@local -c user.name=blumi commit -m "feat(tools): catalog + barrel include 4 recon tools; Dockerfile.network"
```

---

## Task 8: useAgent + AgentApp wiring (LLM can call tools)

**Files:**
- Modify: `apps/gmft/src/ui/hooks/useAgent.ts`
- Modify: `apps/gmft/src/AgentApp.tsx`
- Create: `apps/gmft/test/useAgent-tools.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `apps/gmft/test/useAgent-tools.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAgent } from '../src/ui/hooks/useAgent';
import type { AgentEvent } from '@gmft/core';

describe('useAgent — tools wiring', () => {
  it('forwards tools + chokepoint + onConfirmation to runTurn', async () => {
    const tools = [{ name: 'nmap' }];
    const chokepoint = { decide: vi.fn() };
    const onConfirmation = vi.fn(async () => true);
    let captured: Record<string, unknown> = {};
    const runTurn = vi.fn(async function* (args: Record<string, unknown>): AsyncIterable<AgentEvent> {
      captured = args;
      yield { type: 'text-delta', text: 'scanning' };
      yield { type: 'done', text: 'scanning' };
    });
    const onToolResult = vi.fn();

    const { result } = renderHook(() =>
      useAgent({
        system: 'test',
        runTurn: runTurn as never,
        tools,
        chokepoint: chokepoint as never,
        onConfirmation,
        onToolResult,
      }),
    );

    await act(async () => {
      result.current.submit('recon example.com');
      // wait one microtask for the async generator to be called
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(runTurn).toHaveBeenCalled();
    expect(captured.tools).toBe(tools);
    expect(captured.chokepoint).toBe(chokepoint);
    expect(captured.onConfirmation).toBe(onConfirmation);
  });

  it('does NOT forward tools when not provided (phase 2 compat)', async () => {
    let captured: Record<string, unknown> = {};
    const runTurn = vi.fn(async function* (args: Record<string, unknown>): AsyncIterable<AgentEvent> {
      captured = args;
      yield { type: 'text-delta', text: 'hi' };
      yield { type: 'done', text: 'hi' };
    });
    const { result } = renderHook(() =>
      useAgent({ system: 'test', runTurn: runTurn as never }),
    );
    await act(async () => {
      result.current.submit('hello');
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(captured.tools).toBeUndefined();
    expect(captured.chokepoint).toBeUndefined();
    expect(captured.onConfirmation).toBeUndefined();
  });

  it('invokes onToolResult with the tool output when a tool-result event arrives', async () => {
    const onToolResult = vi.fn();
    const runTurn = vi.fn(async function* (): AsyncIterable<AgentEvent> {
      yield { type: 'tool-result', id: 'c1', name: 'nmap', ok: true, output: { findings: [] } };
      yield { type: 'done', text: '' };
    });
    const { result } = renderHook(() =>
      useAgent({ system: 'test', runTurn: runTurn as never, onToolResult }),
    );
    await act(async () => {
      result.current.submit('go');
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(onToolResult).toHaveBeenCalledWith({ name: 'nmap', output: { findings: [] } });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/ankur/test/test-mob/gmft-ai/.worktrees/phase4-recon-tools && pnpm vitest run apps/gmft/test/useAgent-tools.test.tsx`
Expected: FAIL — `useAgent` doesn't accept `tools` / `chokepoint` / `onConfirmation` / `onToolResult` yet (TS error or "not forwarded" assertion failure).

- [ ] **Step 3: Widen useAgent opts (additive)**

Edit `apps/gmft/src/ui/hooks/useAgent.ts`. The current `UseAgentOpts` interface and the `runTurn` call site inside `submit` need to be modified.

Replace the `UseAgentOpts` interface block (the one starting with `export interface UseAgentOpts {` and ending with the `onError?` field) with:

```ts
export interface UseAgentOpts {
  /** System prompt (typically the output of `buildSystemPrompt('agent', env)`). */
  system: string;
  /** Optional initial history. */
  initialHistory?: readonly ChatMessage[];
  /**
   * The turn runner. v0.1 callers pass the real `runTurn` from
   * `@gmft/core`; tests pass a fake generator. Typed as a structural
   * shape so we don't have to import `runTurn` (which would force the
   * test to deal with the whole AI SDK module graph).
   */
  runTurn: (args: {
    system: string;
    history: readonly ChatMessage[];
    signal?: AbortSignal;
    tools?: ReadonlyArray<{ name: string }>;
    chokepoint?: { decide: (c: unknown) => unknown };
    onConfirmation?: (c: { id: string; name: string; args: Record<string, unknown>; reason: string }) => Promise<boolean>;
  }) => AsyncIterable<AgentEventLike>;
  /** Called whenever an error event arrives. */
  onError?: (err: Error) => void;
  // --- v0.1 phase 4 (all optional, additive; existing tests pass unchanged) ---
  /** Tools to expose to the LLM. When absent, the agent runs in phase 2/3 mode without tool calls. */
  tools?: ReadonlyArray<{ name: string }>;
  /** The chokepoint gate. Required iff `tools` is non-empty. */
  chokepoint?: { decide: (c: unknown) => unknown };
  /** Awaited when the chokepoint returns `confirm`. */
  onConfirmation?: (c: { id: string; name: string; args: Record<string, unknown>; reason: string }) => Promise<boolean>;
  /** Called for every `tool-result` event. Used by `FindingsTab` to capture structured findings. */
  onToolResult?: (r: { name: string; output: unknown }) => void;
}

/** Minimal AgentEvent shape useAgent consumes. Matches the real `AgentEvent` union from @gmft/core. */
type AgentEventLike =
  | { type: 'text-delta'; text: string }
  | { type: 'done'; text: string }
  | { type: 'error'; error: Error }
  | { type: 'tool-result'; id: string; name: string; ok: boolean; output?: unknown; reason?: string };
```

Now find the `submit` callback body where `opts.runTurn({...})` is called. Replace the `for await (const ev of opts.runTurn({...}))` line so it forwards the new opts. The current line is approximately:

```ts
for await (const ev of opts.runTurn({
  system: opts.system,
  history: sentHistory,
  signal: ac.signal,
})) {
```

Replace it with:

```ts
for await (const ev of opts.runTurn({
  system: opts.system,
  history: sentHistory,
  signal: ac.signal,
  ...(opts.tools ? { tools: opts.tools } : {}),
  ...(opts.chokepoint ? { chokepoint: opts.chokepoint } : {}),
  ...(opts.onConfirmation ? { onConfirmation: opts.onConfirmation } : {}),
})) {
```

Then inside the `for await` loop, add a new `else if` branch alongside the existing `text-delta` and `error` branches. The current loop is:

```ts
if (ev.type === 'text-delta') { ... }
else if (ev.type === 'error') { ... }
```

Add a new branch BEFORE the closing brace:

```ts
else if (ev.type === 'tool-result' && ev.ok && ev.output !== undefined) {
  opts.onToolResult?.({ name: ev.name, output: ev.output });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/ankur/test/test-mob/gmft-ai/.worktrees/phase4-recon-tools && pnpm -C packages/core build && pnpm -C packages/tools build && pnpm vitest run apps/gmft/test/useAgent-tools.test.tsx`
Expected: PASS (3 new tests).

Also confirm the 3 existing `useAgent.test.tsx` cases still pass:

Run: `cd /home/ankur/test/test-mob/gmft-ai/.worktrees/phase4-recon-tools && pnpm vitest run apps/gmft/test/useAgent.test.tsx`
Expected: PASS (3 tests, unchanged).

- [ ] **Step 5: Wire AgentApp to build registry + chokepoint + FindingsStore**

Edit `apps/gmft/src/AgentApp.tsx`. The current top imports + the `useAgent` call site need updates.

Add new imports at the top of the file (alongside the existing `@gmft/core` import). Find the existing import line and add after it:

```ts
import { ToolRegistry, createChokepoint, FindingsStore } from '@gmft/core';
import {
  shellExecTool,
  nmapTool,
  dnsenumTool,
  theHarvesterTool,
  whatwebTool,
} from '@gmft/tools';
import { homedir } from 'node:os';
import { join } from 'node:path';
```

In the body of `AgentApp`, near the top of the component (after the existing `useState` for `pendingApprovals`), add:

```ts
// Phase 4: build a tool registry from the 5 default tools (shell_exec
// + 4 recon) and a chokepoint from config.chokepoint. The
// FindingsStore accumulates structured output from every
// tool-result event.
const fullRegistry = useMemo(() => {
  const r = new ToolRegistry();
  r.register(shellExecTool);
  r.register(nmapTool);
  r.register(dnsenumTool);
  r.register(theHarvesterTool);
  r.register(whatwebTool);
  return r;
}, []);

const chokepoint = useMemo(() => {
  return createChokepoint({
    cfg: config.chokepoint ?? { allowPrivateNetworks: false, denylist: [] },
    env: {
      allowElevation: process.env.GMFT_ALLOW_ELEVATION === 'true',
      allowPrivateNetworks: process.env.GMFT_ALLOW_PRIVATE === 'true',
      denylist: config.chokepoint?.denylist ?? [],
    },
  });
}, [config.chokepoint]);

const findingsStore = useMemo(() => {
  const sessionId = session?.currentId?.() ?? 'default';
  return new FindingsStore({ sessionId, baseDir: join(homedir(), '.local', 'share', 'gmft', 'findings') });
}, [session]);

const [findingsCount, setFindingsCount] = useState(0);
```

Find the `useAgent` call (it currently has `{ system, runTurn, onError }` or similar). Replace it with:

```ts
const { history, streaming, error, submit, abort } = useAgent({
  system,
  runTurn: ((args) => runTurn({ model: llmModel, ...args })) as never,
  tools: fullRegistry.list().map((t) => ({ name: t.name })),
  chokepoint,
  onConfirmation,
  onToolResult: (r) => {
    if (r.name === 'nmap' || r.name === 'dnsenum' || r.name === 'theharvester' || r.name === 'whatweb') {
      const output = r.output as { findings?: Array<Record<string, unknown>> };
      if (output?.findings) {
        for (const f of output.findings) {
          // Type assertion: tools emit Finding-shaped objects. If
          // the schema is wrong the FindingsStore.append will throw
          // during parse.
          void findingsStore.append(f as never);
        }
        setFindingsCount((c) => c + output.findings.length);
      }
    }
  },
});
```

Note: `runTurn` from `@gmft/core` has the right `RunTurnOpts` shape; the cast `as never` is needed because useAgent's `runTurn` opt is a structural subset. Existing code in AgentApp probably already does something like this.

- [ ] **Step 6: Build + run all apps/gmft tests to verify no regression**

Run: `cd /home/ankur/test/test-mob/gmft-ai/.worktrees/phase4-recon-tools && pnpm -C packages/core build && pnpm -C packages/tools build && pnpm vitest run apps/gmft/`
Expected: 86 + 3 = 89 tests pass (no regressions in existing 86; 3 new from useAgent-tools).

- [ ] **Step 7: Commit**

```bash
cd /home/ankur/test/test-mob/gmft-ai/.worktrees/phase4-recon-tools
git add apps/gmft/src/ui/hooks/useAgent.ts apps/gmft/src/AgentApp.tsx apps/gmft/test/useAgent-tools.test.tsx
git -c user.email=blumi@local -c user.name=blumi commit -m "feat(app): useAgent forwards tools+chokepoint+onToolResult; AgentApp builds registry+store"
```

---

## Task 9: FindingsTab real table view

**Files:**
- Modify: `apps/gmft/src/ui/tabs/FindingsTab.tsx`
- Modify: `apps/gmft/src/AgentApp.tsx` (pass the store to the tab)
- Create: `apps/gmft/test/findings-tab.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `apps/gmft/test/findings-tab.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { FindingsStore, type Finding } from '@gmft/core';
import { FindingsTab } from '../src/ui/tabs/FindingsTab';
import { theme } from '../src/ui/theme';

const SAMPLE: Finding = {
  id: 'f-1',
  tool: 'nmap',
  target: 'scanme.nmap.org',
  severity: 'medium',
  title: 'Open port 22/tcp (ssh)',
  description: 'SSH exposed',
  evidence: '22/tcp open ssh',
  ts: 1700000000000,
};

describe('FindingsTab', () => {
  it('shows empty state when store has no findings', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gmft-ft-'));
    try {
      const store = new FindingsStore({ sessionId: 's', baseDir: dir });
      const { lastFrame } = render(<FindingsTab store={store} theme={theme} />);
      expect(lastFrame()).toMatch(/No findings yet/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('renders a table of findings sorted by severity desc', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gmft-ft-'));
    try {
      const store = new FindingsStore({ sessionId: 's', baseDir: dir });
      await store.append({ ...SAMPLE, id: 'a', severity: 'critical', title: 'crit finding' });
      await store.append({ ...SAMPLE, id: 'b', severity: 'info', title: 'info finding' });
      const { lastFrame } = render(<FindingsTab store={store} theme={theme} />);
      const out = lastFrame()!;
      expect(out).toContain('crit finding');
      expect(out).toContain('info finding');
      // critical should appear before info
      expect(out.indexOf('crit finding')).toBeLessThan(out.indexOf('info finding'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('renders tool, target, severity columns', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gmft-ft-'));
    try {
      const store = new FindingsStore({ sessionId: 's', baseDir: dir });
      await store.append(SAMPLE);
      const { lastFrame } = render(<FindingsTab store={store} theme={theme} />);
      const out = lastFrame()!;
      expect(out).toContain('nmap');
      expect(out).toContain('scanme.nmap.org');
      expect(out).toMatch(/medium/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/ankur/test/test-mob/gmft-ai/.worktrees/phase4-recon-tools && pnpm vitest run apps/gmft/test/findings-tab.test.tsx`
Expected: FAIL — `FindingsTab` doesn't accept `store` prop yet (current signature is `{ status, theme }`).

- [ ] **Step 3: Rewrite FindingsTab to use the store**

Replace the entire body of `apps/gmft/src/ui/tabs/FindingsTab.tsx` with:

```tsx
import { Box, Text } from 'ink';
import type { FindingsStore, Finding, Severity } from '@gmft/core';
import type { Theme } from '../theme.js';

const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
};

function severityColor(s: Severity): 'red' | 'redBright' | 'yellow' | 'gray' | undefined {
  switch (s) {
    case 'critical': return 'redBright';
    case 'high': return 'red';
    case 'medium': return 'yellow';
    case 'low': return 'gray';
    case 'info': return undefined;
  }
}

/**
 * FindingsTab — phase 4. Replaces the phase-1 placeholder. Reads
 * the FindingsStore (in-memory cache, JSONL on disk) and renders
 * a sortable table: severity, tool, target, title, ts. Sort is
 * severity desc, then ts desc (most recent first within severity).
 */
export function FindingsTab({ store, theme }: { store: FindingsStore; theme: Theme }): React.JSX.Element {
  const findings = [...store.list()].sort((a, b) => {
    const sevDiff = SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity];
    if (sevDiff !== 0) return sevDiff;
    return b.ts - a.ts;
  });

  if (findings.length === 0) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
        <Box marginBottom={1}>
          <Text>{theme.accent('Findings')}</Text>
        </Box>
        <Text>{theme.muted('No findings yet. Run a recon tool from the chat to see results here.')}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
      <Box marginBottom={1}>
        <Text>{theme.accent(`Findings (${findings.length})`)}</Text>
      </Box>
      <Box>
        <Text>{theme.muted('SEVERITY  TOOL          TARGET                  TITLE                       TOOL OUTPUT')}</Text>
      </Box>
      {findings.map((f) => (
        <FindingRow key={f.id} f={f} theme={theme} />
      ))}
    </Box>
  );
}

function FindingRow({ f, theme }: { f: Finding; theme: Theme }): React.JSX.Element {
  const when = new Date(f.ts).toISOString().slice(11, 19); // HH:MM:SS
  return (
    <Box>
      <Box width={10}><Text color={severityColor(f.severity)}>{f.severity.padEnd(9)}</Text></Box>
      <Box width={14}><Text>{f.tool.padEnd(13)}</Text></Box>
      <Box width={24}><Text>{f.target.slice(0, 23).padEnd(23)}</Text></Box>
      <Box width={28}><Text>{f.title.slice(0, 27).padEnd(27)}</Text></Box>
      <Box width={20}><Text>{theme.muted(when)}</Text></Box>
    </Box>
  );
}
```

- [ ] **Step 4: Update AgentApp to pass `store` to the tab**

In `apps/gmft/src/AgentApp.tsx`, find the `<FindingsTab ... />` JSX usage. The current call (in the phase 1 placeholder era) is something like:

```tsx
<FindingsTab status={...} theme={theme} />
```

Replace it with:

```tsx
<FindingsTab store={findingsStore} theme={theme} />
```

The `findingsStore` was created in Task 8 step 5.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd /home/ankur/test/test-mob/gmft-ai/.worktrees/phase4-recon-tools && pnpm vitest run apps/gmft/test/findings-tab.test.tsx`
Expected: PASS (3 new tests).

- [ ] **Step 6: Run all apps/gmft tests to confirm no regression**

Run: `cd /home/ankur/test/test-mob/gmft-ai/.worktrees/phase4-recon-tools && pnpm -C packages/core build && pnpm -C packages/tools build && pnpm vitest run apps/gmft/`
Expected: 89 + 3 = 92 tests pass.

- [ ] **Step 7: Commit**

```bash
cd /home/ankur/test/test-mob/gmft-ai/.worktrees/phase4-recon-tools
git add apps/gmft/src/ui/tabs/FindingsTab.tsx apps/gmft/src/AgentApp.tsx apps/gmft/test/findings-tab.test.tsx
git -c user.email=blumi@local -c user.name=blumi commit -m "feat(ui): FindingsTab renders store contents sorted by severity desc"
```

---

## Task 10: system prompt delta + StatusRail wiring

**Files:**
- Modify: `packages/core/src/llm/prompts.ts`
- Modify: `packages/core/test/prompts.test.ts`
- Modify: `apps/gmft/src/AgentApp.tsx` (StatusRail count)

- [ ] **Step 1: Add the findings paragraph to the agent prompt**

Edit `packages/core/src/llm/prompts.ts`. Find the `// agent` branch's returned array (the list of `##` sections under `'## Style'`). Before the `'## Style'` block, add a new section:

```ts
'## Tool use',
'- Recon tools (nmap, dnsenum, theharvester, whatweb) return `{ findings: Finding[] }` in their structured output.',
'- One Finding per discovered service/host/email/url/technology — the chokepoint gates the target, not the findings.',
'- Surface the high-severity findings in your reply; do not silently skip them.',
```

- [ ] **Step 2: Add a prompt test for the new paragraph**

Edit `packages/core/test/prompts.test.ts` (this file already exists in the workspace; read it first to match its style). Append a new test:

```ts
it('agent prompt instructs the model to surface findings from recon tools', () => {
  const p = buildSystemPrompt('agent', {
    hostname: 'h',
    os: 'linux',
    sandboxMode: 'docker',
    provider: 'openai',
    model: 'gpt-4o-mini',
    username: 'u',
  });
  expect(p).toMatch(/findings:\s*Finding\[\]/);
  expect(p).toMatch(/high-severity findings/i);
});
```

- [ ] **Step 3: Run prompt test to verify it fails then passes**

Run: `cd /home/ankur/test/test-mob/gmft-ai/.worktrees/phase4-recon-tools && pnpm vitest run packages/core/test/prompts.test.ts`
Expected: FAIL (line 1 — no `findings: Finding[]` in the prompt). Then after step 1, FAIL → PASS.

- [ ] **Step 4: Wire StatusRail `findings` count to the store**

This was already done in Task 8 step 5 (the `findingsCount` state and the `setFindingsCount` update in `onToolResult`). Confirm by re-reading `AgentApp.tsx`. If the `findingsCount` state is missing, add it (the snippet is in Task 8 step 5).

Update the `<StatusRail>` call so `findings: findingsCount`:

```tsx
<StatusRail status={{ ..., findings: findingsCount }} theme={theme} />
```

- [ ] **Step 5: Run all tests to confirm no regression**

Run: `cd /home/ankur/test/test-mob/gmft-ai/.worktrees/phase4-recon-tools && pnpm -C packages/core build && pnpm -C packages/tools build && pnpm test 2>&1 | tail -20`
Expected: all packages green; 233 prior + 32 new = 265 passing.

- [ ] **Step 6: Commit**

```bash
cd /home/ankur/test/test-mob/gmft-ai/.worktrees/phase4-recon-tools
git add packages/core/src/llm/prompts.ts packages/core/test/prompts.test.ts apps/gmft/src/AgentApp.tsx
git -c user.email=blumi@local -c user.name=blumi commit -m "feat(agent+ui): system prompt mentions findings; StatusRail shows live count"
```

---

## Task 11: CHANGELOG + tag

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `docs/superpowers/specs/2026-06-16-gmft-phase4-recon-tools-design.md` (test count correction)

- [ ] **Step 1: Add the phase 4 entry**

Open `CHANGELOG.md`. The current top entry is `0.1.0-phase1.5h`. Insert ABOVE it (the highest position):

```markdown
## [0.1.0-phase4] — 2026-06-17

Network & OSINT recon tools. Closes §4 of the v0.1 plan: 4
read-only recon tools ship as real, registered `Tool<I,O>`
implementations, the agent loop is wired so the LLM can actually
call them via `useAgent` → `runTurn` with `tools` + `chokepoint`,
a `Finding` model + persistent findings store + populated
`FindingsTab` close the loop. Asking "recon `scanme.nmap.org`"
in chat now streams the call, the tools run in the gmft/network:0.1
sandbox, and the Findings tab fills with structured results.

### Added
- `Finding` zod schema + `Severity` union in
  `packages/core/src/findings/index.ts` — id, tool, target,
  severity, title, description, evidence, ts
- `FindingsStore` in `packages/core/src/findings/store.ts` —
  in-memory cache + append-only JSONL at
  `~/.local/share/gmft/findings/<sessionId>.jsonl`, redacted via
  the session-log redactor. Trailing newline on every line (the
  read_line rule from the operator-sock work)
- `spawnStreaming` helper in
  `packages/tools/src/shared/stream.ts` — distinct from the
  existing `run` (which buffers); reserved for phase 5 web tools
  that emit live progress
- 4 read-only recon tools in `packages/tools/src/network/`:
  - `nmap` — `nmap -oX -` + hand-rolled XML parser
  - `dnsenum` — `dnsenum --noreverse -o -` + plaintext parser
  - `theHarvester` — `-d <domain> -b <sources> -l <limit> -f -` + sectioned plaintext parser
  - `whatweb` — `--log-json=-` + NDJSON line-by-line parser
  All four: `category: 'recon'`, `flags: ['targetRequired']`. No
  `destructive`, no `requiresElevation`. Tool output includes
  `findings: Finding[]` so the LLM sees structured results
- Network sandbox image: `docker/Dockerfile.network` — alpine:3.20
  + `nmap bind-tools theharvester whatweb perl`. Tagged
  `gmft/network:0.1`. Runner accepts it as the `image` override
  for the 4 recon tools
- `useAgent` opts widened additively with `tools?`, `chokepoint?`,
  `onConfirmation?`, `onToolResult?` (all optional, existing
  `useAgent.test.tsx` cases pass unchanged)
- `AgentApp` builds a `ToolRegistry` from the 5 default tools
  (shell_exec + 4 recon), a `createChokepoint(...)` from
  `config.chokepoint`, and a `FindingsStore` for the current
  session. Threads them through to `useAgent`
- `FindingsTab` replaces the phase-1 placeholder. Renders the
  store's contents as a sortable table (severity, tool, target,
  title, ts). Empty state preserved
- System prompt: new "Tool use" paragraph instructing the model
  to surface `findings: Finding[]` from recon tools in its reply

### Test totals
- Phase 4 delta: +32 tests
  - `findings.test.ts` — 5
  - `stream.test.ts` — 4
  - `nmap.test.ts` — 4
  - `dnsenum.test.ts` — 4
  - `theharvester.test.ts` — 4
  - `whatweb.test.ts` — 4
  - `useAgent-tools.test.tsx` — 3
  - `findings-tab.test.tsx` — 3
  - `prompts.test.ts` — 1 (delta)
- Workspace: 233 + 32 = 265 tests passing
- Typecheck: 0 errors across all 4 packages
```

- [ ] **Step 2: Update the spec's test count**

Edit `docs/superpowers/specs/2026-06-16-gmft-phase4-recon-tools-design.md`. Change line:

```md
**Test budget:** 8 new tests (4 tool fixture tests, 1 streaming test, 1 findings-store
test, 1 useAgent-tools-wiring test, 1 findings-tab test). 233 → **241** passing.
```

to:

```md
**Test budget:** 32 new tests (1 findings-store file = 5, 1 stream = 4, 4 tools × 4 = 16, 1 useAgent-tools = 3, 1 findings-tab = 3, 1 prompt delta = 1). 233 → **265** passing.
```

And change the acceptance line:

```md
- [ ] `pnpm -r test` is green end-to-end (241 tests)
```

to:

```md
- [ ] `pnpm -r test` is green end-to-end (265 tests)
```

- [ ] **Step 3: Bump VERSION in core**

Edit `packages/core/src/index.ts`. Change `export const VERSION = '0.1.0-phase4';` (we set this in Task 1, leaving the version string as `0.1.0-phase4` is correct).

- [ ] **Step 4: Run the full test suite one more time end-to-end**

Run: `cd /home/ankur/test/test-mob/gmft-ai/.worktrees/phase4-recon-tools && pnpm -C packages/core build && pnpm -C packages/tools build && pnpm test 2>&1 | grep -E "Test Files|Tests" | tail -10`
Expected: 4 packages green; 265 tests passing.

- [ ] **Step 5: Run typecheck across the workspace**

Run: `cd /home/ankur/test/test-mob/gmft-ai/.worktrees/phase4-recon-tools && pnpm typecheck 2>&1 | tail -10`
Expected: 0 errors.

- [ ] **Step 6: Commit the CHANGELOG + spec update**

```bash
cd /home/ankur/test/test-mob/gmft-ai/.worktrees/phase4-recon-tools
git add CHANGELOG.md docs/superpowers/specs/2026-06-16-gmft-phase4-recon-tools-design.md
git -c user.email=blumi@local -c user.name=blumi commit -m "docs(changelog): 0.1.0-phase4 entry; spec test budget corrected (32 new, 265 total)"
```

- [ ] **Step 7: Push branch + open PR**

```bash
cd /home/ankur/test/test-mob/gmft-ai/.worktrees/phase4-recon-tools
git push -u origin phase4-recon-tools
gh pr create --base main --head phase4-recon-tools --title "feat(phase4): 4 recon tools (nmap, dnsenum, theharvester, whatweb) + Findings model + TUI wiring" --body "..."
```

(Paste the body from the CHANGELOG entry — same content as the "Added" section.)

- [ ] **Step 8: Tag**

After PR is merged:

```bash
cd /home/ankur/test/test-mob/gmft-ai
git pull
git tag v0.1.0-phase4
git push origin v0.1.0-phase4
```

---

## Self-review (per writing-plans skill)

**1. Spec coverage:**

- §1 Finding type + FindingsStore → Task 1 ✓
- §1 streaming helper → Task 2 ✓
- §1 4 recon tools → Tasks 3, 4, 5, 6 ✓
- §1 network Docker image → Task 7 (step 4) ✓
- §1 useAgent + AgentApp wiring → Task 8 ✓
- §1 FindingsTab upgrade → Task 9 ✓
- §1 system prompt delta → Task 10 ✓
- §1 CHANGELOG entry → Task 11 ✓
- Test budget coverage: all 32 new tests are in tasks 1-10 ✓
- Acceptance: 265 passing ✓ (spec updated)

**2. Placeholder scan:** No "TBD", "TODO", "implement later", "add appropriate", "similar to Task N" in the steps. The CHANGELOG entry has a self-correction note (the test count) which is intentional and gets fixed in step 2. No placeholders that block implementation.

**3. Type consistency:**

- `Finding` defined in Task 1 step 3, used in every tool's output (Tasks 3-6) and `FindingsStore` (Task 1) ✓
- `FindingsStoreOpts` defined in Task 1, used in `AgentApp` (Task 8) and `FindingsTab` (Task 9) ✓
- `spawnStreaming` defined in Task 2 — not used by the 4 tools (they use the existing buffered `run`). Reserved for phase 5's nuclei/nikto. ✓
- `useAgent` opts added in Task 8 — naming matches `RunTurnOpts` from `loop.ts` (`tools`, `chokepoint`, `onConfirmation`) ✓
- `onToolResult` callback signature `{ name: string; output: unknown }` matches what Task 9's `FindingsTab` test expects ✓
- `createChokepoint` and `ToolRegistry` are real exports from `@gmft/core` (verified in `index.ts`) ✓
- `shellExecTool`, `nmapTool`, etc. are exported from `@gmft/tools` (Task 7 step 2 barrel) ✓

**4. Issue found and fixed inline:** the spec's test budget was wrong (8 vs actual 32). Caught at CHANGELOG step in Task 11. Spec updated as part of Task 11.
