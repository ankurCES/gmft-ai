/**
 * Tests for the audit sink helpers + chokepoint decorator.
 *
 * Test count: 2 (per v0.3.C plan §C.1.4)
 *   1. GMFT_DISABLE_AUDIT_LOG=true → makeAuditSink returns NOOP (no append)
 *   2. withAuditChokepoint emits one chokepoint-decision event per decide()
 */

import { describe, it, expect, vi } from 'vitest';
import { NOOP_SINK, makeAuditSink, type AuditSink } from '../src/audit/sink.js';
import { withAuditChokepoint } from '../src/audit/instrument.js';
import type { Chokepoint, ChokepointCall, Decision } from '../src/chokepoint/decision.js';

describe('audit/sink — opt-out', () => {
  it('GMFT_DISABLE_AUDIT_LOG=true yields a no-op sink', () => {
    const inner: AuditSink = { append: vi.fn(async () => {}) };
    const gated = makeAuditSink(inner, { GMFT_DISABLE_AUDIT_LOG: 'true' });
    expect(gated).toBe(NOOP_SINK);
    // Inner sink is NOT wrapped — it's bypassed entirely.
    // (asserted by identity: NOOP_SINK is a frozen const; gated === NOOP_SINK)
  });
});

describe('audit/instrument — withAuditChokepoint', () => {
  it('emits one chokepoint-decision event per decide() call', () => {
    const append = vi.fn(async (_k: string, _p: Record<string, unknown>) => {});
    const sink: AuditSink = { append };
    const inner: Chokepoint = {
      decide(call: ChokepointCall): Decision {
        if (call.tool === 'allowed') return { kind: 'allow' };
        if (call.tool === 'confirmable') return { kind: 'confirm', reason: 'destructive tool' };
        return { kind: 'deny', reason: 'blocked by test' };
      },
    };
    const wrapped = withAuditChokepoint(inner, sink);

    // Three calls, three decisions
    wrapped.decide({ tool: 'allowed', category: 'shell', flags: [], args: {} });
    wrapped.decide({ tool: 'blocked', category: 'shell', flags: ['destructive'], args: { target: '10.0.0.1' } });
    wrapped.decide({ tool: 'confirmable', category: 'web', flags: [], args: {}, typeToConfirm: 'ATTACK' });

    // The fire-and-forget append is microtask-queued; flush them.
    // `await Promise.resolve()` in a microtask drain loop is enough.
    return Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve()).then(() => {
      expect(append).toHaveBeenCalledTimes(3);
      expect(append).toHaveBeenNthCalledWith(1, 'chokepoint-decision', expect.objectContaining({
        tool: 'allowed',
        category: 'shell',
        decision: 'allow',
      }));
      expect(append).toHaveBeenNthCalledWith(2, 'chokepoint-decision', expect.objectContaining({
        tool: 'blocked',
        decision: 'deny',
        reason: 'blocked by test',
      }));
      expect(append).toHaveBeenNthCalledWith(3, 'chokepoint-decision', expect.objectContaining({
        tool: 'confirmable',
        decision: 'confirm',
      }));
    });
  });
});
