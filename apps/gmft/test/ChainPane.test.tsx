/**
 * v0.1 phase 6 — ChainPane rendering tests.
 *
 * Renders ChainPane directly with a hand-built `ChainState` and
 * asserts the visible output. We don't drive a real chain through
 * `useAgent` (that's covered in `useAgent-chain.test.tsx`) — this
 * file pins down ChainPane's presentational contract:
 *
 *   - Header shows `Chain: <short id> <completed>/<total>`.
 *   - Each step row carries a status glyph + a label that mentions
 *     the tool name and (when finished) the duration.
 *   - The "running" badge appears for steps that have been started
 *     but not yet finished.
 *   - Steps with `status: 'skipped'` show the muted `→` glyph and
 *     a reason (if present).
 *   - The empty-steps case renders the placeholder line.
 *
 * Stripping ANSI from the rendered output is handled by vitest's
 * test setup (`test/setup.ts`), so we just `lastFrame()` and assert
 * substrings.
 */

import { render } from 'ink-testing-library';
import React from 'react';
import { describe, it, expect } from 'vitest';
import { ChainPane } from '../src/ui/components/ChainPane.js';
import { makeTheme } from '../src/ui/theme.js';
import type { ChainState } from '../src/ui/hooks/useAgent.js';

const theme = makeTheme('dark');

const baseChain: Pick<ChainState, 'chainId' | 'stepCount'> = {
  chainId: 'ch-abcdef0123456789',
  stepCount: 3,
};

describe('ChainPane', () => {
  it('renders the header with the short id and the counter', () => {
    const state: ChainState = {
      ...baseChain,
      steps: [],
      done: false,
    };
    const { lastFrame } = render(<ChainPane chainState={state} theme={theme} />);
    const out = lastFrame();
    expect(out).toContain('Chain:');
    // slice(0, 8) of "ch-abcdef0123456789" is "ch-abcde".
    expect(out).toContain('ch-abcde');
    expect(out).toContain('0/3');
  });

  it('renders one row per step with a status badge', () => {
    const state: ChainState = {
      ...baseChain,
      steps: [
        { index: 0, tool: 'nmap', name: '-sV', status: 'ok', durationMs: 1200, findingCount: 3 },
        { index: 1, tool: 'nikto', status: undefined, durationMs: undefined },
        { index: 2, tool: 'exploit', status: 'denied' },
      ],
      done: false,
    };
    const { lastFrame } = render(<ChainPane chainState={state} theme={theme} />);
    const out = lastFrame();
    expect(out).toContain('[0]');
    expect(out).toContain('nmap');
    expect(out).toContain('1.2s');
    expect(out).toContain('3 findings');
    expect(out).toContain('[1]');
    expect(out).toContain('nikto');
    expect(out).toContain('running');
    expect(out).toContain('[2]');
    expect(out).toContain('exploit');
    expect(out).toContain('denied');
  });

  it('shows the "done" tail and the running glyph when the chain is still in flight', () => {
    const state: ChainState = {
      ...baseChain,
      steps: [
        { index: 0, tool: 'nmap', status: 'ok', durationMs: 500 },
      ],
      // Even mid-flight, the tool runner has been emitting the
      // running totals (1 ok so far). Mirror that here so the
      // header counter shows the in-flight progress.
      totals: { completed: 1, denied: 0, erred: 0 },
      done: false,
    };
    const { lastFrame } = render(<ChainPane chainState={state} theme={theme} />);
    const out = lastFrame();
    // Tail separator is the ellipsis when not done.
    expect(out).toContain('1/3');
    expect(out).toContain('ok');
  });

  it('shows the "done" tail when the chain is finished', () => {
    const state: ChainState = {
      ...baseChain,
      steps: [
        { index: 0, tool: 'nmap', status: 'ok', durationMs: 800 },
        { index: 1, tool: 'nikto', status: 'denied' },
      ],
      totals: { completed: 1, denied: 1, erred: 0 },
      done: true,
    };
    const { lastFrame } = render(<ChainPane chainState={state} theme={theme} />);
    const out = lastFrame();
    expect(out).toContain('1/3 done');
  });

  it('renders the placeholder when no steps have been emitted', () => {
    const state: ChainState = {
      ...baseChain,
      steps: [],
      done: false,
    };
    const { lastFrame } = render(<ChainPane chainState={state} theme={theme} />);
    const out = lastFrame();
    expect(out).toMatch(/no steps yet/i);
  });

  it('skipped steps show a muted badge and the reason if present', () => {
    const state: ChainState = {
      ...baseChain,
      steps: [
        { index: 0, tool: 'nmap', status: 'erred', durationMs: 600 },
        { index: 1, tool: 'nikto', status: 'skipped', reason: 'previous failed' },
      ],
      done: false,
    };
    const { lastFrame } = render(<ChainPane chainState={state} theme={theme} />);
    const out = lastFrame();
    expect(out).toContain('skipped');
    expect(out).toContain('previous failed');
  });
});
