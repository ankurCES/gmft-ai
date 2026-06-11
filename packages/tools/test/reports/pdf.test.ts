/**
 * Tests for the report_pdf tool + the pure renderPdfBuffer helper.
 *
 * Per plan §6.2: "Unit test: pdf buffer is non-empty and starts
 * with `%PDF-`". We go a bit further:
 *   - the pure function (no FS) gets coverage with a stub renderer
 *   - the tool's end-to-end path (store → render → write) gets
 *     coverage with the real renderer, including default path,
 *     override path with `..` rejection, and severity filter
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { reportPdfTool, renderPdfBuffer, type PdfRenderer } from '../../src/reports/pdf.js';
import type { Finding, ToolContext } from '@gmft/core';

function makeCtx(): ToolContext {
  return { cwd: process.cwd(), env: process.env, cfg: { sandbox: { mode: 'host' as const } } };
}

function seedFindings(baseDir: string, sessionId: string, findings: Finding[]): void {
  mkdirSync(baseDir, { recursive: true });
  const path = join(baseDir, `${sessionId}.jsonl`);
  const text = findings.map((f) => JSON.stringify(f)).join('\n') + '\n';
  writeFileSync(path, text, 'utf8');
}

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'f-1',
    tool: 'nmap',
    target: '10.0.0.1',
    severity: 'high',
    title: 'Open SSH',
    description: 'SSH is exposed on the default port.',
    evidence: '22/tcp open ssh OpenSSH 8.2p1',
    ts: 1,
    ...overrides,
  };
}

describe('renderPdfBuffer (pure)', () => {
  it('returns a non-empty buffer that starts with %PDF-', async () => {
    const findings = [makeFinding()];
    const meta = {
      sessionId: 'sess-pure',
      generatedAt: new Date().toISOString(),
      title: 'Test Report',
    };
    const buffer = await renderPdfBuffer(findings, meta);
    expect(buffer.length).toBeGreaterThan(0);
    // PDF magic — every real PDF starts with these 5 bytes.
    const head = buffer.subarray(0, 5).toString('utf8');
    expect(head).toBe('%PDF-');
  });

  it('emits a multi-page document for multiple findings (cover + 1 per finding)', async () => {
    const findings = [
      makeFinding({ id: 'f-1', title: 'A' }),
      makeFinding({ id: 'f-2', title: 'B' }),
      makeFinding({ id: 'f-3', title: 'C' }),
    ];
    const meta = { sessionId: 's1', generatedAt: new Date().toISOString(), title: 'T' };
    const buffer = await renderPdfBuffer(findings, meta);
    // Rough sanity check: more findings => more pages => larger buffer.
    // Use a single-finding baseline to compare.
    const single = await renderPdfBuffer([findings[0]!], meta);
    expect(buffer.length).toBeGreaterThan(single.length);
  });

  it('emits a still-valid PDF when there are no findings (cover + "no findings" page)', async () => {
    const meta = { sessionId: 's0', generatedAt: new Date().toISOString(), title: 'T' };
    const buffer = await renderPdfBuffer([], meta);
    expect(buffer.length).toBeGreaterThan(0);
    const head = buffer.subarray(0, 5).toString('utf8');
    expect(head).toBe('%PDF-');
  });

  it('accepts an injected renderer (used to keep the pure function testable without a real lib)', async () => {
    // Build a known stub element + assert renderPdfBuffer hands it
    // to the injected renderer and returns whatever it returns.
    let received: React.ReactElement | null = null;
    const stubBuffer = Buffer.from('%PDF-stub');
    const stubRenderer: PdfRenderer = {
      renderToBuffer: async (el: React.ReactElement) => {
        received = el;
        return stubBuffer;
      },
    };
    const out = await renderPdfBuffer([makeFinding()], {
      sessionId: 's-stub',
      generatedAt: 'x',
      title: 't',
    }, stubRenderer);
    expect(out).toBe(stubBuffer);
    expect(received).not.toBeNull();
  });
});

describe('reportPdfTool', () => {
  let homeDir: string;
  let originalXdg: string | undefined;
  let baseDir: string;
  let sessionId: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'gmft-pdf-'));
    originalXdg = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = homeDir;
    baseDir = mkdtempSync(join(tmpdir(), 'gmft-pdf-base-'));
    sessionId = 'sess-pdf';
  });

  afterEach(() => {
    if (originalXdg === undefined) {
      delete process.env.XDG_DATA_HOME;
    } else {
      process.env.XDG_DATA_HOME = originalXdg;
    }
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(baseDir, { recursive: true, force: true });
  });

  it('writes a valid PDF to the default reports path', async () => {
    seedFindings(baseDir, sessionId, [
      makeFinding({ id: 'f-1', severity: 'critical', title: 'RCE in /admin', evidence: 'curl /admin?cmd=id' }),
      makeFinding({ id: 'f-2', severity: 'low', title: 'cookie without httponly' }),
    ]);
    const result = await reportPdfTool.run(
      { baseDir, sessionId, severityFilter: 'medium' },
      makeCtx(),
    );
    expect(result.format).toBe('pdf');
    expect(result.findingCount).toBe(1); // only the critical one (filter=medium)
    expect(result.path).toBe(join(homeDir, 'gmft', 'reports', `${sessionId}.pdf`));
    expect(existsSync(result.path)).toBe(true);
    const buf = readFileSync(result.path);
    expect(buf.length).toBeGreaterThan(0);
    expect(buf.subarray(0, 5).toString('utf8')).toBe('%PDF-');
    expect(result.bytesWritten).toBe(statSync(result.path).size);
  });

  it('rejects outputPath that escapes the reports dir', async () => {
    seedFindings(baseDir, sessionId, [makeFinding({ id: 'f-1', severity: 'medium' })]);
    await expect(
      reportPdfTool.run(
        { baseDir, sessionId, outputPath: '/tmp/Trash/../../etc/passwd' },
        makeCtx(),
      ),
    ).rejects.toThrow(/reports dir|contains a "\.\."/);
  });

  it('honors includeEvidence=false — buffer is still valid but smaller', async () => {
    seedFindings(baseDir, sessionId, [
      makeFinding({ id: 'f-1', severity: 'high', evidence: 'AAAA'.repeat(200) }),
    ]);
    const withEv = await reportPdfTool.run(
      { baseDir, sessionId, severityFilter: 'info', includeEvidence: true },
      makeCtx(),
    );
    const withoutEv = await reportPdfTool.run(
      { baseDir, sessionId, severityFilter: 'info', includeEvidence: false },
      makeCtx(),
    );
    expect(withEv.findingCount).toBe(1);
    expect(withoutEv.findingCount).toBe(1);
    expect(withEv.bytesWritten).toBeGreaterThan(withoutEv.bytesWritten);
  });
});
