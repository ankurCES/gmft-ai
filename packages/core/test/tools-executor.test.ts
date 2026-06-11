/**
 * Three scenarios cover the executor's branching:
 *   1. Allow  — chokepoint says yes, tool runs, output validates.
 *   2. Confirm — chokepoint says confirm, handler approves, tool runs.
 *   3. Deny   — chokepoint says deny, tool.run is never called.
 *
 * Plus two edge cases (unknown tool, invalid args) to lock down the
 * pre-chokepoint error paths.
 */

import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolRegistry, type Tool } from '../src/tools/index.js';
import { execute, runInner, type ExecuteCall } from '../src/tools/executor.js';
import { FindingsStore } from '../src/findings/store.js';
import type { Chokepoint, ChokepointCall, Decision } from '../src/chokepoint/index.js';
import type { Finding } from '../src/findings/index.js';

const echoInput = z.object({ text: z.string() });
const echoOutput = z.object({ echoed: z.string() });

const echo: Tool<typeof echoInput, typeof echoOutput> = {
  name: 'echo',
  category: 'note',
  description: 'returns the input',
  input: echoInput,
  output: echoOutput,
  flags: [],
  async run({ text }) { return { echoed: text }; },
};

function fakeChokepoint(decision: Decision): Chokepoint {
  return { decide: (_call: ChokepointCall): Decision => decision };
}

const baseCtx = {
  cwd: '/tmp',
  env: {},
  cfg: { sandbox: { mode: 'host' as const } },
};

describe('execute', () => {
  it('runs the tool when the chokepoint allows', async () => {
    const r = new ToolRegistry();
    r.register(echo);
    const call: ExecuteCall = { name: 'echo', args: { text: 'hi' } };
    const result = await execute(call, baseCtx, fakeChokepoint({ kind: 'allow' }), r);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toEqual({ echoed: 'hi' });
      expect(result.decision).toEqual({ kind: 'allow' });
    }
  });

  it('runs the tool when confirm handler approves', async () => {
    const r = new ToolRegistry();
    r.register(echo);
    const call: ExecuteCall = { name: 'echo', args: { text: 'hi' } };
    const onConfirmation = vi.fn(async () => true);
    const decision: Decision = { kind: 'confirm', reason: 'are you sure?' };
    const result = await execute(
      call,
      baseCtx,
      fakeChokepoint(decision),
      r,
      { onConfirmation },
    );
    expect(onConfirmation).toHaveBeenCalledWith(call, decision);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toEqual({ echoed: 'hi' });
    }
  });

  it('denies when the confirm handler refuses', async () => {
    const r = new ToolRegistry();
    r.register(echo);
    const call: ExecuteCall = { name: 'echo', args: { text: 'hi' } };
    const onConfirmation = vi.fn(async () => false);
    const result = await execute(
      call,
      baseCtx,
      fakeChokepoint({ kind: 'confirm', reason: 'are you sure?' }),
      r,
      { onConfirmation },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('user denied confirmation');
    }
  });

  it('denies and never runs the tool when the chokepoint denies', async () => {
    const r = new ToolRegistry();
    const runSpy = vi.fn();
    const spyEcho: Tool<typeof echoInput, typeof echoOutput> = { ...echo, run: runSpy };
    r.register(spyEcho);
    const result = await execute(
      { name: 'echo', args: { text: 'hi' } },
      baseCtx,
      fakeChokepoint({ kind: 'deny', reason: 'private network' }),
      r,
    );
    expect(runSpy).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('private network');
    }
  });

  it('denies an unknown tool without consulting the chokepoint', async () => {
    const r = new ToolRegistry();
    const chokepoint = vi.fn();
    const result = await execute(
      { name: 'nope', args: {} },
      baseCtx,
      chokepoint as unknown as Chokepoint,
      r,
    );
    expect(chokepoint).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/unknown tool "nope"/);
    }
  });

  it('denies on invalid args without consulting the chokepoint', async () => {
    const r = new ToolRegistry();
    r.register(echo);
    const chokepoint = vi.fn();
    const result = await execute(
      { name: 'echo', args: { text: 42 } }, // wrong type
      baseCtx,
      chokepoint as unknown as Chokepoint,
      r,
    );
    expect(chokepoint).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/invalid args/);
    }
  });
});

/**
 * v0.1 phase 6 — `runInner` is the seam the `attack_chain` tool
 * recurses through. The tests cover the contract that the chain
 * tool relies on:
 *
 *   1. delegates to the chokepoint (one call, not two)
 *   2. `suppressTypeToConfirm` skips the type prompt but NOT the
 *      destructive check
 *   3. findings from the tool's output propagate to the session's
 *      `findings.jsonl` via the `findingsStore` opt
 */
describe('runInner', () => {
  const destructiveInput = z.object({ text: z.string() });
  const destructiveOutput = z.object({ echoed: z.string() });

  it('delegates to the chokepoint (one decide call per runInner invocation)', async () => {
    const r = new ToolRegistry();
    const destructiveTool: Tool<typeof destructiveInput, typeof destructiveOutput> = {
      name: 'do_destructive',
      category: 'shell',
      description: 'destructive',
      input: destructiveInput,
      output: destructiveOutput,
      flags: ['destructive'],
      async run({ text }) { return { echoed: text }; },
    };
    r.register(destructiveTool);
    const chokepoint = { decide: vi.fn((): Decision => ({ kind: 'allow' })) };
    await runInner('do_destructive', { text: 'x' }, r, chokepoint as unknown as Chokepoint, baseCtx);
    expect(chokepoint.decide).toHaveBeenCalledTimes(1);
  });

  it('suppressTypeToConfirm drops typeToConfirm from the ChokepointCall (per-step type prompt is skipped)', async () => {
    const r = new ToolRegistry();
    const tool: Tool<typeof destructiveInput, typeof destructiveOutput> = {
      name: 'typed_destructive',
      category: 'shell',
      description: 'typed + destructive',
      input: destructiveInput,
      output: destructiveOutput,
      flags: ['destructive'],
      typeToConfirm: 'attack',
      async run({ text }) { return { echoed: text }; },
    };
    r.register(tool);

    // Recording chokepoint: returns the call's `typeToConfirm` set or
    // not as a `confirm`/`type-then-confirm` decision, the way the
    // real chokepoint does. This lets the test assert what the
    // executor passed in.
    const seen: ChokepointCall[] = [];
    const chokepoint: Chokepoint = {
      decide(call: ChokepointCall): Decision {
        seen.push(call);
        if (call.typeToConfirm) {
          return { kind: 'type-then-confirm', reason: 'typed', prompt: call.typeToConfirm };
        }
        if (call.flags.includes('destructive')) {
          return { kind: 'confirm', reason: 'destructive' };
        }
        return { kind: 'allow' };
      },
    };
    const onConfirmation = vi.fn(async () => true);

    // First call: no suppression — the executor forwards the tool's
    // `typeToConfirm: 'attack'` to the chokepoint, which returns
    // type-then-confirm.
    const r1 = await runInner('typed_destructive', { text: 'x' }, r, chokepoint, baseCtx, { onConfirmation });
    expect(r1.ok).toBe(true);
    expect(seen[0]?.typeToConfirm).toBe('attack');
    expect(onConfirmation).toHaveBeenCalledTimes(1);

    // Second call: suppress typeToConfirm — the executor MUST clear
    // the field on the call it builds, so the chokepoint returns
    // plain `confirm` (destructive without the typed prompt). This
    // is the seam the chain tool relies on: per-step elevated
    // friction is covered by the chain's own `typeToConfirm: 'attack'`.
    const r2 = await runInner('typed_destructive', { text: 'x' }, r, chokepoint, baseCtx, {
      onConfirmation,
      suppressTypeToConfirm: true,
    });
    expect(r2.ok).toBe(true);
    expect(seen[1]?.typeToConfirm).toBeUndefined();
    expect(onConfirmation).toHaveBeenCalledTimes(2);
  });

  it('passes findings from the tool output to the session findings.jsonl', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gmft-runinner-'));
    try {
      const sessionId = 'sess-runinner-1';
      const store = new FindingsStore({ baseDir: dir, sessionId });

      const findingInput = z.object({ target: z.string() });
      const findingOutput = z.object({
        findings: z.array(z.object({
          id: z.string(),
          tool: z.string(),
          target: z.string(),
          severity: z.enum(['info', 'low', 'medium', 'high', 'critical']),
          title: z.string(),
          ts: z.number(),
        })),
      });
      const findingTool: Tool<typeof findingInput, typeof findingOutput> = {
        name: 'find_something',
        category: 'recon',
        description: 'emits a finding',
        input: findingInput,
        output: findingOutput,
        flags: [],
        async run({ target }) {
          const f: Finding = {
            id: `f-${target}-1`,
            tool: 'find-something',
            target,
            severity: 'low',
            title: `Found something on ${target}`,
            ts: Date.now(),
          };
          return { findings: [f] };
        },
      };
      const r = new ToolRegistry();
      r.register(findingTool);
      const chokepoint: Chokepoint = { decide: () => ({ kind: 'allow' as const }) };

      const result = await runInner(
        'find_something',
        { target: 'example.com' },
        r,
        chokepoint,
        baseCtx,
        { findingsStore: store },
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.findings).toHaveLength(1);
        expect(result.findings?.[0]?.id).toBe('f-example.com-1');
      }
      const sidecar = join(dir, `${sessionId}.jsonl`);
      expect(existsSync(sidecar)).toBe(true);
      const lines = readFileSync(sidecar, 'utf8').trim().split('\n').filter(Boolean);
      expect(lines).toHaveLength(1);
      const parsed = JSON.parse(lines[0]!) as { id: string; tool: string };
      expect(parsed.id).toBe('f-example.com-1');
      expect(parsed.tool).toBe('find-something');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
