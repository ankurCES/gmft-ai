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
import { auditLogRedactedFields } from '../transcript/redact-ad.js';

export function withAuditChokepoint(inner: Chokepoint, sink: AuditSink): Chokepoint {
  return {
    async decide(call: ChokepointCall): Promise<Decision> {
      // v0.4-B — `chokepoint.decide()` is now async (the DC check
      // may shell out to `realm list`). Await it before reading
      // `.kind`/`.reason` for the audit payload.
      const decision = await inner.decide(call);
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

/**
 * v0.4-B.5 — Tool-result decorator that emits a `tool-result` audit
 * event for every `tool-result` AgentEvent yielded by the inner
 * `AsyncIterable<AgentEvent>`. Mirrors {@link withAuditSupervisor}
 * and {@link withAuditChokepoint} so the audit-chain wiring has a
 * consistent shape: each observer wraps the inner iterable (or
 * function), fires `sink.append(kind, payload)` for matching events
 * fire-and-forget, and yields the original event unchanged.
 *
 * Why this is its own wrapper, not a clause inside `withAuditSupervisor`:
 * the supervisor wrapper exists to record the supervisor's *decisions*
 * (which rule fired, what advice was injected). The tool-result wrapper
 * exists to record the *result* of running a tool — distinct datum,
 * distinct payload shape. Combining them would tangle the payload
 * contracts and require every test to set up both supervisors even
 * when only one is under test.
 *
 * Payload shape (`Record<string, unknown>`):
 *  - `name`             — the tool name (e.g. `impacket_secretsdump`)
 *  - `ok`               — `true` if the tool returned successfully,
 *                         `false` if it was denied or threw
 *  - `reason`           — present on the `ok: false` path; the
 *                         chokepoint's deny reason, the runner's
 *                         exception message, or `user denied
 *                         confirmation`
 *  - `output_redacted`  — stringified + AD-redacted form of the
 *                         tool's output (or `''` for the deny path
 *                         where `output` is `undefined`). Truncated
 *                         to `MAX_TOOL_RESULT_OUTPUT_CHARS` (default
 *                         16 384) so a runaway tool doesn't fill the
 *                         audit log. The truncation is UTF-16-safe
 *                         (cuts at a code-unit boundary so a
 *                         surrogate pair isn't split).
 *  - `redacted_fields`  — `AdRedactedField[]` of field-kind tags that
 *                         were scrubbed by `redactAdSecrets` (e.g.
 *                         `['ntlm-hash', 'lsass-nthash']`). Empty
 *                         for non-AD tool outputs. This is the
 *                         field the ADR-0018 §D.5 contract promises
 *                         to populate in the audit chain.
 *
 * Truncation policy: the audit payload is in the chain's HMAC-free
 * part (the chain covers metadata only per `audit/types.ts` header).
 * Still, an unbounded payload is a disk-space bug waiting to happen
 * — a tool that returns a 50 MB secretsdump transcript shouldn't
 * write 50 MB into every audit chain reader's UI. We cap at 16 KB,
 * which fits ~50 lines of secretsdump output (the operator can
 * still tell what ran) without filling the chain. The truncation
 * is a no-op for the common case (< 16 KB output) so the audit
 * reader gets the full picture for small results.
 *
 * Decorator contract (mirrors `withAuditSupervisor`):
 *  - Returns a NEW AsyncIterable that yields the same events as
 *    `inner` in the same order, unmodified.
 *  - For every `tool-result` event yielded, calls
 *    `sink.append('tool-result', payload)` fire-and-forget.
 *  - Non-`tool-result` events pass through unchanged and do NOT
 *    trigger audit appends.
 *  - Audit failures are swallowed (writer logs to stderr in
 *    production; tests assert on `append` calls via the stub).
 *
 * Wiring (downstream AgentApp):
 *  - The chain becomes `chokepoint → withAuditChokepoint →
 *    withSupervisor → withAuditSupervisor → withAuditToolResult`.
 *    `withAuditToolResult` runs LAST because it reads the
 *    supervisor-wrapper's output events (which already include
 *    any supervisor-fired events alongside the raw tool-result
 *    events).
 *
 * Test count: 4 tests in `test/audit-tool-result.test.ts`:
 *  1. emits one tool-result event per yielded tool-result
 *  2. payload contains redacted_fields when AD hashes are present
 *  3. non-tool-result events pass through unchanged and do NOT
 *     trigger audit appends
 *  4. truncation kicks in for outputs > 16 KB
 */
export const MAX_TOOL_RESULT_OUTPUT_CHARS = 16 * 1024;

/**
 * Cut a UTF-16 string at a code-unit boundary so the result is
 * always a valid JSON string. Used by `withAuditToolResult` before
 * truncating the redacted output. A naive `s.slice(0, n)` would
 * split a surrogate pair and produce invalid JSON downstream;
 * this walks back from the cut point until it finds a code unit
 * that isn't a low surrogate (the second half of a pair).
 */
function truncateUtf8(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  // `String.prototype.length` counts UTF-16 code units. For BMP
  // characters (the common case for ASCII secretsdump output) one
  // code unit = one char. For surrogate pairs (rare in tool
  // output but possible — emoji in user content, CJK in report
  // text) we cut at the high surrogate so the low surrogate
  // doesn't end up at index 0 of the truncated string.
  let cut = maxChars;
  if (cut > 0) {
    const prev = s.charCodeAt(cut - 1);
    if (prev >= 0xd800 && prev <= 0xdbff) {
      cut = cut - 1;
    }
  }
  return s.slice(0, cut);
}

export function withAuditToolResult(
  inner: AsyncIterable<AgentEvent>,
  sink: AuditSink,
): AsyncIterable<AgentEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      for await (const event of inner) {
        if (event.type === 'tool-result') {
          // Build the audit payload. The tool's `output` is `unknown`;
          // `auditLogRedactedFields` stringifies + redacts and returns
          // both the redacted string and the list of field-kinds that
          // were scrubbed.
          const { redactedOutput, redactedFields } = auditLogRedactedFields(event.output);
          // Truncate the redacted output to keep the audit chain
          // bounded. The truncation is a no-op for the common case
          // (< 16 KB); for runaway outputs (e.g. a 50 MB secretsdump
          // transcript) we cut to 16 KB at a code-unit boundary.
          const truncated = truncateUtf8(redactedOutput, MAX_TOOL_RESULT_OUTPUT_CHARS);
          const payload: Record<string, unknown> = {
            name: event.name,
            ok: event.ok,
            redacted_fields: redactedFields,
            output_redacted: truncated,
          };
          if (event.reason !== undefined) {
            payload.reason = event.reason;
          }
          // Fire-and-forget. Same rationale as `withAuditSupervisor`:
          // agent loop is synchronous over runTurn, audit latency
          // must not couple to tool-call latency. The hash chain
          // doesn't need strict serialization with the tool-result
          // yield — it needs the events to land in order, and the
          // writer's mutex guarantees that.
          void sink.append('tool-result', payload).catch(() => {
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
