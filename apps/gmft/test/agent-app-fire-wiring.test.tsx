/**
 * v0.3.A.2 — AgentApp end-to-end test for the per-turn event-id
 * capture and supervisor-fire → marker wiring.
 *
 * Plan verification:
 *   1. The agent loop's for-await in AgentApp captures the runtime
 *      `event.id` of every tool-call-request, tool-result, and
 *      confirmation-needed.
 *   2. The captured ids are attached to the assistant message that
 *      the loop returns (`Msg.eventIds`).
 *   3. A `supervisor-fire` event also gets its `targetEventId`
 *      pushed into the per-turn collector AND the session-wide
 *      `supervisorFires` accumulator.
 *   4. ChatTab receives `supervisorFires` + `messages` (the latter
 *      owned by App) and renders a `SupervisorFireMarker` next to
 *      the message whose `eventIds` contains the fire's
 *      `targetEventId`.
 *
 * This file covers the (1) → (3) leg by mocking `runTurn` to yield
 * a `tool-call-request` followed by a `tool-result` followed by
 * `done`, and asserting that the `lastFrame()` shows the marker
 * (which only renders when the `eventIds` + `supervisorFires` reach
 * ChatTab with the right ids).
 *
 * The (4) leg is covered by `chat-tab-fire-marker.test.tsx`.
 */

import { render } from 'ink-testing-library';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApp } from '../src/AgentApp.js';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

// v0.3.A.2 — distinct runTurn mocks per test would be nicer, but
// the existing pattern in `agent-app.test.tsx` is module-level. We
// follow that pattern to keep the test files consistent. The mock
// for the v0.3.A.2 test simulates a tool call that triggers a
// supervisor-fire (via `withSupervisor`'s Rule A loop detector) and
// yields the events the real loop would yield.
vi.mock('@gmft/core', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    createModel: vi.fn((opts: { provider: string; model: string; apiKey: string; endpoint?: string }) =>
      Object.freeze({ __tag: 'fake-model', opts: Object.freeze({ ...opts }) }),
    ),
    // Yield 4 nmap calls with the same args — that's enough to
    // trip `withSupervisor`'s Rule A (loop-detected, threshold=4
    // per `RULE_A_THRESHOLD` in supervisor-rules.ts). Each pair
    // shares an id so the per-turn collector deduplicates, and the
    // 4th call's id is the fire's `targetEventId`.
    runTurn: vi.fn(async function* () {
      yield { type: 'text-delta' as const, text: 'starting' };
      for (let i = 0; i < 4; i++) {
        yield {
          type: 'tool-call-request' as const,
          id: `evt-${i}`,
          name: 'nmap',
          args: { target: 'h' },
        };
        yield {
          type: 'tool-result' as const,
          id: `evt-${i}`,
          ok: true,
          output: { findings: [] },
        };
      }
      yield { type: 'done' as const, text: '' };
    }),
  };
});

function typeAndEnter(stdin: { write: (s: string) => void }, s: string): Promise<void> {
  return new Promise((resolve) => {
    stdin.write(s);
    setImmediate(() => {
      stdin.write('\r');
      setImmediate(resolve);
    });
  });
}

describe('AgentApp v0.3.A.2 — event-id capture + fire marker wiring', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    consoleErrorSpy.mockRestore();
    vi.clearAllMocks();
  });

  it('attaches captured event ids to the assistant message and renders a fire marker when the supervisor fires', async () => {
    const { stdin, lastFrame } = render(
      <AgentApp
        initialConfig={{ provider: 'anthropic', model: 'claude-3-5-haiku-latest' }}
        initialStatus={{ provider: 'anthropic', model: 'claude-3-5-haiku-latest' }}
        model={{
          provider: 'anthropic',
          model: 'claude-3-5-haiku-latest',
          apiKey: 'sk-test',
        }}
        getApiKey={async () => 'sk-test'}
        env={{
          hostname: 'test-host',
          os: 'linux',
          sandboxMode: 'host' as const,
          provider: 'anthropic',
          model: 'claude-3-5-haiku-latest',
          username: 'tester',
        }}
      />,
    );
    // Give Ink time to mount and register the InputBox handler.
    for (let i = 0; i < 3; i++) await tick();
    await typeAndEnter(stdin, 'go');
    // Poll for the assistant message to land.
    let frame = '';
    for (let i = 0; i < 40; i++) {
      await tick();
      frame = lastFrame() ?? '';
      if (frame.includes('starting')) break;
    }
    // The marker should be present in the transcript. The exact
    // rule letter depends on `withSupervisor`'s Rule A threshold
    // for the mock event sequence. We assert the marker symbol
    // + a "rule " prefix instead of a specific letter so the test
    // is robust to threshold changes in the supervisor config.
    expect(frame).toMatch(/⚠/);
    expect(frame).toMatch(/rule /i);
  });
});
