/**
 * Tests for ToolRegistry. We use a small `echo` fixture (note category,
 * no flags) plus a `target_tool` fixture for the targetRequired flag
 * (which the registry doesn't validate but the chokepoint consumes).
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { ToolRegistry, type Tool } from '../src/tools/index.js';

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

const targetInput = z.object({ target: z.string() });
const targetOutput = z.object({ ok: z.boolean() });

const targetTool: Tool<typeof targetInput, typeof targetOutput> = {
  name: 'ping_host',
  category: 'recon',
  description: 'pings a host',
  input: targetInput,
  output: targetOutput,
  flags: ['targetRequired', 'destructive'],
  async run({ target: _t }) { return { ok: true }; },
};

describe('ToolRegistry', () => {
  it('registers a valid tool; get + list return it', () => {
    const r = new ToolRegistry();
    r.register(echo);
    expect(r.get('echo')).toBe(echo);
    expect(r.list()).toHaveLength(1);
  });

  it('rejects a tool name with uppercase letters', () => {
    const r = new ToolRegistry();
    expect(() => r.register({ ...echo, name: 'Echo' })).toThrow(/must match/);
  });

  it('rejects a tool name with a dash', () => {
    const r = new ToolRegistry();
    expect(() => r.register({ ...echo, name: 'shell-exec' })).toThrow(/must match/);
  });

  it('rejects an unknown category', () => {
    const r = new ToolRegistry();
    // Cast to bypass TS — the test is precisely about runtime validation.
    expect(() => r.register({ ...echo, category: 'evil' as unknown as 'note' })).toThrow(/not in enum/);
  });

  it('rejects a non-zod input schema', () => {
    const r = new ToolRegistry();
    const bad = { ...echo, input: z.string() as unknown as typeof echoInput };
    expect(() => r.register(bad)).toThrow(/input must be a z\.object/);
  });

  it('rejects a non-zod output schema', () => {
    const r = new ToolRegistry();
    const bad = { ...echo, output: z.string() as unknown as typeof echoOutput };
    expect(() => r.register(bad)).toThrow(/output must be a z\.object/);
  });

  it('rejects a duplicate name', () => {
    const r = new ToolRegistry();
    r.register(echo);
    expect(() => r.register(echo)).toThrow(/already registered/);
  });

  it('toAISDKTools produces a record with description + parameters per tool', () => {
    const r = new ToolRegistry();
    r.register(echo);
    r.register(targetTool);
    const out = r.toAISDKTools();
    expect(Object.keys(out).sort()).toEqual(['echo', 'ping_host']);
    expect(out.echo.description).toBe('returns the input');
    expect(out.echo.parameters).toBe(echoInput);
    expect(out.ping_host.parameters).toBe(targetInput);
  });
});
