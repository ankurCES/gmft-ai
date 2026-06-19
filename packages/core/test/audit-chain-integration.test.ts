/**
 * v0.4-A.6 — End-to-end integration tests for the audit-chain
 * wrapper composition. Proves that when the wrappers are composed
 * the way AgentApp.tsx composes them
 * (`withSupervisor → withAuditSupervisor → withAuditToolResult`),
 * all three audit event kinds (chokepoint-decision, supervisor-fire,
 * tool-result) flow into the sink.
 *
 * The wrappers themselves are unit-tested in their own files
 * (`audit-supervisor.test.ts`, `audit-tool-result.test.ts`). This
 * file covers the COMPOSITION — the cross-cutting question "do the
 * three wrappers cooperate when piped together?" — which is the
 * question that motivated v0.4-A.6: until that slice landed, the
 * supervisor wrapper was exported but not wired into AgentApp, so
 * the composition was never actually exercised in production.
 *
 * Test count: 2 tests
 *   1. A turn that fires the supervisor + runs a tool produces
 *      BOTH `supervisor-fire` and `tool-result` audit events with
 *      the right payloads, AND every event still flows through the
 *      chain so the agent loop's downstream consumers (TUI state,
 *      per-turn event-id collector, etc.) see the full picture.
 *   2. The fire-and-forget semantics survive the chain: audit
 *      failures (sink throws) do not break the iterable drain.
 *
 * Mocks: we don't need `withSupervisor`'s real rule logic for this
 * test — we feed it a pre-shaped event stream (a tool-call-request,
 * a tool-result, a supervisor-fire in the middle, a done). The
 * integration we care about is the wrapper→wrapper→sink plumbing,
 * not the supervisor's rule engine.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  withAuditSupervisor,
  withAuditToolResult,
  type AuditSink,
} from '../src/audit/instrument.js';
import type { AgentEvent } from '../src/agent/loop.js';
import type { SupervisorFire } from '../src/agent/supervisor-types.js';

async function* fromArray<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item;
}

/** Drain an async iterable into an array, then flush the microtask
 * queue so any fire-and-forget `sink.append(...)` calls have landed
 * in the vi.fn() stub before the test inspects them. Same pattern
 * the wrapper test files use. */
async function drainAndFlush(it: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of it) out.push(ev);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  return out;
}

describe('audit/instrument — chain composition (v0.4-A.6)', () => {
  it('withSupervisor → withAuditSupervisor → withAuditToolResult produces both audit-event kinds for one turn', async () => {
    const append = vi.fn(async (_k: string, _p: Record<string, unknown>) => {});
    const sink: AuditSink = { append };

    // A realistic turn: text-delta, tool-call, tool-result (with
    // secretsdump-shaped output to exercise redactAdSecrets), a
    // supervisor-fire in the middle (rule A loop-detected), done.
    const loopFire: SupervisorFire = {
      kind: 'loop-detected',
      tool: 'impacket_psexec',
      count: 4,
      recent: ['impacket_psexec', 'impacket_psexec', 'impacket_psexec', 'impacket_psexec'],
      advice: 'Supervisor: same tool/args pair called 4 times. Vary the args or move on.',
      targetEventId: 'tr1',
    };

    const events: AgentEvent[] = [
      { type: 'text-delta', text: 'starting AD recon' },
      { type: 'tool-call-request', id: 'tr1', name: 'impacket_psexec', args: { target: 'dc01.corp.local' } },
      {
        type: 'tool-result',
        id: 'tr1',
        name: 'impacket_psexec',
        ok: true,
        output: 'psexec returned: Administrator:500:aad3b435b51404eeaad3b435b51404ee:8846f7eaee8fb27ad716cb6168e2d70c:::',
      },
      { type: 'supervisor-fire', fire: loopFire, targetEventId: 'tr1' },
      { type: 'done', text: 'turn complete' },
    ];

    // Mirror AgentApp.tsx's chain composition. We pass the same
    // event stream through both audit decorators in series and
    // confirm both kinds land in the sink.
    const stage1 = withAuditSupervisor(fromArray(events), sink);
    const stage2 = withAuditToolResult(stage1, sink);
    const out = await drainAndFlush(stage2);

    // All 5 events must pass through in order, unchanged — the
    // AgentApp downstream consumers depend on every event landing
    // in the React state.
    expect(out).toHaveLength(5);
    expect(out.map((e) => e.type)).toEqual([
      'text-delta',
      'tool-call-request',
      'tool-result',
      'supervisor-fire',
      'done',
    ]);

    // Two audit appends: one for the tool-result, one for the
    // supervisor-fire. The text-delta, tool-call-request, and done
    // do NOT trigger any audit append (only the two audit wrappers
    // emit, and each fires for one specific event kind).
    expect(append).toHaveBeenCalledTimes(2);

    const [k1, p1] = append.mock.calls[0];
    const [k2, p2] = append.mock.calls[1];
    expect(k1).toBe('tool-result');
    expect(k2).toBe('supervisor-fire');

    // Tool-result payload: name, ok, redacted_fields, output_redacted.
    expect(p1).toMatchObject({
      name: 'impacket_psexec',
      ok: true,
      redacted_fields: ['ntlm-hash'],
    });
    // The redacted output must contain the verbose replacement token,
    // NOT the raw NTLM hash.
    expect(p1.output_redacted).toContain('<redacted:ntlm-hash>');
    expect(p1.output_redacted).not.toContain('8846f7eaee8fb27ad716cb6168e2d70c');

    // Supervisor-fire payload: kind, advice, targetEventId +
    // kind-specific fields (tool, count, recent for loop-detected).
    expect(p2).toMatchObject({
      kind: 'loop-detected',
      advice: loopFire.advice,
      targetEventId: 'tr1',
      tool: 'impacket_psexec',
      count: 4,
      recent: loopFire.recent,
    });
  });

  it('a throwing sink does not break the iterable drain (fire-and-forget survives the chain)', async () => {
    // A sink that always rejects. The wrapper catches the rejection
    // and yields the event anyway — `withAuditSupervisor` and
    // `withAuditToolResult` both swallow audit failures (see the
    // `.catch(() => {})` on `sink.append(...)` in instrument.ts).
    const sink: AuditSink = {
      append: vi.fn(async () => {
        throw new Error('disk full');
      }),
    };

    const events: AgentEvent[] = [
      { type: 'tool-result', id: 'tr1', name: 'nmap', ok: true, output: { hosts: 3 } },
      { type: 'supervisor-fire', fire: { kind: 'plan-issue', severity: 'warn', text: 'high blast radius', advice: 'a', targetEventId: 'tr1' }, targetEventId: 'tr1' },
      { type: 'done', text: 'turn complete' },
    ];

    const stage1 = withAuditSupervisor(fromArray(events), sink);
    const stage2 = withAuditToolResult(stage1, sink);
    const out = await drainAndFlush(stage2);

    // All 3 events still pass through, unchanged, despite the sink
    // throwing on every append call.
    expect(out).toHaveLength(3);
    expect(out.map((e) => e.type)).toEqual(['tool-result', 'supervisor-fire', 'done']);

    // The sink was called twice (once per matching event) — both
    // calls rejected. The wrappers caught the rejections and
    // continued draining.
    expect(sink.append).toHaveBeenCalledTimes(2);
  });
});