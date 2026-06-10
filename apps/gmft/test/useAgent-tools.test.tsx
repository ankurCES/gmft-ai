/**
 * useAgent — phase 4 scaffold: tools catalog + findings state.
 *
 * This test file covers the *scaffold* added in phase 4 task 8:
 *   - `UseAgentResult.findings` exists and is `[]` by default.
 *   - `UseAgentOpts.tools` is accepted (the hook stores it for future
 *     use but does not execute tool calls yet).
 *
 * The real tool-call execution (driving `setFindings` from
 * `tool-result` events, calling `tool.run(args, ctx)`, and extracting
 * `result.findings`) is a follow-up task — it requires the upstream
 * `runTurn` impl to thread tool events through to the hook, which is
 * outside the scope of task 8. The scaffold just makes the public
 * surface ready so the UI can subscribe to `findings` before execution
 * lands.
 *
 * Mock strategy: identical to `useAgent.test.tsx`. A `fakeRunTurn`
 * generator yields a hard-coded sequence of events. The hook is
 * rendered through an ink-testing-library Harness that mirrors the
 * result on every render.
 */

import { render } from 'ink-testing-library';
import React, { useEffect } from 'react';
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { useAgent, type UseAgentOpts } from '../src/ui/hooks/useAgent.js';
import type { ChatMessage, Tool } from '@gmft/core';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Build a fake `runTurn` that yields a hard-coded sequence of events.
 * Mirrors the real `runTurn` contract (text-delta, done, error) so
 * the hook's state machine is exercised end-to-end.
 */
function fakeRunTurn(
  events: Array<
    { type: 'text-delta'; text: string } | { type: 'done' } | { type: 'error' }
  >,
): UseAgentOpts['runTurn'] {
  return (_args) => {
    return (async function* () {
      for (const e of events) {
        // Yield one event at a time so the hook's setState in between
        // has a chance to flush before the next chunk.
        // eslint-disable-next-line no-await-in-loop
        await new Promise<void>((r) => setImmediate(r));
        if (e.type === 'text-delta') {
          yield { type: 'text-delta' as const, text: e.text };
        } else if (e.type === 'done') {
          yield { type: 'done' as const, text: '' };
        } else if (e.type === 'error') {
          yield { type: 'error' as const, error: new Error('fake-stream-error') };
        }
      }
    })();
  };
}

interface HarnessProps {
  events: Array<
    { type: 'text-delta'; text: string } | { type: 'done' } | { type: 'error' }
  >;
  tools?: readonly Tool<z.ZodTypeAny, z.ZodTypeAny>[];
  onState: (state: ReturnType<typeof useAgent>) => void;
  onReady: (submit: (text: string) => void) => void;
}

function Harness({ events, tools, onState, onReady }: HarnessProps): React.JSX.Element {
  const agent = useAgent({
    system: 'test prompt',
    runTurn: fakeRunTurn(events),
    ...(tools ? { tools } : {}),
  });
  useEffect(() => {
    onState(agent);
  });
  useEffect(() => {
    onReady(agent.submit);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return React.createElement(
    'ink-text',
    null,
    agent.history
      .map((m: ChatMessage) => `${m.role}:${m.content}`)
      .join('|'),
  );
}

/**
 * A throwaway Tool<I, O> instance. We never call `run` on it (the
 * scaffold does not execute tools). The schema and flags are
 * structurally valid; the type signature is the only thing the hook
 * reads today.
 */
function stubTool(name: string): Tool<z.ZodTypeAny, z.ZodTypeAny> {
  return {
    name,
    category: 'recon',
    description: 'test stub',
    input: z.object({}),
    output: z.object({ findings: z.array(z.any()) }),
    flags: [],
    run: async () => ({ findings: [] }),
  };
}

describe('useAgent — phase 4 tools scaffold', () => {
  it('exposes findings: [] on the result initially (and stays [] after a turn)', async () => {
    const states: Array<ReturnType<typeof useAgent>> = [];
    let capturedSubmit: ((t: string) => void) | null = null;

    render(
      React.createElement(Harness, {
        events: [
          { type: 'text-delta', text: 'Hello' },
          { type: 'done' },
        ],
        onState: (s) => states.push({ ...s, history: [...s.history] }),
        onReady: (s) => {
          capturedSubmit = s;
        },
      }),
    );
    await tick();

    // Pre-submit: findings is on the result and is the empty array.
    expect(states[0]?.findings).toBeDefined();
    expect(states[0]?.findings).toEqual([]);

    // Run a normal text-only turn. The scaffold does not extract
    // findings from the stream, so the post-turn state is still [].
    capturedSubmit?.('hi');
    await tick();
    await tick();
    await tick();
    await tick();

    const final = states[states.length - 1];
    expect(final).toBeDefined();
    expect(final!.findings).toEqual([]);
    // Sanity: the text-delta made it through the hook unchanged.
    expect(final!.history).toHaveLength(2);
    expect(final!.history[1]?.content).toBe('Hello');
  });

  it('accepts a tools option without error and still streams text', async () => {
    const states: Array<ReturnType<typeof useAgent>> = [];
    let capturedSubmit: ((t: string) => void) | null = null;

    const tools: readonly Tool<z.ZodTypeAny, z.ZodTypeAny>[] = [
      stubTool('nmap'),
      stubTool('dnsenum'),
    ];

    render(
      React.createElement(Harness, {
        events: [
          { type: 'text-delta', text: 'Plan: ' },
          { type: 'text-delta', text: 'scan host' },
          { type: 'done' },
        ],
        tools,
        onState: (s) => states.push({ ...s, history: [...s.history] }),
        onReady: (s) => {
          capturedSubmit = s;
        },
      }),
    );
    await tick();

    // The hook did not throw on the new `tools` opt (Harness
    // mounted, onState was called).
    expect(states.length).toBeGreaterThan(0);

    capturedSubmit?.('go');
    await tick();
    await tick();
    await tick();
    await tick();
    await tick();

    const final = states[states.length - 1];
    expect(final).toBeDefined();
    expect(final!.streaming).toBe(false);
    // Text streaming is unaffected by the new `tools` opt.
    expect(final!.history).toHaveLength(2);
    expect(final!.history[1]?.content).toBe('Plan: scan host');
    // Findings stays empty (scaffold: no tool execution yet).
    expect(final!.findings).toEqual([]);
  });
});
