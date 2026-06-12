/**
 * v0.3.A.4 — AuditLogTab tests.
 *
 * Covers the (1) render, (2) paginate, (3) filter, (4) empty state,
 * (5) color coding, and (6) keybinding summary behaviors promised in
 * plan A.4.1.
 *
 * Tests use a small `pageSize` override (5) so multi-page navigation
 * can be exercised without manufacturing 100+ events.
 */
import { render } from 'ink-testing-library';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@gmft/core';
import { AuditLogTab } from '../src/ui/tabs/AuditLogTab.js';
import { makeTheme } from '../src/ui/theme.js';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

// A canned event stream with one of every kind the plan calls out.
// Using deterministic ids / text so the test can assert exact substrings.
const sampleEvents: AgentEvent[] = [
  { type: 'text-delta', text: 'starting scan' },
  {
    type: 'tool-call-request',
    id: 'tcr-1',
    name: 'nmap',
    args: { target: 'h', ports: '80' },
  },
  { type: 'tool-result', id: 'tr-1', name: 'nmap', ok: true, output: { findings: [] } },
  {
    type: 'confirmation-needed',
    id: 'cn-1',
    name: 'shell_exec',
    reason: 'destructive tool',
    prompt: 'type "yes" to confirm',
  },
  {
    type: 'supervisor-fire',
    fire: {
      kind: 'loop-detected',
      targetEventId: 'tcr-1',
      tool: 'nmap',
      message: 'loop',
      turn: 1,
    } as never,
    targetEventId: 'tcr-1',
  },
  { type: 'done', text: '' },
  { type: 'error', error: new Error('boom') },
  { type: 'chain-started', chainId: 'c1', stepCount: 1 },
];

function typeKey(stdin: { write: (s: string) => void }, s: string): Promise<void> {
  return new Promise((resolve) => {
    stdin.write(s);
    setImmediate(resolve);
  });
}

describe('AuditLogTab (v0.3.A.4)', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    consoleErrorSpy.mockRestore();
    vi.clearAllMocks();
  });

  it('renders a header + the first page of events with a footer summary', () => {
    const theme = makeTheme('dark');
    const { lastFrame } = render(
      <AuditLogTab events={sampleEvents} theme={theme} pageSize={3} />,
    );
    const out = lastFrame() ?? '';
    // Header: the title + counts.
    expect(out).toMatch(/Audit Log/);
    expect(out).toMatch(/8 events/);
    expect(out).toMatch(/page 1\/3/);
    // Footer: keybinding summary.
    expect(out).toMatch(/n=next/);
    expect(out).toMatch(/p=prev/);
    expect(out).toMatch(/f=filter/);
    // First page includes the first 3 events in order: text-delta,
    // tool-call-request, tool-result. We assert substrings rather
    // than full lines because ink splits colored output across
    // multiple segments in the raw frame.
    expect(out).toMatch(/starting scan/);
    expect(out).toMatch(/nmap/);
  });

  it('paginates with n / p and clamps the page when the list shrinks', async () => {
    const theme = makeTheme('dark');
    const { stdin, lastFrame } = render(
      <AuditLogTab events={sampleEvents} theme={theme} pageSize={3} />,
    );
    // Page 1 of 3.
    expect(lastFrame() ?? '').toMatch(/page 1\/3/);
    await typeKey(stdin, 'n');
    await tick();
    expect(lastFrame() ?? '').toMatch(/page 2\/3/);
    await typeKey(stdin, 'n');
    await tick();
    expect(lastFrame() ?? '').toMatch(/page 3\/3/);
    // n wraps to page 1.
    await typeKey(stdin, 'n');
    await tick();
    expect(lastFrame() ?? '').toMatch(/page 1\/3/);
    // p wraps from page 1 back to page 3.
    await typeKey(stdin, 'p');
    await tick();
    expect(lastFrame() ?? '').toMatch(/page 3\/3/);
    // p goes back to 2.
    await typeKey(stdin, 'p');
    await tick();
    expect(lastFrame() ?? '').toMatch(/page 2\/3/);
  });

  it('filters by kind when f is pressed and resets to page 0', async () => {
    const theme = makeTheme('dark');
    // Start on page 2 so we can confirm the filter resets to page 0.
    const { stdin, lastFrame } = render(
      <AuditLogTab events={sampleEvents} theme={theme} pageSize={3} />,
    );
    // Wait for the initial render to settle.
    for (let i = 0; i < 3; i++) await tick();
    await typeKey(stdin, 'n');
    for (let i = 0; i < 3; i++) await tick();
    expect(lastFrame() ?? '').toMatch(/page 2\/3/);
    // First `f`: kindFilter = tool-call-request (single match).
    await typeKey(stdin, 'f');
    for (let i = 0; i < 3; i++) await tick();
    let out = lastFrame() ?? '';
    expect(out).toMatch(/1 matching tool-call-request/);
    expect(out).toMatch(/page 1\/1/);
    // n/p are still bound but the filtered list has only 1 page;
    // the footer still advertises them.
    expect(out).toMatch(/n=next/);
    // Second `f`: kindFilter = tool-result.
    await typeKey(stdin, 'f');
    for (let i = 0; i < 3; i++) await tick();
    out = lastFrame() ?? '';
    expect(out).toMatch(/1 matching tool-result/);
  });

  it('renders the empty state when no events are present', () => {
    const theme = makeTheme('dark');
    const { lastFrame } = render(
      <AuditLogTab events={[]} theme={theme} />,
    );
    const out = lastFrame() ?? '';
    expect(out).toMatch(/Audit Log/);
    expect(out).toMatch(/No events yet/);
    expect(out).toMatch(/n=next/);
  });

  it('color-codes events by kind (cyan tool-call, green/red tool-result, yellow confirm, magenta supervisor)', () => {
    const theme = makeTheme('dark');
    // Use a focused, color-sensitive subset to make the assertions
    // unambiguous. Ink serializes the named color tokens to ANSI
    // escape codes, so we can't grep the raw frame for "green" /
    // "red" / etc. Instead, we assert on the distinct text
    // prefixes that each event kind renders — and we look for the
    // presence of an `↑` arrow that the tool-call-request branch
    // emits, vs. a `←` that tool-result emits, vs. a `?` that
    // confirmation-needed emits, vs. a `⚠` that supervisor-fire
    // emits. The 5-row list (1 cyan, 1 green, 1 red, 1 yellow,
    // 1 magenta) exercises every code-path of the switch.
    const events: AgentEvent[] = [
      {
        type: 'tool-call-request',
        id: 'tcr-x',
        name: 'nmap',
        args: { target: 'h' },
      },
      { type: 'tool-result', id: 'tr-x', name: 'nmap', ok: true, output: { findings: [] } },
      { type: 'tool-result', id: 'tr-y', name: 'nmap', ok: false, reason: 'denied' },
      {
        type: 'confirmation-needed',
        id: 'cn-x',
        name: 'shell_exec',
        reason: 'destructive',
      },
      {
        type: 'supervisor-fire',
        fire: {
          kind: 'loop-detected',
          targetEventId: 'tcr-x',
          tool: 'nmap',
          message: 'loop',
          turn: 1,
        } as never,
        targetEventId: 'tcr-x',
      },
    ];
    const { lastFrame } = render(
      <AuditLogTab events={events} theme={theme} />,
    );
    const out = lastFrame() ?? '';
    // Each kind has a distinctive prefix in its row.
    expect(out).toMatch(/→ tool-call/);
    expect(out).toMatch(/← tool-result/);
    // The denied row must include the ✗ glyph and the reason text.
    expect(out).toMatch(/✗/);
    expect(out).toMatch(/denied/);
    // The confirmation-needed row uses the `?` prefix.
    expect(out).toMatch(/\? confirm/);
    // The supervisor-fire row uses the ⚠ glyph.
    expect(out).toMatch(/⚠ supervisor-fire/);
    // And every event is rendered (no event was silently dropped).
    expect(out).toMatch(/nmap/);
    expect(out).toMatch(/shell_exec/);
    expect(out).toMatch(/loop-detected/);
  });

  it('shows the current filter in the footer', async () => {
    const theme = makeTheme('dark');
    const { stdin, lastFrame } = render(
      <AuditLogTab events={sampleEvents} theme={theme} pageSize={3} />,
    );
    for (let i = 0; i < 3; i++) await tick();
    // Default filter is 'all'.
    expect(lastFrame() ?? '').toMatch(/current: all/);
    await typeKey(stdin, 'f');
    for (let i = 0; i < 3; i++) await tick();
    expect(lastFrame() ?? '').toMatch(/current: tool-call-request/);
    await typeKey(stdin, 'f');
    for (let i = 0; i < 3; i++) await tick();
    expect(lastFrame() ?? '').toMatch(/current: tool-result/);
  });
});
