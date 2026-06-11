/**
 * v0.2.A.2 — `withSupervisor` wrapper tests.
 *
 * The wrapper observes an inner `runTurn` AsyncIterable<AgentEvent>,
 * runs the 3 rules from A.1, yields `supervisor-fire` events, and
 * mutates the caller's historyRef with `role: 'user'` advice
 * messages. These tests verify the wrapper's contract end-to-end.
 *
 * The 3 rules themselves are tested in `supervisor-rules.test.ts`
 * (A.1). This file tests the wrapper's *integration* with the rules.
 */

import { describe, it, expect } from 'vitest';
import { withSupervisor } from '../src/agent/supervisor.js';
import type { AgentEvent } from '../src/agent/loop.js';
import type { ChatMessage } from '../src/agent/context.js';

async function* fakeTurn(events: AgentEvent[]): AsyncIterable<AgentEvent> {
  for (const e of events) yield e;
}

describe('withSupervisor — passthrough behavior', () => {
  it('yields every inner event in order when no rule fires', async () => {
    const history: ChatMessage[] = [];
    const inner = fakeTurn([
      { type: 'text-delta', text: 'Hello' },
      { type: 'done', text: 'Hello' },
    ]);
    const wrapped = withSupervisor({
      runTurn: () => inner,
      runTurnOpts: { model: {} as never, system: '', history: [] },
      historyRef: { current: history },
    });
    const out: AgentEvent[] = [];
    for await (const ev of wrapped) out.push(ev);
    expect(out.map(e => e.type)).toEqual(['text-delta', 'done']);
    // history unchanged — no advice
    expect(history).toHaveLength(0);
  });

  it('does not swallow inner errors', async () => {
    const err = new Error('boom');
    const inner = fakeTurn([
      { type: 'text-delta', text: 'x' },
      { type: 'error', error: err },
    ]);
    const wrapped = withSupervisor({
      runTurn: () => inner,
      runTurnOpts: { model: {} as never, system: '', history: [] },
      historyRef: { current: [] },
    });
    const out: AgentEvent[] = [];
    for await (const ev of wrapped) out.push(ev);
    expect(out[1]?.type).toBe('error');
    if (out[1]?.type === 'error') expect(out[1].error).toBe(err);
  });

  it('returns the post-processed SupervisorTurnRecord (fires=[]) after a turn', async () => {
    const inner = fakeTurn([{ type: 'done', text: 'hi' }]);
    const wrapped = withSupervisor({
      runTurn: () => inner,
      runTurnOpts: { model: {} as never, system: '', history: [] },
      historyRef: { current: [] },
    });
    const out: AgentEvent[] = [];
    for await (const ev of wrapped) out.push(ev);
    expect(out).toHaveLength(1);
    // v0.2.A.2 doesn't yet emit supervisor-postmortem (that's A.3).
    // The wrapper exposes the LAST turn's fires via `lastFires()`.
    expect(wrapped.lastFires()).toEqual([]);
  });
});
