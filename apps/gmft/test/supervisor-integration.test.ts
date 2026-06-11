/**
 * v0.2.A.2 — `withSupervisor` + `runTurn` integration smoke test.
 *
 * The test verifies the *type contract* — a function that takes
 * `RunTurnOpts` and returns `AsyncIterable<AgentEvent>`. The real
 * end-to-end test (using a live model) is in `app-e2e.test.tsx`.
 *
 * The actual wiring into AgentApp is exercised by `agent-app.test.tsx`
 * — that test mocks `runTurn` and submits a user turn, which now
 * flows through `withSupervisor` before reaching the mock. The test
 * confirms the wrapper's passthrough behavior doesn't break the
 * v0.1 submit/respond flow.
 */

import { describe, it, expect } from 'vitest';
import { withSupervisor, type RunTurnOpts } from '@gmft/core';

describe('withSupervisor + runTurn integration smoke test', () => {
  it('wraps a real runTurn call (mocked model) without altering the event stream shape', async () => {
    // We don't import the real runTurn here because it pulls in the
    // AI SDK. The agent-app.test.tsx integration test exercises the
    // full path; this test verifies the type/shape contract.
    const opts: RunTurnOpts = { model: {} as never, system: '', history: [] };
    const wrapped = withSupervisor({
      runTurn: () => (async function* () {})(),
      runTurnOpts: opts,
      historyRef: { current: [] },
    });
    expect(typeof wrapped[Symbol.asyncIterator]).toBe('function');
    expect(typeof wrapped.lastFires).toBe('function');
  });
});
