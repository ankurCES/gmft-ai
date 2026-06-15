/**
 * v0.3.C — Chokepoint decorator that emits a `chokepoint-decision`
 * audit event for every `decide()` call. The decorator is transparent:
 * same input → same output (after the audit append), and the inner
 * chokepoint is called once per outer call. The wrapper is the single
 * point of instrumentation for the chokepoint's decisions, which is
 * what makes the chain trustworthy.
 *
 * The audit append is fire-and-forget — the chokepoint's caller does
 * not wait for the append to fsync. Rationale: the agent loop yields
 * `tool-call-request` synchronously off the `decide()` return value;
 * blocking on the audit append would couple tool-call latency to
 * disk I/O. The hash chain doesn't need strict serialization with the
 * tool's execution — it needs the events to land in order, and the
 * writer's mutex (Task 2) guarantees that.
 *
 * Wiring: `createChokepoint(env)` in `chokepoint/index.ts` already
 * returns a `Chokepoint`. To enable audit, callers wrap it:
 *
 *   const chokepoint = withAuditChokepoint(createChokepoint(env), sink);
 *
 * The wrapper is purely additive — existing tests that construct a
 * `Chokepoint` directly (no wrapper) continue to work without audit.
 *
 * Test count: 1 test in `test/audit-sink.test.ts` covers the
 * decorator's append-on-every-call behavior. The env-var opt-out is
 * covered in the same file (1 more test). Total: 2 tests for the
 * wiring slice (matches the plan's C.1.4 budget).
 */

import type { Chokepoint, ChokepointCall, Decision } from '../chokepoint/decision.js';
import type { AuditSink } from './sink.js';

export function withAuditChokepoint(inner: Chokepoint, sink: AuditSink): Chokepoint {
  return {
    decide(call: ChokepointCall): Decision {
      const decision = inner.decide(call);
      // Fire-and-forget. The promise is intentionally not awaited —
      // see the file header. We attach a no-op catch so an unhandled
      // rejection doesn't crash the process if the sink throws.
      void sink.append('chokepoint-decision', {
        tool: call.tool,
        category: call.category,
        flags: [...call.flags],
        decision: decision.kind,
        reason: 'reason' in decision ? decision.reason : undefined,
      }).catch(() => {
        // Audit failures must not break the chokepoint. The writer
        // logs to stderr in production; tests assert on `append`
        // calls via the stub.
      });
      return decision;
    },
  };
}
