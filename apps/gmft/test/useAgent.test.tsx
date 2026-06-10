import { render } from 'ink-testing-library';
import React, { useEffect } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { useAgent } from '../src/ui/hooks/useAgent.js';
import type { ChatMessage } from '@gmft/core';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Build a fake `runTurn` that yields a hard-coded sequence of events.
 * Mirrors the real `runTurn` contract (text-delta, done, error) so the
 * hook's state machine is exercised end-to-end.
 */
function fakeRunTurn(
  events: Array<{ type: 'text-delta'; text: string } | { type: 'done' } | { type: 'error' }>,
): (args: {
  system: string;
  history: readonly ChatMessage[];
  signal?: AbortSignal;
}) => AsyncIterable<
  { type: 'text-delta'; text: string } | { type: 'done'; text: string } | { type: 'error'; error: Error }
> {
  return (_args) => {
    return (async function* () {
      for (const e of events) {
        // Yield one event at a time so the hook's setState in between has
        // a chance to flush before the next chunk.
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
  events: Array<{ type: 'text-delta'; text: string } | { type: 'done' } | { type: 'error' }>;
  onState: (state: ReturnType<typeof useAgent>) => void;
  onReady: (submit: (text: string) => void) => void;
  onError?: (err: Error) => void;
}

function Harness({ events, onState, onReady, onError }: HarnessProps): React.JSX.Element {
  const agent = useAgent({
    system: 'test prompt',
    runTurn: fakeRunTurn(events),
    onError,
  });
  // Expose the latest state to the test on every render.
  useEffect(() => {
    onState(agent);
  });
  // Expose submit once the harness is mounted.
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

describe('useAgent', () => {
  it('streams deltas into the assistant message and ends in done', async () => {
    const states: Array<ReturnType<typeof useAgent>> = [];
    let capturedSubmit: ((t: string) => void) | null = null;

    const { lastFrame } = render(
      React.createElement(Harness, {
        events: [
          { type: 'text-delta', text: 'Hel' },
          { type: 'text-delta', text: 'lo' },
          { type: 'text-delta', text: '!' },
          { type: 'done' },
        ],
        onState: (s) => states.push({ ...s, history: [...s.history] }),
        onReady: (s) => {
          capturedSubmit = s;
        },
      }),
    );
    await tick();

    // Initial state: empty history, not streaming.
    expect(states[0]?.history).toEqual([]);
    expect(states[0]?.streaming).toBe(false);

    // Submit a user message.
    capturedSubmit?.('hi');
    await tick();
    await tick();
    await tick();
    await tick();
    await tick();

    // After streaming: history has 2 messages (user + assistant),
    // assistant content is the concatenation of all deltas, and
    // streaming is back to false.
    const final = states[states.length - 1];
    expect(final).toBeDefined();
    expect(final!.streaming).toBe(false);
    expect(final!.history).toHaveLength(2);
    expect(final!.history[0]?.role).toBe('user');
    expect(final!.history[0]?.content).toBe('hi');
    expect(final!.history[1]?.role).toBe('assistant');
    expect(final!.history[1]?.content).toBe('Hello!');

    // The frame also reflects the final content.
    const frame = lastFrame() ?? '';
    expect(frame).toContain('user:hi');
    expect(frame).toContain('assistant:Hello!');
  });

  it('captures the error event from runTurn and invokes onError', async () => {
    const onError = vi.fn();
    const states: Array<ReturnType<typeof useAgent>> = [];
    let capturedSubmit: ((t: string) => void) | null = null;

    render(
      React.createElement(Harness, {
        events: [{ type: 'error' }],
        onState: (s) => states.push({ ...s, history: [...s.history] }),
        onReady: (s) => {
          capturedSubmit = s;
        },
        onError,
      }),
    );

    await tick();
    capturedSubmit?.('hi');
    await tick();
    await tick();
    await tick();

    const final = states[states.length - 1];
    expect(final).toBeDefined();
    expect(final!.streaming).toBe(false);
    expect(final!.error).toBeInstanceOf(Error);
    expect(final!.error?.message).toBe('fake-stream-error');
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
