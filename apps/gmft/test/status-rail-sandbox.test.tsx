/**
 * v0.2.D — StatusRail sandbox field tests.
 *
 * The Sandbox field in the StatusRail shows the runner mode the
 * most-recent tool call used. The plan covers 4 main cases:
 *
 *   - `'docker'`    → `docker` (no warning)
 *   - `'host+landlock'` → `host+landlock` (no warning — kernel-enforced)
 *   - `'host'`      → `⚠ host` (persistent warning — bare host)
 *   - `'unsandboxed'` → `✗ unsandboxed` (red — chokepoint denied)
 *
 * `host+seccomp` and `host+landlock+seccomp` are not in the plan's
 * 4-case set but we test the pure-render helper for them too (they
 * follow the same "no warning — kernel-enforced" rule). The
 * `unknown` boot state is a defensive case for the `setStatus` boot
 * path; the rail shows it dim.
 *
 * We test the pure-render helper `renderSandboxField` (which is
 * what the JSX wrapper calls into) for all 7 modes. The full JSX
 * component is exercised through the smoke + app-e2e tests via the
 * App path; the rendering of one mode with one color is asserted
 * in a JSX test below.
 */

import { describe, it, expect } from 'vitest';
import type { ReactElement } from 'react';
import React from 'react';
import { render } from 'ink-testing-library';
import {
  renderSandboxField,
  StatusRail,
  type SandboxMode,
  type StatusInfo,
} from '../src/ui/components/StatusRail.js';
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

describe('renderSandboxField (v0.2.D)', () => {
  it('renders "docker" without a warning glyph for the docker resolver', () => {
    expect(renderSandboxField('docker')).toBe('docker');
  });

  it('renders "host+landlock" without a warning (kernel-enforced)', () => {
    // Landlock is enforced by the kernel; the blast radius is
    // bounded, so we don't want a warning glyph that would scare
    // users away from a mode that's strictly safer than a
    // permissive docker profile.
    expect(renderSandboxField('host+landlock')).toBe('host+landlock');
  });

  it('renders "host+seccomp" without a warning (kernel-enforced)', () => {
    expect(renderSandboxField('host+seccomp')).toBe('host+seccomp');
  });

  it('renders "host+landlock+seccomp" without a warning (both layers)', () => {
    expect(renderSandboxField('host+landlock+seccomp')).toBe('host+landlock+seccomp');
  });

  it('renders "⚠ host" with the persistent warning for bare host', () => {
    // This is the v0.1 fallback banner. The plan keeps it as the
    // one case that triggers a warning glyph — bare host has no
    // kernel enforcement, so the blast radius is unbounded.
    expect(renderSandboxField('host')).toBe('⚠ host');
  });

  it('renders "✗ unsandboxed" with a red ✗ when the chokepoint denied', () => {
    // Distinct from bare host: bare host is "the runner ran on
    // the host"; unsandboxed is "the chokepoint refused to run
    // because no sandbox was available". The ✗ vs ⚠ glyph tells
    // the user these are different states.
    expect(renderSandboxField('unsandboxed')).toBe('✗ unsandboxed');
  });

  it('renders "unknown" for the boot state (before the first tool runs)', () => {
    // We used to set sandbox: 'unknown' in AgentApp at boot; that
    // is now sourced from runnerCapabilities().resolvedAuto so
    // 'unknown' is reserved for tests + edge cases. The rail
    // shows it plainly with no glyph.
    expect(renderSandboxField('unknown')).toBe('unknown');
  });
});

describe('StatusRail sandbox JSX (v0.2.D)', () => {
  // Plan called for a single smoke test that all 4 cases render
  // their expected substring via ink-testing-library. We cover
  // the 3 visible-glyph cases (host=⚠, unsandboxed=✗, everything
  // else plain) — the JSX wrapper's color is asserted by inspecting
  // the rendered frame for the label substring (ink strips color
  // attrs in plain text output, so we don't assert color, only
  // presence).

  const tick = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

  async function renderRail(sandbox: SandboxMode) {
    const result = render(
      React.createElement(StatusRail, {
        status: baseStatus({ sandbox }),
        theme,
      }) as ReactElement,
    );
    await tick();
    return result;
  }

  it('renders the persistent ⚠ for bare host mode', async () => {
    const { lastFrame } = await renderRail('host');
    const frame = lastFrame() ?? '';
    expect(frame).toContain('⚠ host');
  });

  it('renders ✗ unsandboxed (red) when the chokepoint denied the call', async () => {
    const { lastFrame } = await renderRail('unsandboxed');
    const frame = lastFrame() ?? '';
    expect(frame).toContain('✗ unsandboxed');
  });

  it('renders "host+landlock" plainly (no warning glyph) when the kernel layer is active', async () => {
    // The plan's "no warning for kernel-enforced" rule. If this
    // ever renders "⚠ host+landlock" we'd be scaring users away
    // from a strictly safer mode than bare host.
    const { lastFrame } = await renderRail('host+landlock');
    const frame = lastFrame() ?? '';
    expect(frame).toContain('host+landlock');
    expect(frame).not.toContain('⚠ host+landlock');
  });

  it('renders "docker" plainly (no warning glyph)', async () => {
    const { lastFrame } = await renderRail('docker');
    const frame = lastFrame() ?? '';
    expect(frame).toContain('docker');
    expect(frame).not.toContain('⚠ docker');
  });
});
