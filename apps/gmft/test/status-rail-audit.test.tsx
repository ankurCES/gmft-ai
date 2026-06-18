/**
 * v0.3.C follow-up — StatusRail audit breadcrumb JSX test.
 *
 * The pure `renderAuditField` helper is tested in status-rail.test.ts.
 * This file covers the JSX integration: does the StatusRail render
 * the breadcrumb on the second line when `status.auditChain` is
 * set, and does it skip the field when the chain is absent?
 *
 * Mirrors the v0.2.D pattern in status-rail-sandbox.test.tsx —
 * the JSX wrapper's color is asserted by inspecting the rendered
 * frame for the label substring (ink strips color attrs in plain
 * text output, so we don't assert color, only presence).
 */
import { describe, it, expect } from 'vitest';
import type { ReactElement } from 'react';
import React from 'react';
import { render } from 'ink-testing-library';
import { StatusRail, type StatusInfo } from '../src/ui/components/StatusRail.js';
import { makeTheme } from '../src/ui/theme.js';

const theme = makeTheme('dark');

function baseStatus(overrides: Partial<StatusInfo> = {}): StatusInfo {
  return {
    model: 'gpt-test',
    provider: 'openai',
    sandbox: 'unknown',
    tokensIn: 0,
    tokensOut: 0,
    toolCalls: 0,
    findings: 0,
    findingsBySeverity: { info: 0, low: 0, medium: 0, high: 0, critical: 0 },
    supervisor: 'quiet',
    fireCount: 0,
    ...overrides,
  };
}

const tick = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

async function renderRail(status: StatusInfo) {
  const result = render(
    React.createElement(StatusRail, { status, theme }) as ReactElement,
  );
  await tick();
  return result;
}

describe('StatusRail audit breadcrumb JSX (v0.3.C)', () => {
  it('renders "#N ✓" when the chain head is well-formed', async () => {
    const { lastFrame } = await renderRail(
      baseStatus({ auditChain: { count: 1247, broken: false } }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('audit');
    expect(frame).toContain('#1247');
    expect(frame).toContain('✓');
  });

  it('renders "#N ✗ broken" when the chain tail is corrupt', async () => {
    const { lastFrame } = await renderRail(
      baseStatus({ auditChain: { count: 846, broken: true } }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('audit');
    expect(frame).toContain('#846');
    expect(frame).toContain('✗ broken');
  });

  it('omits the audit field entirely when auditChain is undefined', async () => {
    // No `auditChain` key — the AgentApp mount effect skips the
    // seed when the log is missing/empty. The rail should not
    // render the "audit" label at all.
    const { lastFrame } = await renderRail(baseStatus());
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('audit');
  });
});
