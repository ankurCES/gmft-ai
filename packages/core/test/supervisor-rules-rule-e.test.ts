import { describe, it, expect } from 'vitest';
import {
  observeRuleE,
  observeRuleC,
  resetForNewTurn,
} from '../src/agent/supervisor-rules.js';
import {
  createInitialState,
  SupervisorFireRecordSchema,
} from '../src/agent/supervisor-types.js';
import type { AgentEvent } from '../src/agent/loop.js';

// Helper that passes `flags` (the existing supervisor-rules.test.ts
// helper at line 6 omits flags, so we need a richer helper for Rule E
// which gates on `flags?.includes('destructive')`).
const toolCall = (
  id: string,
  name: string,
  args: Record<string, unknown>,
  flags?: readonly string[],
): AgentEvent => ({
  type: 'tool-call-request',
  id,
  name,
  args,
  ...(flags ? { flags } : {}),
});

describe('observeRuleE — risk escalation (v0.4-A, ADR-0014)', () => {
  it('fires on destructive tool as the first tool of the turn', () => {
    const state = createInitialState();
    const r = observeRuleE(
      state,
      toolCall('1', 'sqlmap', { url: 'http://example.com/' }, ['destructive']),
    );
    expect(r.fire).toBeDefined();
    expect(r.fire?.kind).toBe('risk-escalation');
    expect(r.fire?.tool).toBe('sqlmap');
    expect(r.fire?.firstToolOfTurn).toBe(true);
    expect(r.fire?.targetEventId).toBe('1');
    expect(r.fire?.advice).toContain('opened this turn with a destructive tool');
    expect(r.fire?.advice).toContain('sqlmap');
  });

  it('is silent on destructive call as the 2nd tool of the turn', () => {
    // Simulate post-Rule-C state: toolsCalledThisTurn === 1.
    // This is the gate that catches the wiring-order bug — if Rule E is
    // wired AFTER observeRuleC, the pre-call counter is 1 (post-increment)
    // and Rule E would fire here, which is wrong.
    let state = createInitialState();
    // First tool is a recon read (non-destructive). Run it through Rule C
    // so the wrapper's normal sequence (A → E → C → B) is exercised end-to-end.
    const r1 = observeRuleC(state, toolCall('1', 'whois', { target: 'example.com' }));
    state = r1.state;
    expect(state.ruleC.toolsCalledThisTurn).toBe(1);
    // Now a destructive call arrives. Rule E must NOT fire (it's not the first).
    const r2 = observeRuleE(
      state,
      toolCall('2', 'sqlmap', { url: 'http://example.com/' }, ['destructive']),
    );
    expect(r2.fire).toBeUndefined();
  });

  it('is silent on non-destructive tools', () => {
    const state = createInitialState();
    const r = observeRuleE(
      state,
      toolCall('1', 'whois', { target: 'example.com' }),
    );
    expect(r.fire).toBeUndefined();
  });

  it('is silent on non-tool-call-request events (text-delta, tool-result)', () => {
    const state = createInitialState();
    const textEvent: AgentEvent = { type: 'text-delta', text: 'starting scan' };
    expect(observeRuleE(state, textEvent).fire).toBeUndefined();
    const toolResult: AgentEvent = {
      type: 'tool-result',
      id: 'r1',
      ok: true,
      output: {},
    };
    expect(observeRuleE(state, toolResult).fire).toBeUndefined();
  });

  it('Rule E and Rule C.1 do NOT double-fire on the same event (different gates, complementary)', () => {
    // Rule C.1 has the gate `isDestructive && reconCallsThisTurn === 0 &&
    // toolsCalledThisTurn > 0` (note the `> 0` — it deliberately skips the
    // first tool of the turn). Rule E has the gate
    // `isDestructive && toolsCalledThisTurn === 0`. These are DISJOINT:
    // - First tool is destructive → C.1 silent (toolsCalledThisTurn > 0
    //   fails), E fires (toolsCalledThisTurn === 0)
    // - A non-recon/non-destructive tool came first, then a destructive
    //   tool → C.1 fires (recon=0, tools>0, destructive), E silent
    //   (toolsCalledThisTurn === 0 fails)
    // Note: a recon tool (whois, dig, etc.) followed by a destructive
    // tool does NOT trigger C.1 — C.1's gate requires `reconCallsThisTurn
    // === 0`, and a prior recon tool makes recon > 0. The Case B pick
    // below uses a non-recon, non-destructive tool to specifically land
    // in the "no recon, not first" bucket where C.1 fires.
    //
    // The `nmap_*` tools ARE in RECON_TOOL_NAMES at
    // supervisor-rules.ts:291-294, so they would suppress C.1. We use
    // `read_file` as a generic non-recon/non-destructive stand-in.

    // Case A: first tool is destructive. E fires, C.1 silent.
    let state = createInitialState();
    const firstDestructive = toolCall('1', 'sqlmap', { url: 'http://x/' }, ['destructive']);
    const eA = observeRuleE(state, firstDestructive);
    const cA = observeRuleC(state, firstDestructive);
    expect(eA.fire).toBeDefined();
    expect(cA.fire).toBeUndefined();

    // Case B: a non-recon/non-destructive tool came first, then a
    // destructive tool. C.1 fires, E silent.
    state = createInitialState();
    const firstReadonly = toolCall('1', 'read_file', { path: '/etc/hosts' });
    const cFirst = observeRuleC(state, firstReadonly);
    state = cFirst.state;
    expect(state.ruleC.toolsCalledThisTurn).toBe(1);
    expect(state.ruleC.reconCallsThisTurn).toBe(0); // read_file is not in RECON_TOOL_NAMES
    const secondDestructive = toolCall('2', 'sqlmap', { url: 'http://x/' }, ['destructive']);
    const eB = observeRuleE(state, secondDestructive);
    const cB = observeRuleC(state, secondDestructive);
    expect(eB.fire).toBeUndefined();
    expect(cB.fire).toBeDefined();
    expect(cB.fire?.kind).toBe('plan-issue');
  });

  it('SupervisorFireRecordSchema accepts a risk-escalation record', () => {
    // The wire-format schema is what the audit writer validates against.
    // If this test fails, the new fire kind is invisible to the audit chain.
    const record = {
      kind: 'risk-escalation' as const,
      tool: 'sqlmap',
      firstToolOfTurn: true as const,
      advice: 'Supervisor: you opened this turn with a destructive tool (`sqlmap`).',
      targetEventId: 'evt-1',
    };
    const parsed = SupervisorFireRecordSchema.parse(record);
    expect(parsed.kind).toBe('risk-escalation');
    expect(parsed.firstToolOfTurn).toBe(true);
  });

  it('SupervisorFireRecordSchema rejects an unknown kind literal', () => {
    // Regression guard: a future maintainer who adds a new fire kind
    // but forgets to extend the schema sees the test fail with a clear
    // ZodError rather than silently dropping the fire at the audit
    // writer boundary.
    expect(() =>
      SupervisorFireRecordSchema.parse({
        kind: 'not-a-real-kind',
        tool: 'sqlmap',
        firstToolOfTurn: true,
        advice: 'x',
        targetEventId: 'y',
      } as never),
    ).toThrow();
  });

  it('resetForNewTurn clears the counter so Rule E can fire on the next turn', () => {
    // Without reset, Rule E would fire ONCE per session and never again,
    // because state.ruleC.toolsCalledThisTurn only ever grows.
    let state = createInitialState();
    // Simulate a turn: first tool is destructive, Rule E fires.
    const r1 = observeRuleE(
      state,
      toolCall('1', 'sqlmap', { url: 'http://x/' }, ['destructive']),
    );
    expect(r1.fire).toBeDefined();
    // Simulate the wrapper's per-event Rule C invocation (which increments
    // toolsCalledThisTurn) and applyFire (which doesn't change ruleC counters).
    const rC = observeRuleC(r1.state, toolCall('1', 'sqlmap', { url: 'http://x/' }, ['destructive']));
    state = rC.state;
    expect(state.ruleC.toolsCalledThisTurn).toBe(1);

    // New turn begins — resetForNewTurn zeros the counter.
    state = resetForNewTurn(state);
    expect(state.ruleC.toolsCalledThisTurn).toBe(0);

    // Rule E can fire again on the next turn.
    const r2 = observeRuleE(
      state,
      toolCall('2', 'sqlmap', { url: 'http://y/' }, ['destructive']),
    );
    expect(r2.fire).toBeDefined();
    expect(r2.fire?.kind).toBe('risk-escalation');
    expect(r2.fire?.targetEventId).toBe('2');
  });
});
