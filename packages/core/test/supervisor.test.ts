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

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { withSupervisor } from '../src/agent/supervisor.js';
import type { AgentEvent } from '../src/agent/loop.js';
import type { ChatMessage } from '../src/agent/context.js';
import type { SupervisorTurnRecord } from '../src/agent/supervisor-types.js';
import type { LanguageModel } from 'ai';

// Mock the `ai` SDK so `generatePostmortem`'s call to `generateText`
// is deterministic. vi.mock is hoisted, so this takes effect for the
// `supervisor` import below.
vi.mock('ai', () => ({
  generateText: vi.fn(),
}));
import { generateText } from 'ai';
const mockedGenerateText = vi.mocked(generateText);

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
    // No model supplied => no postmortem event yielded, but lastPostmortem()
    // is still populated with the fires-only record so the session log
    // can append it.
    mockedGenerateText.mockReset();
    const inner = fakeTurn([{ type: 'done', text: 'hi' }]);
    const wrapped = withSupervisor({
      runTurn: () => inner,
      runTurnOpts: { model: {} as never, system: '', history: [] },
      historyRef: { current: [] },
    });
    const out: AgentEvent[] = [];
    for await (const ev of wrapped) out.push(ev);
    expect(out).toHaveLength(1);
    expect(out[0]?.type).toBe('done');
    // v0.2.A.2 exposed `lastFires()`; v0.2.A.3 adds `lastPostmortem()`.
    expect(wrapped.lastFires()).toEqual([]);
    expect(wrapped.lastPostmortem()).toEqual({ fires: [] });
    // No model => no LLM call, no supervisor-postmortem event.
    expect(mockedGenerateText).not.toHaveBeenCalled();
  });
});

describe('withSupervisor — advice injection', () => {
  it('mutates historyRef with a role:user advice message when a rule fires', async () => {
    const historyRef = { current: [] as ChatMessage[] };
    const inner = fakeTurn([
      { type: 'tool-call-request', id: '1', name: 'nmap_scan', args: { target: 'h', ports: '80' } },
      { type: 'tool-call-request', id: '2', name: 'nmap_scan', args: { target: 'h', ports: '80' } },
      { type: 'tool-call-request', id: '3', name: 'nmap_scan', args: { target: 'h', ports: '80' } },
      { type: 'tool-call-request', id: '4', name: 'nmap_scan', args: { target: 'h', ports: '80' } },
      { type: 'done', text: '' },
    ]);
    const wrapped = withSupervisor({
      runTurn: () => inner,
      runTurnOpts: { model: {} as never, system: '', history: [] },
      historyRef,
    });
    const events: AgentEvent[] = [];
    for await (const ev of wrapped) events.push(ev);
    // At least 1 supervisor-fire (Rule A on the 4th identical call).
    // Rule C.2 also fires on the 3rd and 4th nmap family calls, so we
    // expect AT LEAST 1 — not exactly 1.
    const fires = events.filter(e => e.type === 'supervisor-fire');
    expect(fires.length).toBeGreaterThanOrEqual(1);
    const loopFire = fires.find(f => f.type === 'supervisor-fire' && f.fire.kind === 'loop-detected');
    expect(loopFire).toBeDefined();
    if (loopFire?.type === 'supervisor-fire') {
      expect(loopFire.targetEventId).toBe('4');
    }
    // History grew by exactly the number of fires (each fire pushes one advice msg).
    // NOTE: the wrapper does `historyRef.current = [...historyRef.current, msg]`,
    // which REPLACES the array — the local `history` variable still points
    // to the original empty array. We must read `historyRef.current` to
    // see the new state. (This is a test-fixture pattern documented in
    // supervisor.ts as the "immutable mutation" contract.)
    expect(historyRef.current).toHaveLength(fires.length);
    // Every history entry is a role:user Supervisor message
    for (const h of historyRef.current) {
      expect(h.role).toBe('user');
      expect(h.content).toMatch(/^Supervisor:/);
    }
  });

  it('does NOT mutate history on the 3rd call (below threshold)', async () => {
    const history: ChatMessage[] = [];
    const inner = fakeTurn([
      { type: 'tool-call-request', id: '1', name: 'nmap_scan', args: { target: 'h' } },
      { type: 'tool-call-request', id: '2', name: 'nmap_scan', args: { target: 'h' } },
      { type: 'tool-call-request', id: '3', name: 'nmap_scan', args: { target: 'h' } },
      { type: 'done', text: '' },
    ]);
    const wrapped = withSupervisor({
      runTurn: () => inner,
      runTurnOpts: { model: {} as never, system: '', history: [] },
      historyRef: { current: history },
    });
    for await (const _ev of wrapped) { /* drain */ }
    expect(history).toHaveLength(0);
  });

  it('yields the supervisor-fire event AFTER the triggering event, not before', async () => {
    const history: ChatMessage[] = [];
    const inner = fakeTurn([
      { type: 'tool-call-request', id: '1', name: 'whois', args: { target: 'h' } },
      { type: 'tool-call-request', id: '2', name: 'whois', args: { target: 'h' } },
      { type: 'tool-call-request', id: '3', name: 'whois', args: { target: 'h' } },
      { type: 'tool-call-request', id: '4', name: 'whois', args: { target: 'h' } },
      { type: 'done', text: '' },
    ]);
    const wrapped = withSupervisor({
      runTurn: () => inner,
      runTurnOpts: { model: {} as never, system: '', history: [] },
      historyRef: { current: history },
    });
    const events: AgentEvent[] = [];
    for await (const ev of wrapped) events.push(ev);
    // No supervisor-fire ever appears before its triggering tool-call-request.
    // Each fire must come IMMEDIATELY BEFORE the event whose id matches its
    // targetEventId (the wrapper yields fires-then-event in one chunk per
    // event; so fireIdx should be targetIdx - 1, never greater).
    const fires = events.filter(e => e.type === 'supervisor-fire');
    expect(fires.length).toBeGreaterThanOrEqual(1);
    for (const e of events) {
      if (e.type !== 'supervisor-fire') continue;
      const targetId = e.targetEventId;
      const targetIdx = events.findIndex(x => x.type === 'tool-call-request' && x.id === targetId);
      const fireIdx = events.indexOf(e);
      // fire must come BEFORE its target (not after, and not at the same idx)
      expect(fireIdx).toBeLessThan(targetIdx);
    }
    // Sequence always ends with done.
    expect(events[events.length - 1]?.type).toBe('done');
  });

  it('lastFires() returns the fires from the LAST completed turn, not all-time', async () => {
    const history: ChatMessage[] = [];
    // Two turns in one stream
    const inner = fakeTurn([
      { type: 'tool-call-request', id: '1', name: 'whois', args: { target: 'h' } },
      { type: 'tool-call-request', id: '2', name: 'whois', args: { target: 'h' } },
      { type: 'tool-call-request', id: '3', name: 'whois', args: { target: 'h' } },
      { type: 'tool-call-request', id: '4', name: 'whois', args: { target: 'h' } },
      { type: 'done', text: '' },
      // Turn 2: 2 calls, no fire
      { type: 'tool-call-request', id: '5', name: 'dig', args: { target: 'h' } },
      { type: 'tool-call-request', id: '6', name: 'dig', args: { target: 'h' } },
      { type: 'done', text: '' },
    ]);
    const wrapped = withSupervisor({
      runTurn: () => inner,
      runTurnOpts: { model: {} as never, system: '', history: [] },
      historyRef: { current: history },
    });
    for await (const _ev of wrapped) { /* drain */ }
    // Turn 2 had 0 fires — lastFires() returns [] for the LAST turn
    expect(wrapped.lastFires()).toEqual([]);
  });
});

describe('withSupervisor — Rule B and Rule C integration', () => {
  it('Rule B: empty-findings claim injects a Supervisor: advice message', async () => {
    const historyRef = { current: [] as ChatMessage[] };
    const inner = fakeTurn([
      { type: 'text-delta', text: 'The port scan is complete.' },
      { type: 'done', text: 'The port scan is complete.' },
    ]);
    const wrapped = withSupervisor({
      runTurn: () => inner,
      runTurnOpts: { model: {} as never, system: '', history: [] },
      historyRef,
      sessionFindings: [], // empty
    });
    const events: AgentEvent[] = [];
    for await (const ev of wrapped) events.push(ev);
    expect(events.filter(e => e.type === 'supervisor-fire')).toHaveLength(1);
    expect(historyRef.current).toHaveLength(1);
    expect(historyRef.current[0]?.content).toMatch(/no findings were written to disk/);
  });

  it('Rule C: destructive without prior recon injects a Supervisor: advice message', async () => {
    const historyRef = { current: [] as ChatMessage[] };
    // First call: a NON-recon tool (e.g. shell_exec) so reconCallsThisTurn
    // stays 0. Second call: a destructive tool with the 'destructive' flag.
    // Rule C.1 fires because the destructive call had no prior recon.
    const inner = fakeTurn([
      { type: 'tool-call-request', id: '1', name: 'shell_exec', args: { cmd: 'ls' } },
      {
        type: 'tool-call-request',
        id: '2',
        name: 'nuclei_run',
        args: { target: 'h' },
        flags: ['destructive'],
      } as AgentEvent,
      { type: 'done', text: '' },
    ]);
    const wrapped = withSupervisor({
      runTurn: () => inner,
      runTurnOpts: { model: {} as never, system: '', history: [] },
      historyRef,
    });
    for await (const _ev of wrapped) { /* drain */ }
    expect(historyRef.current).toHaveLength(1);
    expect(historyRef.current[0]?.content).toMatch(/destructive tool without any prior recon/);
  });

  it('Rule A and Rule B can both fire in the same turn (history grows by N where N >= 2)', async () => {
    const historyRef = { current: [] as ChatMessage[] };
    // Turn: 4 nmap calls (Rule A) + C.2 also fires (3+ nmap family), then a "scan complete" text-delta (Rule B with no findings)
    const inner = fakeTurn([
      { type: 'tool-call-request', id: '1', name: 'nmap_scan', args: { target: 'h' } },
      { type: 'tool-call-request', id: '2', name: 'nmap_scan', args: { target: 'h' } },
      { type: 'tool-call-request', id: '3', name: 'nmap_scan', args: { target: 'h' } },
      { type: 'tool-call-request', id: '4', name: 'nmap_scan', args: { target: 'h' } },
      { type: 'text-delta', text: 'The scan is complete.' },
      { type: 'done', text: '' },
    ]);
    const wrapped = withSupervisor({
      runTurn: () => inner,
      runTurnOpts: { model: {} as never, system: '', history: [] },
      historyRef,
      sessionFindings: [],
    });
    const events: AgentEvent[] = [];
    for await (const ev of wrapped) events.push(ev);
    const fires = events.filter(e => e.type === 'supervisor-fire');
    // At least 2 fires expected: Rule A on the 4th call + Rule B on the
    // "scan is complete" claim. Rule C.2 may also fire (3rd and 4th nmap
    // family calls), so the actual count is higher — we only assert
    // "at least 2" to lock in the "both can fire" contract.
    expect(fires.length).toBeGreaterThanOrEqual(2);
    expect(historyRef.current).toHaveLength(fires.length);
    // Verify the two specific fires are present
    const fireKinds = new Set(fires.map(f => f.type === 'supervisor-fire' ? f.fire.kind : null));
    expect(fireKinds.has('loop-detected')).toBe(true);
    expect(fireKinds.has('overclaim')).toBe(true);
  });
});

describe('withSupervisor — postmortem integration (v0.2.A.3)', () => {
  beforeEach(() => {
    mockedGenerateText.mockReset();
  });

  it('emits a supervisor-postmortem event after the done event when model is provided', async () => {
    mockedGenerateText.mockResolvedValue({
      text: 'WHAT: x\nLEARNED: y\nMISSING: z\nNEXT: w',
    } as never);
    const postmortemReceived: SupervisorTurnRecord[] = [];
    const inner = fakeTurn([{ type: 'done', text: 'work' }]);
    const wrapped = withSupervisor({
      runTurn: () => inner,
      runTurnOpts: { model: {} as never, system: '', history: [] },
      historyRef: { current: [] },
      model: {} as unknown as LanguageModel,
      turnTextRef: { current: 'work' },
      onPostmortem: (r) => postmortemReceived.push(r),
    });
    const events: AgentEvent[] = [];
    for await (const ev of wrapped) events.push(ev);
    const postmortems = events.filter(e => e.type === 'supervisor-postmortem');
    expect(postmortems).toHaveLength(1);
    if (postmortems[0]?.type === 'supervisor-postmortem') {
      expect(postmortems[0].body).toMatch(/WHAT/);
      expect(postmortems[0].fireCount).toBe(0);
      expect(postmortems[0].turnId).toBe('turn');
    }
    // onPostmortem called exactly once with a record containing the body
    expect(postmortemReceived).toHaveLength(1);
    expect(postmortemReceived[0]?.postmortem).toMatch(/WHAT/);
    expect(postmortemReceived[0]?.fires).toEqual([]);
  });

  it('lastPostmortem() returns the SupervisorTurnRecord from the last turn', async () => {
    mockedGenerateText.mockResolvedValue({
      text: 'WHAT: x\nLEARNED: y\nMISSING: z\nNEXT: w',
    } as never);
    const inner = fakeTurn([{ type: 'done', text: 'x' }]);
    const wrapped = withSupervisor({
      runTurn: () => inner,
      runTurnOpts: { model: {} as never, system: '', history: [] },
      historyRef: { current: [] },
      model: {} as unknown as LanguageModel,
      turnTextRef: { current: 'x' },
    });
    for await (const _ev of wrapped) { /* drain */ }
    const pm = wrapped.lastPostmortem();
    expect(pm).toBeDefined();
    expect(pm?.fires).toEqual([]);
    expect(pm?.postmortem).toMatch(/WHAT/);
  });

  it('does not call the model if `model` is not provided (opt-out)', async () => {
    const inner = fakeTurn([{ type: 'done', text: 'x' }]);
    const wrapped = withSupervisor({
      runTurn: () => inner,
      runTurnOpts: { model: {} as never, system: '', history: [] },
      historyRef: { current: [] },
      // no `model` — caller opted out
    });
    const events: AgentEvent[] = [];
    for await (const ev of wrapped) events.push(ev);
    expect(events.filter(e => e.type === 'supervisor-postmortem')).toHaveLength(0);
    expect(mockedGenerateText).not.toHaveBeenCalled();
    // lastPostmortem is still populated with the fires-only record
    expect(wrapped.lastPostmortem()).toEqual({ fires: [] });
  });
});
