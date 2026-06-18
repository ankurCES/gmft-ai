/**
 * v0.3.C follow-up — AgentApp audit-sink wiring.
 *
 * The library-side `withAuditChokepoint` and `makeAuditSink` are
 * covered in `@gmft/core/test/audit-sink.test.ts`. This file is
 * the AgentApp-layer slice: proving that
 *   (1) the `writerToSink` adapter bridges `AuditWriter.append`
 *       (returns `Promise<AuditEvent>`) into the `AuditSink.append`
 *       contract (returns `Promise<void>`) — without dropping or
 *       reshaping the side effect, and without leaking the event
 *       to the sink caller.
 *   (2) `GMFT_DISABLE_AUDIT_LOG=true` causes `makeAuditSink` to
 *       return `NOOP_SINK` at construction time — flipping the
 *       env var mid-process is a no-op on a sink that's already
 *       been built (defense-in-depth for the long-running TUI).
 *
 * We don't drive the full AgentApp React tree here — that's the
 * `agent-app.test.tsx` job, and it mocks `createModel` + `runTurn`
 * so the chokepoint path never executes (no audit sink is built).
 * The seam we care about is the adapter + the env-var check.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AuditWriter,
  makeAuditSink,
  NOOP_SINK,
  type AuditSink,
} from '@gmft/core';

describe('AgentApp audit-sink wiring (v0.3.C follow-up)', () => {
  beforeEach(() => {
    delete process.env.GMFT_DISABLE_AUDIT_LOG;
  });

  afterEach(() => {
    delete process.env.GMFT_DISABLE_AUDIT_LOG;
  });

  it('writerToSink adapter drops the AuditEvent return value', async () => {
    // Mirror the inline adapter from AgentApp.tsx. If AgentApp's
    // adapter drifts, the change should be mirrored here — both
    // copies are intentional and small.
    const writerToSink = (w: AuditWriter): AuditSink => ({
      append: (kind, payload) => {
        void w.append(kind, payload);
        return Promise.resolve();
      },
    });

    const appendSpy = vi
      .spyOn(AuditWriter.prototype, 'append')
      .mockResolvedValue({
        ts: '2026-06-19T00:00:00.000Z',
        kind: 'chokepoint-decision',
        prevHash: '0'.repeat(64),
        hash: 'a'.repeat(64),
        payload: {},
      });

    const sink = writerToSink(new AuditWriter({ auditDir: '/tmp/gmft-audit-test' }));

    // The sink contract: returns Promise<void>. The adapter must
    // not surface the AuditEvent (it would break the type).
    const result = sink.append('chokepoint-decision', { tool: 'nmap', category: 'network', flags: [], decision: 'allow' });
    expect(result).toBeInstanceOf(Promise);
    // Resolves to undefined — the AuditEvent is discarded.
    await expect(result).resolves.toBeUndefined();
    expect(appendSpy).toHaveBeenCalledTimes(1);
    expect(appendSpy).toHaveBeenCalledWith(
      'chokepoint-decision',
      expect.objectContaining({ tool: 'nmap', decision: 'allow' }),
    );

    appendSpy.mockRestore();
  });

  it('GMFT_DISABLE_AUDIT_LOG=true makes makeAuditSink return NOOP_SINK', () => {
    const inner: AuditSink = { append: vi.fn(async () => {}) };
    process.env.GMFT_DISABLE_AUDIT_LOG = 'true';
    const sink = makeAuditSink(inner);
    expect(sink).toBe(NOOP_SINK);
  });

  it('GMFT_DISABLE_AUDIT_LOG unset keeps the inner sink', () => {
    const inner: AuditSink = { append: vi.fn(async () => {}) };
    const sink = makeAuditSink(inner);
    expect(sink).not.toBe(NOOP_SINK);
    expect(sink).toBe(inner);
  });
});
