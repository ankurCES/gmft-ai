/**
 * Tests for the `withAuditSupervisor` decorator (v0.4-A.3).
 *
 * Test count: 3 (per v0.4-A plan §A.3)
 *   1. emits one supervisor-fire event per yielded fire
 *   2. payload contains the fire's common AND kind-specific fields
 *      (kind, advice, targetEventId are common; PlanIssueFire adds
 *      severity + text; LoopDetectedFire adds tool + count + recent;
 *      RiskEscalationFire adds tool + firstToolOfTurn; OverclaimFire
 *      adds quote + evidence)
 *   3. non-supervisor events pass through unchanged AND do NOT trigger
 *      audit appends (text-delta, tool-call-request, tool-result, done,
 *      error)
 *
 * The fire-and-forget append is microtask-queued — the tests flush it
 * the same way `audit-sink.test.ts` does (Promise.resolve() chained).
 */

import { describe, it, expect, vi } from 'vitest';
import { withAuditSupervisor } from '../src/audit/instrument.js';
import type { AuditSink } from '../src/audit/sink.js';
import type { AgentEvent } from '../src/agent/loop.js';
import type {
  SupervisorFire,
  SupervisorFireEvent,
  LoopDetectedFire,
  RiskEscalationFire,
  PlanIssueFire,
  OverclaimFire,
} from '../src/agent/supervisor-types.js';

async function* fromArray<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item;
}

describe('audit/instrument — withAuditSupervisor (v0.4-A.3)', () => {
  it('emits one supervisor-fire event per yielded fire', async () => {
    const append = vi.fn(async (_k: string, _p: Record<string, unknown>) => {});
    const sink: AuditSink = { append };

    // LoopDetectedFire has tool/count/recent — NO severity or text.
    const fire1: LoopDetectedFire = {
      kind: 'loop-detected',
      tool: 'nmap_scan',
      count: 4,
      recent: ['nmap_scan', 'nmap_scan', 'nmap_scan', 'nmap_scan'],
      advice: 'Supervisor: same tool/args pair called 4 times. Vary the args or move on.',
      targetEventId: 'evt-1',
    };
    // RiskEscalationFire has tool + firstToolOfTurn — NO severity or text.
    const fire2: RiskEscalationFire = {
      kind: 'risk-escalation',
      tool: 'sqlmap',
      firstToolOfTurn: true,
      advice: 'Supervisor: high-blast-radius tool called before any recon.',
      targetEventId: 'evt-2',
    };
    const events: AgentEvent[] = [
      { type: 'text-delta', text: 'starting recon' },
      { type: 'supervisor-fire', fire: fire1, targetEventId: 'evt-1' },
      { type: 'tool-call-request', id: 'c1', name: 'whois', args: { domain: 'example.com' } },
      { type: 'supervisor-fire', fire: fire2, targetEventId: 'evt-2' },
      { type: 'done', text: 'turn complete' },
    ];

    const wrapped = withAuditSupervisor(fromArray(events), sink);
    const out: AgentEvent[] = [];
    for await (const ev of wrapped) out.push(ev);

    // All 5 events must pass through in order, unchanged.
    expect(out).toHaveLength(5);
    expect(out.map((e) => e.type)).toEqual([
      'text-delta',
      'supervisor-fire',
      'tool-call-request',
      'supervisor-fire',
      'done',
    ]);

    // Exactly 2 audit appends, both with kind 'supervisor-fire'.
    // Flush microtasks: the append is fire-and-forget (void).
    await Promise.resolve();
    await Promise.resolve();
    expect(append).toHaveBeenCalledTimes(2);
    expect(append).toHaveBeenNthCalledWith(1, 'supervisor-fire', expect.objectContaining({
      kind: 'loop-detected',
      targetEventId: 'evt-1',
    }));
    expect(append).toHaveBeenNthCalledWith(2, 'supervisor-fire', expect.objectContaining({
      kind: 'risk-escalation',
      targetEventId: 'evt-2',
    }));
  });

  it('payload contains the fire\'s common AND kind-specific fields', async () => {
    const append = vi.fn(async (_k: string, _p: Record<string, unknown>) => {});
    const sink: AuditSink = { append };

    // Yield one of each SupervisorFire variant to prove the spread
    // preserves the variant-specific fields. Asserting ALL four
    // variants in one test gives strong coverage of the discriminator.
    const loopFire: LoopDetectedFire = {
      kind: 'loop-detected',
      tool: 'nmap_scan',
      count: 4,
      recent: ['nmap_scan', 'nmap_scan', 'nmap_scan', 'nmap_scan'],
      advice: 'Supervisor: same tool/args pair called 4 times. Vary the args.',
      targetEventId: 'evt-loop',
    };
    const overclaimFire: OverclaimFire = {
      kind: 'overclaim',
      quote: 'successfully exploited all systems',
      evidence: 'no tool result suggests success',
      advice: 'Supervisor: claim of success without supporting evidence.',
      targetEventId: 'evt-claim',
    };
    const planFire: PlanIssueFire = {
      kind: 'plan-issue',
      severity: 'warn',
      text: 'sqlmap invoked without prior recon',
      advice: 'Supervisor: high-blast-radius tool called before any recon.',
      targetEventId: 'evt-plan',
    };
    const riskFire: RiskEscalationFire = {
      kind: 'risk-escalation',
      tool: 'sqlmap',
      firstToolOfTurn: true,
      advice: 'Supervisor: destructive tool called as first action of turn.',
      targetEventId: 'evt-risk',
    };

    const events: AgentEvent[] = [
      { type: 'supervisor-fire', fire: loopFire, targetEventId: 'evt-loop' } satisfies SupervisorFireEvent,
      { type: 'supervisor-fire', fire: overclaimFire, targetEventId: 'evt-claim' } satisfies SupervisorFireEvent,
      { type: 'supervisor-fire', fire: planFire, targetEventId: 'evt-plan' } satisfies SupervisorFireEvent,
      { type: 'supervisor-fire', fire: riskFire, targetEventId: 'evt-risk' } satisfies SupervisorFireEvent,
    ];

    const wrapped = withAuditSupervisor(fromArray(events), sink);
    for await (const _ev of wrapped) { /* drain */ }

    await Promise.resolve();
    await Promise.resolve();
    expect(append).toHaveBeenCalledTimes(4);

    // Payload 1: LoopDetectedFire — kind-specific fields (tool, count,
    // recent) must be present; severity/text must NOT be present
    // (they're PlanIssueFire-only and should not be invented by the
    // decorator).
    expect(append).toHaveBeenNthCalledWith(1, 'supervisor-fire', expect.objectContaining({
      kind: 'loop-detected',
      advice: expect.stringContaining('Supervisor:'),
      targetEventId: 'evt-loop',
      tool: 'nmap_scan',
      count: 4,
      recent: ['nmap_scan', 'nmap_scan', 'nmap_scan', 'nmap_scan'],
    }));
    {
      const [, payload] = append.mock.calls[0]!;
      expect(payload).not.toHaveProperty('severity');
      expect(payload).not.toHaveProperty('text');
      expect(payload).not.toHaveProperty('fire'); // spread, not wrapper
    }

    // Payload 2: OverclaimFire — kind-specific (quote, evidence) only.
    expect(append).toHaveBeenNthCalledWith(2, 'supervisor-fire', expect.objectContaining({
      kind: 'overclaim',
      quote: expect.stringContaining('successfully exploited'),
      evidence: expect.any(String),
      targetEventId: 'evt-claim',
    }));

    // Payload 3: PlanIssueFire — the ONLY variant that has severity
    // and text. Both must be present in the payload.
    expect(append).toHaveBeenNthCalledWith(3, 'supervisor-fire', expect.objectContaining({
      kind: 'plan-issue',
      severity: 'warn',
      text: 'sqlmap invoked without prior recon',
      targetEventId: 'evt-plan',
    }));

    // Payload 4: RiskEscalationFire — kind-specific (tool,
    // firstToolOfTurn).
    expect(append).toHaveBeenNthCalledWith(4, 'supervisor-fire', expect.objectContaining({
      kind: 'risk-escalation',
      tool: 'sqlmap',
      firstToolOfTurn: true,
      targetEventId: 'evt-risk',
    }));
  });

  it('non-supervisor events pass through unchanged and do NOT trigger audit appends', async () => {
    const append = vi.fn(async (_k: string, _p: Record<string, unknown>) => {});
    const sink: AuditSink = { append };

    const events: AgentEvent[] = [
      { type: 'text-delta', text: 'hello' },
      { type: 'tool-call-request', id: 'c1', name: 'whois', args: { domain: 'example.com' } },
      { type: 'tool-result', id: 'c1', result: { ok: true, output: { registrar: 'GoDaddy' } } },
      { type: 'done', text: 'done' },
      { type: 'error', error: new Error('boom') },
    ];

    const wrapped = withAuditSupervisor(fromArray(events), sink);
    const out: AgentEvent[] = [];
    for await (const ev of wrapped) out.push(ev);

    // All 5 non-supervisor events must pass through in order, UNCHANGED.
    expect(out).toHaveLength(5);
    expect(out[0]).toEqual({ type: 'text-delta', text: 'hello' });
    expect(out[1]).toEqual({ type: 'tool-call-request', id: 'c1', name: 'whois', args: { domain: 'example.com' } });
    expect(out[2]).toEqual({ type: 'tool-result', id: 'c1', result: { ok: true, output: { registrar: 'GoDaddy' } } });
    expect(out[3]).toEqual({ type: 'done', text: 'done' });
    expect(out[4]).toMatchObject({ type: 'error', error: expect.any(Error) });

    // Flush microtasks and verify append was NEVER called.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(append).not.toHaveBeenCalled();
  });
});