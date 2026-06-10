/**
 * AgentApp live model-switch e2e.
 *
 * Phase 1.5f wires `/model` and `/provider` to actually rebuild the
 * LanguageModel the next LLM turn runs against — not just update the
 * status rail string (that was 1.5e). This test mocks `createModel`
 * + `runTurn` from `@gmft/core` so we can observe the model identity
 * on every turn.
 *
 * The mock strategy:
 *   - `createModel` is replaced with an identity function that tags
 *     the opts onto a frozen sentinel object. The test inspects the
 *     sentinel to assert which (provider, model, apiKey) was used.
 *   - `runTurn` is replaced with a tiny async generator that yields
 *     one text-delta and then a done event. It records the model
 *     it was called with so the test can correlate the switch to
 *     the next turn.
 *
 * The end-to-end story we cover:
 *   1. Boot: anthropic / claude-3-5-haiku-latest / boot-key. First
 *      turn uses the boot model.
 *   2. /provider openai — AgentApp resolves a fresh key, picks the
 *      default model (gpt-4o-mini), rebuilds. Second turn uses
 *      openai / gpt-4o-mini / new-key.
 *   3. /model gpt-4o — model-only switch keeps the openai key.
 *      Third turn uses openai / gpt-4o / new-key.
 *   4. /provider unknown — AgentApp refuses to switch (logs + noop),
 *      fourth turn still uses openai / gpt-4o.
 */
import { render } from 'ink-testing-library';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApp } from '../src/AgentApp.js';
import type { Message as Msg } from '../src/ui/components/Message.js';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

// We capture every (model, history[0].content) pair that runTurn
// receives. Cleared at the start of each test.
const turnCalls: Array<{ provider: string; model: string; apiKey: string; prompt: string }> = [];

// Tag the LanguageModel so we can read the opts back out.
function tagModel(opts: { provider: string; model: string; apiKey: string; endpoint?: string }) {
  return Object.freeze({ __tag: 'fake-model', opts: Object.freeze({ ...opts }) });
}

vi.mock('@gmft/core', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    // The factory is the seam. We don't need a real LanguageModel —
    // a tagged sentinel is enough to assert the rebuild path.
    createModel: vi.fn((opts: { provider: string; model: string; apiKey: string; endpoint?: string }) =>
      tagModel(opts),
    ),
    // runTurn streams back a single token then closes. We record the
    // model it received so the test can assert which one was used.
    runTurn: vi.fn(async function* (args: {
      model: { opts: { provider: string; model: string; apiKey: string } };
      history: ReadonlyArray<{ role: string; content: string }>;
    }) {
      const m = args.model.opts;
      const lastUser = [...args.history].reverse().find((m2) => m2.role === 'user');
      turnCalls.push({
        provider: m.provider,
        model: m.model,
        apiKey: m.apiKey,
        prompt: lastUser?.content ?? '',
      });
      yield { type: 'text-delta' as const, text: `reply-for:${lastUser?.content ?? ''}` };
      yield { type: 'done' as const, text: '' };
    }),
  };
});

type InkHandle = ReturnType<typeof render>;

describe('AgentApp live model switch (1.5f)', () => {
  let getApiKey: ReturnType<typeof vi.fn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let handle: InkHandle | null = null;

  beforeEach(() => {
    turnCalls.length = 0;
    // A stub getApiKey that pretends to read from the secret store.
    // Returns a different key per provider so the test can confirm
    // the rebuild path actually re-resolved the key, not just the
    // model id.
    getApiKey = vi.fn(async (provider: string) => `sk-${provider}`);
    // Silence the "ignoring unknown provider" error so it doesn't
    // pollute test output. We still assert the no-op behavior
    // structurally (turnCalls).
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    handle?.unmount();
    handle = null;
    consoleErrorSpy.mockRestore();
  });

  /**
   * Wait until runTurn has been called N times, polling up to 1s.
   * The React state updates + the useEffect that resolves the new
   * api key are both async; this avoids flake.
   */
  async function waitForTurns(n: number): Promise<void> {
    for (let i = 0; i < 50; i++) {
      if (turnCalls.length >= n) return;
      // eslint-disable-next-line no-await-in-loop
      await new Promise<void>((r) => setTimeout(r, 20));
    }
    throw new Error(`Timed out waiting for ${n} turns; got ${turnCalls.length}`);
  }

  function renderAgentApp() {
    handle = render(
      React.createElement(AgentApp, {
        themeName: 'auto',
        initialStatus: { provider: 'anthropic', model: 'claude-3-5-haiku-latest' },
        model: {
          provider: 'anthropic',
          model: 'claude-3-5-haiku-latest',
          apiKey: 'sk-boot',
        },
        getApiKey,
        env: {
          hostname: 'test-host',
          os: 'linux',
          sandboxMode: 'host' as const,
          provider: 'anthropic',
          model: 'claude-3-5-haiku-latest',
          username: 'tester',
        },
      }),
    );
    // Give Ink time to mount the tree and register the InputBox's
    // useInput handler before we drive stdin. setImmediate (the
    // app-e2e.test.tsx pattern) isn't enough across all tests in a
    // batch — microtask-ordering can race the first keystroke on
    // tests after the first. Three ticks of setImmediate is the
    // sweet spot we empirically hit.
    return new Promise<InkHandle>((resolve) => {
      setImmediate(() => setImmediate(() => setImmediate(() => resolve(handle!))));
    });
  }

  async function typeAndEnter(stdin: { write: (s: string) => void }, text: string) {
    stdin.write(text);
    await tick();
    stdin.write('\r');
    await tick();
  }

  it('first turn uses the boot model', async () => {
    const { stdin, lastFrame } = await renderAgentApp();
    await typeAndEnter(stdin, 'hello');
    // runTurn is async — poll.
    await waitForTurns(1);
    expect(turnCalls).toHaveLength(1);
    expect(turnCalls[0]).toEqual({
      provider: 'anthropic',
      model: 'claude-3-5-haiku-latest',
      apiKey: 'sk-boot',
      prompt: 'hello',
    });
    // Sanity: the assistant reply made it into the chat.
    expect(lastFrame() ?? '').toContain('reply-for:hello');
  });

  it('/provider <id> rebuilds the model with a fresh key + default model', async () => {
    const { stdin } = await renderAgentApp();
    await tick();
    await tick();
    await typeAndEnter(stdin, 'hi');
    await waitForTurns(1);
    expect(turnCalls.length, 'first turn').toBe(1);

    await typeAndEnter(stdin, '/provider openai');
    // The slash command itself produces a chat message (no LLM turn).
    // The key resolve happens in a useEffect — wait a few ticks for
    // the state to flush and getApiKey to be called.
    await tick();
    await tick();
    await tick();

    await typeAndEnter(stdin, 'second');
    await waitForTurns(2);

    expect(turnCalls.length, 'two turns total').toBe(2);
    expect(turnCalls[1]).toEqual({
      provider: 'openai',
      model: 'gpt-4o-mini', // default for openai
      apiKey: 'sk-openai', // freshly resolved
      prompt: 'second',
    });
    // getApiKey was called for the new provider
    expect(getApiKey).toHaveBeenCalledWith('openai');
  });

  it('/model <id> keeps the provider and its key', async () => {
    const { stdin } = await renderAgentApp();
    await typeAndEnter(stdin, 'a');
    await waitForTurns(1);
    await typeAndEnter(stdin, '/provider openai');
    await tick();
    await tick();
    await typeAndEnter(stdin, 'b');
    await waitForTurns(2);

    await typeAndEnter(stdin, '/model gpt-4o');
    await tick();
    await typeAndEnter(stdin, 'c');
    await waitForTurns(3);

    expect(turnCalls).toHaveLength(3);
    expect(turnCalls[2]).toEqual({
      provider: 'openai',
      model: 'gpt-4o',
      apiKey: 'sk-openai',
      prompt: 'c',
    });
    // Model-only switch should NOT trigger another key resolve
    // (the effect short-circuits when provider doesn't change).
    // We only know getApiKey('openai') was called during /provider;
    // a second call would be over-counted. Assert it was called
    // exactly once with 'openai'.
    const openaiCalls = getApiKey.mock.calls.filter((c) => c[0] === 'openai');
    expect(openaiCalls).toHaveLength(1);
  });

  it('unknown /provider is ignored — model stays put', async () => {
    const { stdin } = await renderAgentApp();
    await typeAndEnter(stdin, 'a');
    await waitForTurns(1);
    await typeAndEnter(stdin, '/provider bogus');
    await tick();
    await typeAndEnter(stdin, 'b');
    await waitForTurns(2);

    // Second turn should still be the boot model.
    expect(turnCalls[1]).toEqual({
      provider: 'anthropic',
      model: 'claude-3-5-haiku-latest',
      apiKey: 'sk-boot',
      prompt: 'b',
    });
  });
});
