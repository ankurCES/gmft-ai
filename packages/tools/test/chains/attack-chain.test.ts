/**
 * Tests for the `attack_chain` tool. The plan budget is 6 tests; we
 * drop the "runInner propagates findings" case (6) because that
 * exercises the chokepoint's `runInner` path, not the chain tool, and
 * the runInner append-to-store behavior is covered by the core
 * chokepoint tests. The 5 in-scope tests:
 *
 *   1. happy path (3 steps, all ok)
 *   2. mid-chain deny (step 2 denied, step 3 skipped with stopOnDeny)
 *   3. mid-chain error (step 2 throws, step 3 skipped with stopOnDeny)
 *   4. `stopOnDeny: false` continues past a deny and an error
 *   5. per-step `name` field surfaces in the event payload + output row
 *
 * The test harness builds a tiny in-memory `innerRunner` (a closure
 * over a switch on tool name) that emulates what `runInner` returns:
 * `{ ok: true, output, findings? }` or `{ ok: false, denied?, reason }`.
 * The chain tool only consumes this return shape, so a hand-rolled
 * innerRunner is sufficient and keeps the test focused on the chain
 * semantics (status propagation, totals, events, stopOnDeny).
 */

import { describe, it, expect } from 'vitest';
import { ATTACK_CHAIN_TOOL, type ChainEvent } from '../../src/chains/attack-chain.js';
import type { ToolContext } from '@gmft/core';

const cwdCtx = { cwd: '/tmp', env: {}, cfg: { sandbox: { mode: 'host' as const } } };

type ScriptEntry =
  | { ok: true; output: unknown; findings?: unknown[] }
  | { ok: false; denied?: boolean; reason: string };

function makeInnerRunner(script: Map<string, ScriptEntry>) {
  const calls: Array<{ tool: string; args: Record<string, unknown>; opts: { suppressTypeToConfirm?: boolean } }> = [];
  const fn: ToolContext['innerRunner'] = async (tool, args, opts) => {
    calls.push({ tool, args, opts: opts ?? {} });
    const s = script.get(tool);
    if (!s) {
      return { ok: false, denied: true, reason: `no script for tool "${tool}"` };
    }
    if (s.ok) {
      return { ok: true, output: s.output, findings: s.findings as never };
    }
    return { ok: false, denied: s.denied, reason: s.reason };
  };
  return { fn, calls };
}

function makeCtx(
  innerRunner: ToolContext['innerRunner'],
): ToolContext & { emit: (e: ChainEvent) => void; events: ChainEvent[] } {
  const events: ChainEvent[] = [];
  const emit = (e: ChainEvent): void => {
    events.push(e);
  };
  return { ...cwdCtx, innerRunner, emit, events };
}

describe('attack_chain', () => {
  it('happy path: 3 steps, all ok, full event sequence', async () => {
    const script = new Map<string, ScriptEntry>([
      ['nmap', { ok: true, output: { hosts: [] } }],
      ['nikto', { ok: true, output: { findings: [] } }],
      ['nuclei', { ok: true, output: { matched: 0 } }],
    ]);
    const { fn } = makeInnerRunner(script);
    const ctx = makeCtx(fn);
    const result = await ATTACK_CHAIN_TOOL.run(
      {
        steps: [
          { tool: 'nmap', args: { target: 'example.com' }, name: 'port-scan' },
          { tool: 'nikto', args: { target: 'example.com' } },
          { tool: 'nuclei', args: { target: 'example.com' } },
        ],
        stopOnDeny: true,
      },
      ctx,
    );

    expect(result.totals).toEqual({ total: 3, completed: 3, denied: 0, erred: 0, skipped: 0 });
    expect(result.steps.map((s) => s.status)).toEqual(['ok', 'ok', 'ok']);

    // chain-started, 3x (step-started, step-finished), chain-finished
    const types = ctx.events.map((e) => e.type);
    expect(types).toEqual([
      'chain-started',
      'chain-step-started',
      'chain-step-finished',
      'chain-step-started',
      'chain-step-finished',
      'chain-step-started',
      'chain-step-finished',
      'chain-finished',
    ]);
    expect(ctx.events[0]).toMatchObject({ type: 'chain-started', stepCount: 3 });
    expect(ctx.events[ctx.events.length - 1]).toMatchObject({ type: 'chain-finished', completed: 3 });
  });

  it('mid-chain deny: step 2 denied, step 3 skipped when stopOnDeny=true', async () => {
    const script = new Map<string, ScriptEntry>([
      ['nmap', { ok: true, output: {} }],
      ['nikto', { ok: false, denied: true, reason: 'user denied confirmation' }],
      ['nuclei', { ok: true, output: {} }],
    ]);
    const { fn } = makeInnerRunner(script);
    const ctx = makeCtx(fn);
    const result = await ATTACK_CHAIN_TOOL.run(
      {
        steps: [
          { tool: 'nmap', args: {} },
          { tool: 'nikto', args: {} },
          { tool: 'nuclei', args: {} },
        ],
        stopOnDeny: true,
      },
      ctx,
    );

    expect(result.steps.map((s) => s.status)).toEqual(['ok', 'denied', 'skipped']);
    expect(result.totals).toEqual({ total: 3, completed: 1, denied: 1, erred: 0, skipped: 1 });
    const skipped = result.steps.find((s) => s.status === 'skipped');
    expect(skipped?.reason).toBe('previous step failed');
  });

  it('mid-chain error: step 2 errors, step 3 skipped when stopOnDeny=true', async () => {
    const fn: ToolContext['innerRunner'] = async (tool) => {
      if (tool === 'nmap') return { ok: true, output: {} };
      if (tool === 'nikto') return { ok: false, denied: false, reason: 'boom' };
      return { ok: true, output: {} };
    };
    const ctx = makeCtx(fn);
    const result = await ATTACK_CHAIN_TOOL.run(
      {
        steps: [
          { tool: 'nmap', args: {} },
          { tool: 'nikto', args: {} },
          { tool: 'nuclei', args: {} },
        ],
        stopOnDeny: true,
      },
      ctx,
    );

    expect(result.steps.map((s) => s.status)).toEqual(['ok', 'erred', 'skipped']);
    expect(result.totals).toEqual({ total: 3, completed: 1, denied: 0, erred: 1, skipped: 1 });
  });

  it('stopOnDeny=false continues past a deny and an error', async () => {
    const fn: ToolContext['innerRunner'] = async (tool) => {
      if (tool === 'nmap') return { ok: true, output: {} };
      if (tool === 'nikto') return { ok: false, denied: true, reason: 'nope' };
      if (tool === 'nuclei') return { ok: false, denied: false, reason: 'crash' };
      return { ok: true, output: {} };
    };
    const ctx = makeCtx(fn);
    const result = await ATTACK_CHAIN_TOOL.run(
      {
        steps: [
          { tool: 'nmap', args: {} },
          { tool: 'nikto', args: {} },
          { tool: 'nuclei', args: {} },
          { tool: 'sqlmap', args: {} },
        ],
        stopOnDeny: false,
      },
      ctx,
    );

    expect(result.steps.map((s) => s.status)).toEqual(['ok', 'denied', 'erred', 'ok']);
    expect(result.totals).toEqual({ total: 4, completed: 2, denied: 1, erred: 1, skipped: 0 });
  });

  it("per-step `name` field surfaces in the chain-step-started event and the output row", async () => {
    const script = new Map<string, ScriptEntry>([['nmap', { ok: true, output: {} }]]);
    const { fn } = makeInnerRunner(script);
    const ctx = makeCtx(fn);
    const result = await ATTACK_CHAIN_TOOL.run(
      {
        steps: [{ tool: 'nmap', args: {}, name: 'initial port scan' }],
        stopOnDeny: true,
      },
      ctx,
    );

    const started = ctx.events.find((e) => e.type === 'chain-step-started');
    expect(started).toMatchObject({ type: 'chain-step-started', tool: 'nmap', name: 'initial port scan' });
    expect(result.steps[0]?.name).toBe('initial port scan');
  });
});
