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
import type { AgentEvent } from '../agent/loop.js';
import type { SupervisorFire } from '../agent/supervisor-types.js';

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

/**
 * v0.4-A.3 — Supervisor decorator that emits a `supervisor-fire` audit
 * event for every `supervisor-fire` AgentEvent yielded by the inner
 * `AsyncIterable<AgentEvent>` (the output of `withSupervisor(...)`).
 *
 * Mirror of `withAuditChokepoint`, but at the iterable layer rather than
 * the chokepoint-object layer. The supervisor wrapper is a transform
 * over `runTurn`'s output, so the natural instrumentation point is to
 * wrap the resulting iterable and watch each yielded event for
 * `type === 'supervisor-fire'`.
 *
 * Decorator contract:
 *  - Returns a NEW AsyncIterable that yields the same events as `inner`
 *    in the same order, unmodified.
 *  - For every `supervisor-fire` event yielded, calls
 *    `sink.append('supervisor-fire', payload)` fire-and-forget
 *    (NOT awaited — same rationale as `withAuditChokepoint`: the agent
 *    loop is synchronous over `runTurn`, and coupling supervisor-fire
 *    audit latency to tool-call latency would degrade UX).
 *  - Audit failures are swallowed (the writer logs to stderr in
 *    production; tests assert on `append` calls via the stub).
 *
 * Payload shape (Record<string, unknown>):
 *  - `kind`:          the SupervisorFire.kind (e.g. 'loop-detected')
 *  - `advice`:        the advice injected into the LLM's history
 *                     (common to ALL SupervisorFire variants)
 *  - `targetEventId`: the AgentEvent.id this fire responded to
 *                     (common to ALL SupervisorFire variants)
 *  - kind-specific fields are spread at the top level so they're
 *    discoverable in the audit log. Concretely:
 *      - PlanIssueFire:    adds `severity` ('info' | 'warn') and `text`
 *      - LoopDetectedFire: adds `tool`, `count`, `recent`
 *      - RiskEscalationFire: adds `tool`, `firstToolOfTurn: true`
 *      - OverclaimFire:    adds `quote`, `evidence`
 *    Consumers of the audit log should narrow on `kind` to know which
 *    additional fields are present.
 *
 * Wiring (downstream AgentApp):
 *  - The chain becomes `chokepoint → withAuditChokepoint →
 *    withSupervisor → withAuditSupervisor`. `withSupervisor` must run
 *    first because `withAuditSupervisor` reads its output events.
 *
 * Test count: 3 tests in `test/audit-supervisor.test.ts`:
 *  1. emits one supervisor-fire event per yielded fire
 *  2. payload contains the fire's common + kind-specific fields
 *  3. non-supervisor events pass through unchanged and do NOT trigger
 *     audit appends (tool-call-request, text-delta, done, error, etc.)
 */
export function withAuditSupervisor(
  inner: AsyncIterable<AgentEvent>,
  sink: AuditSink,
): AsyncIterable<AgentEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      for await (const event of inner) {
        if (event.type === 'supervisor-fire') {
          // Build the audit payload. Spread the fire first so its
          // kind-specific fields land at the top level (PlanIssueFire
          // brings `severity` + `text`; LoopDetectedFire brings
          // `tool` + `count` + `recent`; RiskEscalationFire brings
          // `tool` + `firstToolOfTurn`; OverclaimFire brings `quote` +
          // `evidence`). Then explicitly set the truly common fields
          // (`kind`, `advice`, `targetEventId`) so they're present
          // regardless of which variant was emitted — this matters for
          // audit log consumers that filter on the common fields
          // without narrowing on `kind` first.
          const fire: SupervisorFire = event.fire;
          const payload: Record<string, unknown> = {
            ...fire,
            kind: fire.kind,
            advice: fire.advice,
            targetEventId: fire.targetEventId,
          };
          // Fire-and-forget. Same rationale as `withAuditChokepoint`:
          // agent loop is synchronous over runTurn, audit latency must
          // not couple to tool-call latency. The hash chain doesn't
          // need strict serialization with the supervisor's yield —
          // it needs the events to land in order, and the writer's
          // mutex guarantees that.
          void sink.append('supervisor-fire', payload).catch(() => {
            // See withAuditChokepoint: audit failures must not break
            // the agent loop. The writer logs to stderr; tests assert
            // on `append` calls via the stub.
          });
        }
        // Always yield the original event unchanged.
        yield event;
      }
    },
  };
}
