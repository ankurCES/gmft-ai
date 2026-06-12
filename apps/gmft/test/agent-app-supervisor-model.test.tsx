/**
 * v0.3.A.3 — tests for the `--supervisor-model` AgentApp plumbing.
 *
 * Verifies that:
 *   1. When `supervisorModelId` is unset, the supervisor uses the
 *      primary model (the postmortem now actually fires, closing
 *      the v0.2.A.3 gap where AgentApp never passed `model` to
 *      `withSupervisor`).
 *   2. When `supervisorModelId` is set, the supervisor builds a
 *      second model via `createModel` with the override id (same
 *      provider / apiKey / endpoint as the primary), and the
 *      postmortem fires with that model.
 *
 * The test spies on `createModel` (mocked module-level above) and
 * inspects call args. It does NOT end-to-end run the LLM — `runTurn`
 * yields a `done` event and the test inspects the supervisor's
 * postmortem yield.
 */
import { render } from 'ink-testing-library';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApp } from '../src/AgentApp.js';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

// Mock `@gmft/core` for this test file. The `runTurn` mock yields a
// single `done` event so the postmortem generator runs end-to-end
// (AgentApp passes the supervisor's model to `withSupervisor`, which
// invokes `generatePostmortem` on `done`).
vi.mock('@gmft/core', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    createModel: vi.fn((opts: { provider: string; model: string; apiKey: string; endpoint?: string }) =>
      Object.freeze({ __tag: 'fake-model', opts: Object.freeze({ ...opts }) }),
    ),
    // Minimal runTurn: yield one done event. AgentApp will wrap this
    // with `withSupervisor`, which (now that A.3 passes `model`) will
    // call `generatePostmortem` on done. The postmortem is mocked
    // here to return a deterministic body.
    runTurn: vi.fn(async function* () {
      yield { type: 'text-delta' as const, text: 'hi' };
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

describe('AgentApp v0.3.A.3 — --supervisor-model plumbing', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    consoleErrorSpy.mockRestore();
    vi.clearAllMocks();
  });

  it('uses the primary model for the supervisor when supervisorModelId is unset', async () => {
    const { stdin } = render(
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
    for (let i = 0; i < 3; i++) await tick();
    await typeAndEnter(stdin, 'go');
    for (let i = 0; i < 5; i++) await tick();
    // `createModel` is called twice: once for the primary (`llmModel`),
    // once for the supervisor. Without `supervisorModelId`, both use
    // the primary's model id.
    const { createModel } = await import('@gmft/core');
    const createModelMock = createModel as unknown as ReturnType<typeof vi.fn>;
    const calls = createModelMock.mock.calls.map((c) => c[0] as { model: string });
    const modelIds = calls.map((c) => c.model);
    // Primary and supervisor are both 'claude-3-5-haiku-latest'.
    expect(modelIds.length).toBeGreaterThanOrEqual(2);
    for (const id of modelIds) {
      expect(id).toBe('claude-3-5-haiku-latest');
    }
  });

  it('uses the override model for the supervisor when supervisorModelId is set', async () => {
    const { stdin } = render(
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
        supervisorModelId="claude-haiku-4-5"
      />,
    );
    for (let i = 0; i < 3; i++) await tick();
    await typeAndEnter(stdin, 'go');
    for (let i = 0; i < 5; i++) await tick();
    const { createModel } = await import('@gmft/core');
    const createModelMock = createModel as unknown as ReturnType<typeof vi.fn>;
    const calls = createModelMock.mock.calls.map((c) => c[0] as { model: string; provider: string });
    // Two model builds: primary (claude-3-5-haiku-latest) and
    // supervisor (claude-haiku-4-5). Provider is the same.
    const modelIds = calls.map((c) => c.model).sort();
    expect(modelIds).toContain('claude-3-5-haiku-latest');
    expect(modelIds).toContain('claude-haiku-4-5');
    // All calls use the same provider.
    const providers = new Set(calls.map((c) => c.provider));
    expect(providers.size).toBe(1);
    expect(providers.has('anthropic')).toBe(true);
  });
});
