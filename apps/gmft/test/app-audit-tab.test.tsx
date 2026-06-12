/**
 * v0.3.A.4 — A.4.2 (tab wiring) test.
 *
 * Asserts that the `audit` tab is switchable: when `initialTab` is
 * `'audit'` and `auditEvents` is provided, the App renders the
 * AuditLogTab (not the ChatTab / FindingsTab / HelpTab) and the
 * supplied events appear in the frame.
 */
import { render } from 'ink-testing-library';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@gmft/core';
import { App } from '../src/App.js';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('App audit tab wiring (v0.3.A.4 — A.4.2)', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    consoleErrorSpy.mockRestore();
    vi.clearAllMocks();
  });

  it('renders the AuditLogTab when initialTab is "audit" and auditEvents is provided', async () => {
    const events: AgentEvent[] = [
      { type: 'text-delta', text: 'audit-tab-marker' },
      {
        type: 'tool-call-request',
        id: 'tcr-app-test',
        name: 'nmap',
        args: { target: 'h' },
      },
    ];
    const { lastFrame } = render(
      <App
        initialTab="audit"
        auditEvents={events}
        status={{
          provider: 'anthropic',
          model: 'claude-3-5-haiku-latest',
          toolCalls: 0,
          findings: 0,
          findingsBySeverity: { info: 0, low: 0, medium: 0, high: 0, critical: 0 },
          sandbox: 'host',
        }}
        onExit={() => {}}
      />,
    );
    // Let Ink render.
    for (let i = 0; i < 3; i++) await tick();
    const out = lastFrame() ?? '';
    // AuditLogTab is rendered (title visible).
    expect(out).toMatch(/Audit Log/);
    // The supplied events made it through the prop.
    expect(out).toMatch(/audit-tab-marker/);
    expect(out).toMatch(/nmap/);
    // The active tab marker in the TabBar shows ▸ Audit.
    expect(out).toMatch(/▸ Audit/);
    // The chat tab is NOT the active one (no input prompt visible).
    // We assert the absence of the "Chat" label being active by
    // looking for the muted, non-active label and the active marker
    // being only on Audit.
    expect(out).not.toMatch(/▸ Chat/);
  });
});
