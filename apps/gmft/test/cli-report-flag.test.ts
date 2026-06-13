/**
 * v0.3.B — tests for the `--report` / `--report-format` CLI flag.
 *
 * The flag's post-exit logic lives in `report-flag.ts` so it can be
 * unit-tested without booting the Ink runtime. The CLI wires the
 * flag in after `waitUntilExit()`; this file tests the helpers
 * directly.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseReportFormat, writePostExitReport } from '../src/report-flag.js';
import type { Finding } from '@gmft/core';

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

describe('parseReportFormat', () => {
  it('defaults to "json" when the flag is undefined', () => {
    expect(parseReportFormat(undefined)).toBe('json');
  });

  it('parses "json"', () => {
    expect(parseReportFormat('json')).toBe('json');
  });

  it('parses "pdf"', () => {
    expect(parseReportFormat('pdf')).toBe('pdf');
  });

  it('rejects an invalid value with a clear error', () => {
    expect(() => parseReportFormat('csv')).toThrowError(
      /Invalid --report-format: "csv"/,
    );
  });

  it('rejects an empty string with a clear error', () => {
    expect(() => parseReportFormat('')).toThrowError(
      /Invalid --report-format: ""/,
    );
  });
});

describe('writePostExitReport', () => {
  let homeDir: string;
  let originalXdg: string | undefined;
  let baseDir: string;
  const sessionId = 'sess-2026-06-17-cli';

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'gmft-cli-report-'));
    originalXdg = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = homeDir;
    baseDir = mkdtempSync(join(tmpdir(), 'gmft-cli-report-base-'));
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

  it('writes a JSON report to the default reports path', async () => {
    seedFindings(baseDir, sessionId, [
      makeFinding({ id: 'f-1', severity: 'critical' }),
      makeFinding({ id: 'f-2', severity: 'low' }),
    ]);
    const result = await writePostExitReport({
      sessionId,
      baseDir,
      outputPath: `${sessionId}.json`,
      format: 'json',
    });
    expect(result.format).toBe('json');
    expect(result.findingCount).toBe(2);
    expect(result.path).toBe(join(homeDir, 'gmft', 'reports', `${sessionId}.json`));
    expect(existsSync(result.path)).toBe(true);
    const body = JSON.parse(readFileSync(result.path, 'utf8'));
    expect(body.schema).toBe('gmft.report.v1');
    expect(body.sessionId).toBe(sessionId);
    expect(body.count).toBe(2);
    expect(body.findings).toHaveLength(2);
  });

  it('writes a PDF report to the default reports path', async () => {
    seedFindings(baseDir, sessionId, [
      makeFinding({ id: 'f-1', severity: 'critical' }),
    ]);
    const result = await writePostExitReport({
      sessionId,
      baseDir,
      outputPath: `${sessionId}.pdf`,
      format: 'pdf',
    });
    expect(result.format).toBe('pdf');
    expect(result.findingCount).toBe(1);
    expect(result.path).toBe(join(homeDir, 'gmft', 'reports', `${sessionId}.pdf`));
    expect(existsSync(result.path)).toBe(true);
    const buf = readFileSync(result.path);
    expect(buf.length).toBeGreaterThan(0);
    expect(buf.subarray(0, 5).toString('utf8')).toBe('%PDF-');
  });

  it('honors a custom outputPath inside the reports dir', async () => {
    seedFindings(baseDir, sessionId, [makeFinding({ id: 'f-1' })]);
    const result = await writePostExitReport({
      sessionId,
      baseDir,
      outputPath: 'custom-name.json',
      format: 'json',
    });
    expect(result.path).toBe(join(homeDir, 'gmft', 'reports', 'custom-name.json'));
    expect(existsSync(result.path)).toBe(true);
  });

  it('rejects an outputPath that escapes the reports dir', async () => {
    seedFindings(baseDir, sessionId, [makeFinding({ id: 'f-1' })]);
    await expect(
      writePostExitReport({
        sessionId,
        baseDir,
        outputPath: '/tmp/Trash/../../etc/passwd',
        format: 'json',
      }),
    ).rejects.toThrow(/\.\./);
  });

  it('returns findingCount=0 when the session has no findings', async () => {
    // No seedFindings call → the .jsonl doesn't exist.
    const result = await writePostExitReport({
      sessionId,
      baseDir,
      outputPath: `${sessionId}.json`,
      format: 'json',
    });
    expect(result.findingCount).toBe(0);
    const body = JSON.parse(readFileSync(result.path, 'utf8'));
    expect(body.count).toBe(0);
    expect(body.findings).toEqual([]);
  });
});
