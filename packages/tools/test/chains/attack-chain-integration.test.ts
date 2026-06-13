/**
 * v0.1 phase 6 — Feature A.3: end-to-end chokepoint integration
 * tests for `attack_chain`. These drive the chain through the real
 * `runInner` seam (not a hand-rolled innerRunner) and assert the
 * chain-level chokepoint settings cover per-step settings, while
 * per-step destructive + target checks still fire.
 *
 * The plan's 4 tests:
 *
 *   1. chain-level `typeToConfirm: 'attack'` covers per-step
 *      `typeToConfirm: 'scan'` — the user types `attack` once; the
 *      per-step `scan` prompt is suppressed.
 *   2. per-step `destructive` still prompts (y/n) — even though the
 *      chain's `typeToConfirm` was satisfied, the per-step destructive
 *      flag still fires a plain y/n confirmation.
 *   3. per-step `target` validation still fires — a step with a
 *      private-network target is denied by the chokepoint's target
 *      rule, even when the chain's `typeToConfirm` is satisfied.
 *   4. chain-level destructive covers per-step destructive — the
 *      chain itself is destructive, the steps aren't. Assert one
 *      prompt fires for the chain, none for the steps.
 */

import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ToolRegistry,
  runInner,
  createChokepoint,
  FindingsStore,
  type Tool,
  type ToolContext,
  type ChokepointCall,
  type Decision,
  type ChokepointEnv,
  type Finding,
} from '@gmft/core';
import { ATTACK_CHAIN_TOOL } from '../../src/chains/attack-chain.js';

const cwdCtx: ToolContext = {
  cwd: '/tmp',
  env: {},
  cfg: { sandbox: { mode: 'host' as const } },
  innerRunner: undefined,
};

const env: ChokepointEnv = {
  allowPrivateNetworks: false,
  allowElevation: true, // attack_chain has `requiresElevation`
  denylist: [],
  // v0.3.B — empty allowlist is the back-compat default. The test
  // predates the allowlist field; the new rule in `checkTarget`
  // reads `env.allowlist.length` so the field must be present
  // (or the test crashes with "Cannot read properties of
  // undefined").
  allowlist: [],
};

/** Build a `runInner` invocation where the chain's `innerRunner` is
 *  wired to recurse through the real `runInner`. The chain tool
 *  itself doesn't build this — the executor does — so we call
 *  `runInner` directly with the chain's tool name. The chain tool
 *  will then call `ctx.innerRunner(step.tool, step.args, { suppressTypeToConfirm: true })`
 *  for each step, and the executor-built closure recurses through
 *  `runInner` with the same registry + chokepoint. */
async function runChain(
  registry: ToolRegistry,
  chokepoint: ReturnType<typeof createChokepoint>,
  steps: Array<{ tool: string; args: Record<string, unknown>; name?: string }>,
  onConfirmation: (call: { name: string; args: Record<string, unknown> }, decision: Decision) => Promise<boolean>,
  findingsStore?: FindingsStore,
) {
  return runInner(
    'attack_chain',
    { steps, stopOnDeny: true },
    registry,
    chokepoint,
    cwdCtx,
    { onConfirmation, findingsStore },
  );
}

describe('attack_chain end-to-end (real runInner)', () => {
  it("1. chain-level 'attack' covers per-step 'scan' — one prompt, not two", async () => {
    const scanInput = z.object({ target: z.string() });
    const scanOutput = z.object({ echoed: z.string() });
    const scanTool: Tool<typeof scanInput, typeof scanOutput> = {
      name: 'scan',
      category: 'recon',
      description: 'scan',
      input: scanInput,
      output: scanOutput,
      flags: [],
      typeToConfirm: 'scan',
      async run({ target }) { return { echoed: target }; },
    };
    const r = new ToolRegistry();
    r.register(scanTool);
    r.register(ATTACK_CHAIN_TOOL);
    const cp = createChokepoint(env);
    const onConfirmation = vi.fn(async () => true);

    const result = await runChain(r, cp, [{ tool: 'scan', args: { target: 'example.com' } }], onConfirmation);

    expect(result.ok).toBe(true);
    // Exactly one prompt: the chain's `attack`. The step's `scan`
    // typeToConfirm was suppressed by the inner runner.
    expect(onConfirmation).toHaveBeenCalledTimes(1);
    const decision = onConfirmation.mock.calls[0]![1] as Decision;
    expect(decision.kind).toBe('type-then-confirm');
    if (decision.kind === 'type-then-confirm') {
      expect(decision.prompt).toBe('attack');
    }
  });

  it('2. per-step destructive still prompts (y/n) — chain typeToConfirm is satisfied, destructive fires per step', async () => {
    const exfilInput = z.object({ target: z.string() });
    const exfilOutput = z.object({ echoed: z.string() });
    const exfilTool: Tool<typeof exfilInput, typeof exfilOutput> = {
      name: 'exfil',
      category: 'binary',
      description: 'destructive exfil',
      input: exfilInput,
      output: exfilOutput,
      flags: ['destructive'],
      async run({ target }) { return { echoed: target }; },
    };
    const r = new ToolRegistry();
    r.register(exfilTool);
    r.register(ATTACK_CHAIN_TOOL);
    const cp = createChokepoint(env);
    // Track prompt order so we can assert: chain's type-then-confirm
    // first, then the per-step plain confirm.
    const prompts: string[] = [];
    const onConfirmation = vi.fn(async (_call, decision) => {
      if (decision.kind === 'type-then-confirm') prompts.push(`type:${decision.prompt}`);
      else if (decision.kind === 'confirm') prompts.push(`confirm:${decision.reason}`);
      return true;
    });

    const result = await runChain(r, cp, [{ tool: 'exfil', args: { target: 'example.com' } }], onConfirmation);

    expect(result.ok).toBe(true);
    expect(prompts).toEqual(['type:attack', expect.stringMatching(/^confirm:/) as string]);
  });

  it('3. per-step target validation still fires — private-network target is denied even inside a chain', async () => {
    const exfilInput = z.object({ target: z.string() });
    const exfilOutput = z.object({ echoed: z.string() });
    const exfilTool: Tool<typeof exfilInput, typeof exfilOutput> = {
      name: 'target_tool',
      category: 'binary',
      description: 'targets a host',
      input: exfilInput,
      output: exfilOutput,
      flags: ['targetRequired'],
      async run({ target }) { return { echoed: target }; },
    };
    const r = new ToolRegistry();
    r.register(exfilTool);
    r.register(ATTACK_CHAIN_TOOL);
    const cp = createChokepoint(env);
    // auto-approve all prompts so the only failure mode is the
    // private-network deny.
    const onConfirmation = vi.fn(async () => true);

    const result = await runChain(r, cp, [{ tool: 'target_tool', args: { target: '192.168.1.1' } }], onConfirmation);

    // The chain itself is approved (the user typed "attack" via
    // onConfirmation). What we care about is the per-step outcome:
    // the step was denied by the chokepoint's `targetRequired` rule.
    expect(result.ok).toBe(true);
    if (result.ok) {
      const step = result.output.steps[0]!;
      expect(step.status).toBe('denied');
      expect(step.reason).toMatch(/private|192\.168/i);
    }
  });

  it('4. chain-level destructive covers per-step (no per-step destructive flag, but chain is destructive)', async () => {
    const scannerInput = z.object({ target: z.string() });
    const scannerOutput = z.object({ echoed: z.string() });
    const scannerTool: Tool<typeof scannerInput, typeof scannerOutput> = {
      name: 'scanner',
      category: 'recon',
      description: 'passive recon',
      input: scannerInput,
      output: scannerOutput,
      flags: [], // not destructive
      async run({ target }) { return { echoed: target }; },
    };
    const r = new ToolRegistry();
    r.register(scannerTool);
    r.register(ATTACK_CHAIN_TOOL);
    const cp = createChokepoint(env);
    const onConfirmation = vi.fn(async () => true);

    const result = await runChain(r, cp, [{ tool: 'scanner', args: { target: 'example.com' } }], onConfirmation);

    expect(result.ok).toBe(true);
    // The chain is destructive (so the typeToConfirm 'attack' fires
    // once). The step is NOT destructive, so no per-step prompt.
    expect(onConfirmation).toHaveBeenCalledTimes(1);
    const decision = onConfirmation.mock.calls[0]![1] as Decision;
    expect(decision.kind).toBe('type-then-confirm');
  });

  it('(bonus) per-step findings propagate to the session findings.jsonl via the store', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gmft-chain-e2e-'));
    try {
      const sessionId = 'sess-chain-e2e-1';
      const store = new FindingsStore({ baseDir: dir, sessionId });

      const findInput = z.object({ target: z.string() });
      const findOutput = z.object({
        findings: z.array(z.object({
          id: z.string(),
          tool: z.string(),
          target: z.string(),
          severity: z.enum(['info', 'low', 'medium', 'high', 'critical']),
          title: z.string(),
          ts: z.number(),
        })),
      });
      const findTool: Tool<typeof findInput, typeof findOutput> = {
        name: 'find_something',
        category: 'recon',
        description: 'emits a finding',
        input: findInput,
        output: findOutput,
        flags: [],
        async run({ target }) {
          const f: Finding = {
            id: `f-${target}-${Date.now()}`,
            tool: 'find-something',
            target,
            severity: 'low',
            title: `Found on ${target}`,
            ts: Date.now(),
          };
          return { findings: [f] };
        },
      };
      const r = new ToolRegistry();
      r.register(findTool);
      r.register(ATTACK_CHAIN_TOOL);
      const cp = createChokepoint(env);
      const onConfirmation = vi.fn(async () => true);

      const result = await runChain(
        r,
        cp,
        [
          { tool: 'find_something', args: { target: 'alpha' } },
          { tool: 'find_something', args: { target: 'beta' } },
        ],
        onConfirmation,
        store,
      );

      expect(result.ok).toBe(true);
      const sidecar = join(dir, `${sessionId}.jsonl`);
      expect(existsSync(sidecar)).toBe(true);
      const lines = readFileSync(sidecar, 'utf8').trim().split('\n').filter(Boolean);
      expect(lines).toHaveLength(2);
      const parsed = lines.map((l) => JSON.parse(l) as { id: string; target: string });
      expect(parsed.map((p) => p.target).sort()).toEqual(['alpha', 'beta']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
