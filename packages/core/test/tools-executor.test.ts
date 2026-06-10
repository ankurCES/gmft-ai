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
import { ToolRegistry, type Tool } from '../src/tools/index.js';
import { execute, type ExecuteCall } from '../src/tools/executor.js';
import type { Chokepoint, ChokepointCall, Decision } from '../src/chokepoint/index.js';

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
