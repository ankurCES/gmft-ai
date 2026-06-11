/**
 * v0.1 phase 6 — tests for the chain-state surface on `useAgent`.
 *
 * Two scenarios:
 *   1. `chain-started` + `chain-finished` update `chainState` and
 *      populate `totals` + `done: true`.
 *   2. `chain-step-started` + `chain-step-finished` interleave
 *      correctly: each started appends a step, each finished
 *      annotates the matching step with status/duration/findings.
 *      The test asserts the step order in `chainState.steps` matches
 *      the event emission order.
 *
 * The harness mirrors `useAgent.test.tsx` but with a wider event
 * union (includes all 4 `chain-*` variants + the existing
 * `text-delta` / `done` / `error`). The state is captured on every
 * render via a `useEffect` so we can assert against the post-tick
 * state.
 */

import { render } from 'ink-testing-library';
import React, { useEffect } from 'react';
import { describe, it, expect } from 'vitest';
import { useAgent, type ChainState } from '../src/ui/hooks/useAgent.js';
import type { ChatMessage } from '@gmft/core';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * The full set of event variants the agent loop can yield. v0.1 phase 6
 * includes the 4 `chain-*` variants in addition to the phase 2 + 3
 * set. The harness types accept this union so tests can replay
 * realistic sequences.
 */
type HarnessEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'done'; text: string }
  | { type: 'error'; error: Error }
  | { type: 'tool-call-request'; id: string; name: string; args: Record<string, unknown> }
  | { type: 'tool-result'; id: string; name: string; ok: boolean; output?: unknown; reason?: string }
  | { type: 'confirmation-needed'; id: string; name: string; reason: string; prompt?: string }
  | { type: 'chain-started'; chainId: string; stepCount: number }
  | { type: 'chain-step-started'; chainId: string; stepIndex: number; tool: string; name?: string }
  | {
      type: 'chain-step-finished';
      chainId: string;
      stepIndex: number;
      status: 'ok' | 'denied' | 'erred' | 'skipped';
      durationMs: number;
      findingCount: number;
      reason?: string;
    }
  | {
      type: 'chain-finished';
      chainId: string;
      totalSteps: number;
      completed: number;
      denied: number;
      erred: number;
    };

function fakeRunTurn(
  events: readonly HarnessEvent[],
): (args: {
  system: string;
  history: readonly ChatMessage[];
  signal?: AbortSignal;
}) => AsyncIterable<HarnessEvent> {
  return (_args) => {
    return (async function* () {
      for (const e of events) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise<void>((r) => setImmediate(r));
        yield e as HarnessEvent;
      }
    })();
  };
}

interface HarnessProps {
  events: readonly HarnessEvent[];
  onState: (state: ReturnType<typeof useAgent>) => void;
  onReady: (submit: (text: string) => void) => void;
  onError?: (err: Error) => void;
}

function Harness({ events, onState, onReady, onError }: HarnessProps): React.JSX.Element {
  const agent = useAgent({
    system: 'test prompt',
    runTurn: fakeRunTurn(events),
    ...(onError ? { onError } : {}),
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
 * Test that uses the `useAgent` hook's chain state surface.
 */
describe('useAgent — chain state surface (v0.1 phase 6)', () => {
  it('updates chainState on chain-started + chain-finished (totals + done)', async () => {
    const states: Array<ReturnType<typeof useAgent>> = [];
    let capturedSubmit: ((t: string) => void) | null = null;

    render(
      React.createElement(Harness, {
        events: [
          { type: 'chain-started', chainId: 'c-1', stepCount: 3 },
          { type: 'chain-step-started', chainId: 'c-1', stepIndex: 0, tool: 'nmap', name: 'scan' },
          { type: 'chain-step-finished', chainId: 'c-1', stepIndex: 0, status: 'ok', durationMs: 100, findingCount: 0 },
          { type: 'chain-step-started', chainId: 'c-1', stepIndex: 1, tool: 'curl', name: 'fetch' },
          { type: 'chain-step-finished', chainId: 'c-1', stepIndex: 1, status: 'ok', durationMs: 50, findingCount: 2 },
          { type: 'chain-step-started', chainId: 'c-1', stepIndex: 2, tool: 'sqlmap', name: 'inject' },
          { type: 'chain-step-finished', chainId: 'c-1', stepIndex: 2, status: 'denied', durationMs: 10, findingCount: 0, reason: 'user denied' },
          { type: 'chain-finished', chainId: 'c-1', totalSteps: 3, completed: 2, denied: 1, erred: 0 },
          { type: 'done', text: '' },
        ],
        onState: (s) => states.push({ ...s, history: [...s.history] }),
        onReady: (s) => {
          capturedSubmit = s;
        },
      }),
    );

    await tick();
    // Pre-submit: chainState is null, chainTick is 0.
    const baseline = states[0];
    expect(baseline).toBeDefined();
    expect(baseline!.chainState).toBeNull();
    expect(baseline!.chainTick).toBe(0);

    capturedSubmit?.('start');
    // Yield plenty of ticks so every chain event lands before we assert.
    for (let i = 0; i < 20; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await tick();
    }

    // Find the post-streaming state: the LAST state where
    // `streaming === false` AND `chainTick > 0` (so we know the
    // turn actually ran). The post-submit baseline (the very first
    // state) also has `streaming === false`, so we filter on tick
    // > 0 to skip it.
    const final = [...states].reverse().find((s) => s.streaming === false && s.chainTick > 0);
    expect(final).toBeDefined();
    const cs = final!.chainState!;
    expect(cs.chainId).toBe('c-1');
    expect(cs.stepCount).toBe(3);
    expect(cs.totals).toEqual({ completed: 2, denied: 1, erred: 0 });
    expect(cs.done).toBe(true);
    // chainTick bumped at least once per chain event (we don't
    // assert the exact count because React batches state updates).
    expect(final!.chainTick).toBeGreaterThan(0);
    // streaming is back to false (the 'done' event landed).
    expect(final!.streaming).toBe(false);
  });

  it('appends chain steps in emission order, annotating with finished status + duration', async () => {
    const states: Array<ReturnType<typeof useAgent>> = [];
    let capturedSubmit: ((t: string) => void) | null = null;

    render(
      React.createElement(Harness, {
        events: [
          { type: 'chain-started', chainId: 'c-2', stepCount: 2 },
          { type: 'chain-step-started', chainId: 'c-2', stepIndex: 0, tool: 'nmap', name: 'portscan' },
          { type: 'chain-step-finished', chainId: 'c-2', stepIndex: 0, status: 'ok', durationMs: 1234, findingCount: 5 },
          { type: 'chain-step-started', chainId: 'c-2', stepIndex: 1, tool: 'nikto', name: 'web-scan' },
          { type: 'chain-step-finished', chainId: 'c-2', stepIndex: 1, status: 'erred', durationMs: 42, findingCount: 0, reason: 'timeout' },
          { type: 'chain-finished', chainId: 'c-2', totalSteps: 2, completed: 1, denied: 0, erred: 1 },
          { type: 'done', text: '' },
        ],
        onState: (s) => states.push({ ...s, history: [...s.history] }),
        onReady: (s) => {
          capturedSubmit = s;
        },
      }),
    );

    await tick();
    capturedSubmit?.('run');
    for (let i = 0; i < 20; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await tick();
    }

    // Post-streaming state: the LAST state where `streaming ===
    // false` AND `chainTick > 0` (skips the pre-submit baseline).
    // At that point the chain state is also settled
    // (chain-finished emitted before done in the event sequence).
    const final = [...states].reverse().find((s) => s.streaming === false && s.chainTick > 0);
    expect(final).toBeDefined();
    const cs = final!.chainState!;

    // Two steps, in emission order (index 0 then index 1).
    expect(cs.steps).toHaveLength(2);
    expect(cs.steps[0]?.index).toBe(0);
    expect(cs.steps[0]?.tool).toBe('nmap');
    expect(cs.steps[0]?.name).toBe('portscan');
    expect(cs.steps[0]?.status).toBe('ok');
    expect(cs.steps[0]?.durationMs).toBe(1234);
    expect(cs.steps[0]?.findingCount).toBe(5);

    expect(cs.steps[1]?.index).toBe(1);
    expect(cs.steps[1]?.tool).toBe('nikto');
    expect(cs.steps[1]?.name).toBe('web-scan');
    expect(cs.steps[1]?.status).toBe('erred');
    expect(cs.steps[1]?.durationMs).toBe(42);
    expect(cs.steps[1]?.reason).toBe('timeout');

    // Totals reflect the chain-finished payload.
    expect(cs.totals).toEqual({ completed: 1, denied: 0, erred: 1 });
  });
});
