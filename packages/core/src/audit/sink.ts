/**
 * v0.3.C — Audit sink interface + opt-out guard.
 *
 * The audit writer (`./writer.ts`) is the production implementation of
 * {@link AuditSink}. Tests and the opt-out path use the no-op
 * implementation. Keeping the sink an interface (not a concrete class)
 * means the agent loop, the chokepoint wrapper, and the session
 * orchestrator all depend on a 1-method interface, not on the writer's
 * filesystem + key-management concerns.
 *
 * Why an interface and not a callback? The writer is async (fsync is
 * a syscall), and the call sites are many. A typed 1-method interface
 * keeps the test stubs trivial (`const stub: AuditSink = { append: vi.fn() }`)
 * and the production wiring a single line at composition time.
 *
 * Opt-out: `process.env.GMFT_DISABLE_AUDIT_LOG === 'true'` causes every
 * `append` call to be a no-op (no file write, no hash computation).
 * This is the v0.3.C plan's Open Question #4 resolution: opt-out,
 * matching the `findings/` precedent.
 *
 * Test count: 0 dedicated tests in this file; the no-op and env-var
 * opt-out are covered by `test/audit-sink.test.ts` (2 tests total
 * for the slice, of which 1 is the env-var opt-out and 1 is the
 * no-op semantics).
 */

import type { AuditEventKind } from './types.js';

export interface AuditSink {
  append(kind: AuditEventKind, payload: Record<string, unknown>): Promise<void>;
}

/** A sink that drops every event. Used when audit is disabled. */
export const NOOP_SINK: AuditSink = {
  async append() {
    // intentionally empty
  },
};

/**
 * Returns a sink that respects `GMFT_DISABLE_AUDIT_LOG=true`. The
 * check is performed once at construction time — flipping the env
 * var mid-process does not change a sink that's already been
 * returned. That's the right call: a long-running process (the
 * TUI) starts the sink once and reuses it; an attacker who could
 * flip the env var mid-run would have root anyway.
 */
export function makeAuditSink(
  inner: AuditSink,
  env: NodeJS.ProcessEnv = process.env,
): AuditSink {
  if (env.GMFT_DISABLE_AUDIT_LOG === 'true') {
    return NOOP_SINK;
  }
  return inner;
}
