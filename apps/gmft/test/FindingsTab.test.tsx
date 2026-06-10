/**
 * Tests for the phase-6 FindingsTab rewrite. Per plan §B.4 the
 * budget is 2 tests:
 *   1. renders N findings with the right tool + target + title
 *   2. space toggles a checkbox and the sidecar autosave fires
 *
 * The second test uses vi.useFakeTimers() to skip the 500ms
 * debounce window; the actual sidecar is written to a temp dir and
 * verified via readFileSync.
 */
import { render, type RenderOptions } from 'ink-testing-library';
import type { ReactElement } from 'react';
import React from 'react';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FindingsTab } from '../src/ui/tabs/FindingsTab.js';
import { makeTheme } from '../src/ui/theme.js';
import type { Finding } from '@gmft/core';

const theme = makeTheme('dark');

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

async function renderTab(props: Omit<React.ComponentProps<typeof FindingsTab>, 'theme' | 'status'>) {
  const status = { model: 'm', provider: 'p', sandbox: 'host' as const, tokensIn: 0, tokensOut: 0, toolCalls: 0, findings: 0 };
  const result = render(
    React.createElement(FindingsTab, { ...props, theme, status }) as ReactElement,
    {} as RenderOptions,
  );
  await tick();
  return result;
}

function makeFinding(id: string, tool: string, target: string, severity: Finding['severity'], title: string): Finding {
  return { id, tool, target, severity, title, ts: 0 };
}

describe('FindingsTab (phase 6 rewrite)', () => {
  describe('placeholder path (no findings prop)', () => {
    it('renders the phase-1 placeholder when findings is undefined', async () => {
      const status = { model: 'm', provider: 'p', sandbox: 'host' as const, tokensIn: 0, tokensOut: 0, toolCalls: 0, findings: 0 };
      const { lastFrame } = render(
        React.createElement(FindingsTab, { theme, status }) as ReactElement,
        {} as RenderOptions,
      );
      await tick();
      const frame = lastFrame() ?? '';
      expect(frame).toContain('Findings');
      // The placeholder includes the "land in phase 2" hint
      expect(frame).toContain('land in phase 2');
    });
  });

  describe('real list path (findings prop provided)', () => {
    let baseDir: string;
    const sessionId = 'sess-tab-1';

    beforeEach(() => {
      baseDir = mkdtempSync(join(tmpdir(), 'gmft-tab-'));
    });

    afterEach(() => {
      rmSync(baseDir, { recursive: true, force: true });
    });

    it('renders N findings with severity + tool + target + title', async () => {
      const findings: Finding[] = [
        makeFinding('f-1', 'nmap', '10.0.0.1', 'critical', 'SQL injection in /api/users'),
        makeFinding('f-2', 'nikto', '10.0.0.2', 'medium', 'Missing CSP header'),
        makeFinding('f-3', 'sqlmap', '10.0.0.3', 'low', 'Slow response time'),
      ];
      const { lastFrame } = await renderTab({
        findings,
        baseDir,
        sessionId,
      });

      const frame = lastFrame() ?? '';
      expect(frame).toContain('(3 recorded');
      expect(frame).toContain('SQL injection');
      expect(frame).toContain('Missing CSP');
      expect(frame).toContain('Slow response');
      expect(frame).toContain('nmap');
      expect(frame).toContain('nikto');
      expect(frame).toContain('sqlmap');
      expect(frame).toContain('10.0.0.1');
      expect(frame).toContain('10.0.0.2');
      expect(frame).toContain('10.0.0.3');
    });

    it('toggles a checkbox with space, then autosaves the sidecar after the debounce', async () => {
      const findings: Finding[] = [
        makeFinding('f-1', 'nmap', '10.0.0.1', 'critical', 'A'),
        makeFinding('f-2', 'nikto', '10.0.0.2', 'medium', 'B'),
      ];
      const { stdin, lastFrame } = await renderTab({
        findings,
        baseDir,
        sessionId,
      });

      // Cursor starts on the first row; press space to check it.
      stdin.write(' ');
      // Wait for the 500ms debounce to fire. (We use real timers
      // because vi.useFakeTimers() breaks Ink's stdin polling.)
      await new Promise<void>((r) => setTimeout(r, 700));
      await tick();

      const sidecarPath = join(baseDir, `${sessionId}.selections.json`);
      expect(existsSync(sidecarPath)).toBe(true);
      const body = JSON.parse(readFileSync(sidecarPath, 'utf8')) as { checkedIds: string[] };
      expect(body.checkedIds).toEqual(['f-1']);

      // Press 'j' then ' ' to move down + check the second row.
      stdin.write('j');
      await tick();
      stdin.write(' ');
      await new Promise<void>((r) => setTimeout(r, 700));
      await tick();

      const body2 = JSON.parse(readFileSync(sidecarPath, 'utf8')) as { checkedIds: string[] };
      expect(body2.checkedIds.sort()).toEqual(['f-1', 'f-2']);
      // Frame should reflect the new selected count.
      const frame = lastFrame() ?? '';
      expect(frame).toContain('2 selected');
    });

    it('hydrates checked state from an existing sidecar on mount', async () => {
      // Pre-seed the sidecar.
      writeFileSync(
        join(baseDir, `${sessionId}.selections.json`),
        JSON.stringify({ checkedIds: ['f-2'] }),
        'utf8',
      );
      const findings: Finding[] = [
        makeFinding('f-1', 'nmap', '10.0.0.1', 'critical', 'A'),
        makeFinding('f-2', 'nikto', '10.0.0.2', 'medium', 'B'),
      ];
      const { lastFrame } = await renderTab({
        findings,
        baseDir,
        sessionId,
      });
      const frame = lastFrame() ?? '';
      expect(frame).toContain('1 selected');
    });
  });
});
