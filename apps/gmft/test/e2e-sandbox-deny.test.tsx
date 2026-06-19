/**
 * v0.2.D — e2e: an elevated tool is denied by the chokepoint when no
 * sandbox is available, and the StatusRail reflects the deny state
 * with the "✗ unsandboxed" red glyph.
 *
 * Why `requiresElevation` and not `destructive`?
 *   The chokepoint aggregator fires `checkDestructive` *before*
 *   `checkRequiresSandbox`, so a destructive flag short-circuits the
 *   loop and returns `kind: 'confirm'` (the user is prompted to
 *   confirm) — even when the runner is on bare host. To exercise the
 *   sandbox-deny path we use the `requiresElevation` flag with
 *   `GMFT_ALLOW_ELEVATION=true` (env opt-in): then `checkElevation`
 *   passes, `checkDestructive` doesn't apply (no destructive flag),
 *   and `checkRequiresSandbox` denies the call with the canonical
 *   "host fallback for destructive/elevated tools" reason.
 *
 * Test setup:
 *   - `@gmft/tools` `runnerCapabilities` is mocked to return a
 *     `host` snapshot (no Docker, no landlock, no seccomp). This is
 *     the worst-case kernel/host scenario.
 *   - `process.env.GMFT_ALLOW_ELEVATION` is stubbed to `'true'` so
 *     `checkElevation` returns `null` and the loop falls through to
 *     `checkRequiresSandbox`.
 *   - `@gmft/core` `runTurn` is mocked to drive a real
 *     `chokepoint.decide()` on a `requiresElevation` call, then
 *     yield the corresponding `tool-result` event. We use the real
 *     chokepoint (built by `AgentApp` from `loadConfig()`) so the
 *     test exercises the actual rule path — the same aggregator
 *     the production loop runs.
 *   - `loadConfig` is mocked to return the default config (the
 *     real `loadConfig` may pick up a dev config on the host that
 *     would have `runnerCapabilities` set to a different mode).
 *
 * What we assert:
 *   - the chokepoint denies the elevated call with the canonical
 *     "host fallback for destructive/elevated tools" reason (the
 *     decision from `chokepoint.decide()` itself)
 *   - the StatusRail shows the "✗ unsandboxed" glyph (red) after
 *     the tool-result is processed
 *
 * Note: the deny reason is not currently surfaced in the transcript
 * (AgentApp's tool-result handler updates the rail, not the chat
 * log). When reason-surfacing is added in a later plan, a third
 * assertion can re-add the regex check.
 */

import { render } from 'ink-testing-library';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runTurn } from '@gmft/core';
import { AgentApp } from '../src/AgentApp.js';

const tick = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

vi.mock('@gmft/tools', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    // Worst-case host: nothing is available, runner resolves to bare
    // 'host'. The chokepoint's `checkRequiresSandbox` rule will deny
    // elevated tools with the canonical "host fallback" reason.
    runnerCapabilities: () => ({
      landlock: 'unavailable' as const,
      landlockAbi: null,
      seccomp: 'unavailable' as const,
      docker: 'unavailable' as const,
      resolvedAuto: 'host' as const,
    }),
  };
});

vi.mock('@gmft/core', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    loadConfig: () => ({
      chokepoint: { allowPrivateNetworks: false, denylist: [] },
    }),
    // The mocked runTurn consults the real chokepoint (passed in via
    // runTurnOpts.chokepoint by AgentApp) on an elevated tool call
    // and yields the matching tool-result event. We use the real
    // chokepoint — not a fake — so the test exercises the production
    // aggregator + the `checkRequiresSandbox` rule.
    runTurn: vi.fn(async function* (args: {
      chokepoint: {
        decide: (call: {
          tool: string;
          category: string;
          flags: readonly string[];
          args: Record<string, unknown>;
        }) => { kind: string; reason?: string };
      };
    }) {
      const decision = await args.chokepoint.decide({
        tool: 'shell_exec',
        category: 'shell',
        flags: ['requiresElevation'],
        args: { argv: ['sudo', 'apt', 'install', 'foo'] },
      });
      yield {
        type: 'tool-call-request' as const,
        id: 'tc-1',
        name: 'shell_exec',
        args: { argv: ['sudo', 'apt', 'install', 'foo'] },
        flags: ['requiresElevation'],
      };
      if (decision.kind === 'deny') {
        yield {
          type: 'tool-result' as const,
          id: 'tc-1',
          name: 'shell_exec',
          ok: false,
          reason: decision.reason ?? 'denied',
        };
      } else {
        yield {
          type: 'tool-result' as const,
          id: 'tc-1',
          name: 'shell_exec',
          ok: true,
          output: { mode: 'host', stdout: '', stderr: '', exitCode: 0 },
        };
      }
      yield { type: 'done' as const, text: '' };
    }),
  };
});

type InkHandle = ReturnType<typeof render>;

describe('AgentApp e2e: chokepoint denies elevated tools when no sandbox is available (v0.2.D)', () => {
  let getApiKey: ReturnType<typeof vi.fn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let handle: InkHandle | null = null;

  beforeEach(() => {
    // Opt in to elevation so `checkElevation` returns `null` and the
    // loop falls through to `checkRequiresSandbox`.
    vi.stubEnv('GMFT_ALLOW_ELEVATION', 'true');
    getApiKey = vi.fn(async (provider: string) => `sk-${provider}`);
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    handle?.unmount();
    handle = null;
    consoleErrorSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  async function renderAgentApp() {
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

  it('denies an elevated shell_exec with the canonical reason, and the rail shows "✗ unsandboxed"', async () => {
    const { stdin, lastFrame } = await renderAgentApp();
    await typeAndEnter(stdin, 'sudo apt install foo');

    // Wait for the runTurn → tool-call-request → chokepoint.decide
    // → tool-result pipeline to flush. The setState in the
    // tool-result handler is async, so we wait 800ms — long enough
    // for the React render to flush but short enough to keep the
    // suite fast. (The supervisor's postmortem call may still be
    // in flight at this point; we don't need it to resolve, only
    // for the tool-result to have been processed by AgentApp.)
    await new Promise<void>((r) => setTimeout(r, 800));
    const frame = lastFrame() ?? '';

    // The rail flips to the red ✗ unsandboxed state because the
    // tool-result came back with ok: false + a non-empty reason
    // (which is what AgentApp's tool-result handler keys on to
    // set the sandbox field to 'unsandboxed').
    expect(frame).toContain('✗ unsandboxed');

    // Sanity: confirm the chokepoint itself denied with the
    // canonical reason (this is what the real runTurn would have
    // surfaced; the mock applies it to the tool-result reason).
    const mocked = runTurn as unknown as { mock: { calls: unknown[][] } };
    const capturedCall = mocked.mock.calls[0]?.[0] as
      | { chokepoint: { decide: (c: { tool: string; category: string; flags: readonly string[] }) => { kind: string; reason?: string } } }
      | undefined;
    expect(capturedCall).toBeDefined();
    const decision = await capturedCall!.chokepoint.decide({
      tool: 'shell_exec',
      category: 'shell',
      flags: ['requiresElevation'],
    });
    expect(decision.kind).toBe('deny');
    expect(decision.reason).toMatch(/host fallback for destructive\/elevated tools/);
  });
});
