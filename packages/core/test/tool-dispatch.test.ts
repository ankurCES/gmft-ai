/**
 * Tests for the thin tool-execute wrapper. `wrapToolsForSDK` is what
 * the AI SDK calls on every LLM-issued tool call. It does Zod
 * input/output validation but does NOT consult the chokepoint —
 * that's the loop's job (because the loop needs to emit
 * `confirmation-needed` events at the right time). The chokepoint
 * integration is covered end-to-end by the agent-loop test (task 3.5).
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { wrapToolsForSDK } from '../src/agent/tool-dispatch.js';
import type { Tool } from '../src/tools/types.js';

const input = z.object({ text: z.string() });
const output = z.object({ echoed: z.string() });

const echo: Tool<typeof input, typeof output> = {
  name: 'echo',
  category: 'note',
  description: 'returns the input',
  input,
  output,
  flags: [],
  async run({ text }) { return { echoed: text }; },
};

const ctx = { cwd: '/tmp', env: {}, cfg: { sandbox: { mode: 'host' as const } } };

describe('wrapToolsForSDK', () => {
  it('runs the tool and returns the output', async () => {
    const wrapped = wrapToolsForSDK([echo], ctx);
    const result = await wrapped.echo!.execute({ text: 'hi' });
    expect(result).toEqual({ echoed: 'hi' });
  });

  it('throws on invalid input args', async () => {
    const wrapped = wrapToolsForSDK([echo], ctx);
    // text must be a string; pass a number
    await expect(wrapped.echo!.execute({ text: 42 })).rejects.toThrow();
  });

  it('throws when the tool returns output that fails the output schema', async () => {
    const bad: Tool<typeof input, typeof output> = {
      ...echo,
      async run({ text: _t }) { return { wrong: 'shape' } as unknown as { echoed: string }; },
    };
    const wrapped = wrapToolsForSDK([bad], ctx);
    await expect(wrapped.echo!.execute({ text: 'hi' })).rejects.toThrow();
  });

  it('preserves description and parameters on each entry', () => {
    const wrapped = wrapToolsForSDK([echo], ctx);
    expect(wrapped.echo!.description).toBe('returns the input');
    expect(wrapped.echo!.parameters).toBe(input);
  });
});
