/**
 * Tests for the report_write tool. The plan §B.1 budgets 5 tests for
 * the core tool + 2 tests for the sidecar reader — we fold the
 * sidecar coverage into the 5 tool tests where the sidecar is on the
 * hot path ("severity filter + selection sidecar interaction"), and
 * add a 6th test that pins the default-path behavior under a temp
 * HOME so we don't depend on the test runner's real home dir.
 *
 * Total: 5 report_write tests as planned.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reportWriteTool } from '../../src/reports/write.js';
import type { ToolContext } from '@gmft/core';

function makeCtx(): ToolContext {
  return { cwd: process.cwd(), env: process.env, cfg: { sandbox: { mode: 'host' as const } } };
}

function seedFindings(baseDir: string, sessionId: string, findings: Array<Omit<Parameters<typeof writeFileSync>[1], never>>): void {
  mkdirSync(baseDir, { recursive: true });
  const path = join(baseDir, `${sessionId}.jsonl`);
  const text = findings.map((f) => JSON.stringify(f)).join('\n') + '\n';
  writeFileSync(path, text, 'utf8');
}

describe('report_write tool', () => {
  let homeDir: string;
  let originalXdg: string | undefined;
  let baseDir: string;
  let sessionId: string;

  beforeEach(() => {
    // Redirect the reports dir under a temp HOME so we don't pollute
    // the real ~/.local/share.
    homeDir = mkdtempSync(join(tmpdir(), 'gmft-report-'));
    originalXdg = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = homeDir;
    baseDir = mkdtempSync(join(tmpdir(), 'gmft-base-'));
    sessionId = 'sess-test';
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

  it('writes a markdown report filtered by severity (default: medium)', async () => {
    seedFindings(baseDir, sessionId, [
      { id: 'f-1', tool: 'nmap', target: '10.0.0.1', severity: 'low', title: 'low finding', description: 'low desc', ts: 1 },
      { id: 'f-2', tool: 'nikto', target: '10.0.0.1', severity: 'medium', title: 'medium finding', description: 'med desc', ts: 2 },
      { id: 'f-3', tool: 'sqlmap', target: '10.0.0.1', severity: 'critical', title: 'critical finding', description: 'crit desc', evidence: 'SQL error: foo', ts: 3 },
    ]);

    const result = await reportWriteTool.run(
      { baseDir, sessionId, format: 'markdown' },
      makeCtx(),
    );

    expect(result.format).toBe('markdown');
    expect(result.findingCount).toBe(2); // medium + critical, not low
    expect(existsSync(result.path)).toBe(true);
    const body = readFileSync(result.path, 'utf8');
    expect(body).toContain('# GMFT session report');
    expect(body).toContain('medium finding');
    expect(body).toContain('critical finding');
    expect(body).not.toContain('low finding');
  });

  it('writes a valid HTML report with severity badges', async () => {
    seedFindings(baseDir, sessionId, [
      { id: 'f-1', tool: 'nmap', target: '10.0.0.1', severity: 'high', title: 'XSS in /search', ts: 1 },
      { id: 'f-2', tool: 'nikto', target: '10.0.0.1', severity: 'low', title: 'missing header', ts: 2 },
    ]);

    const result = await reportWriteTool.run(
      { baseDir, sessionId, format: 'html', severityFilter: 'low' },
      makeCtx(),
    );

    expect(result.format).toBe('html');
    expect(result.findingCount).toBe(2); // both included at low filter
    const body = readFileSync(result.path, 'utf8');
    expect(body).toContain('<!DOCTYPE html>');
    expect(body).toContain('<html');
    expect(body).toContain('class="badge"');
    expect(body).toContain('HIGH');
    expect(body).toContain('LOW');
  });

  it('uses the default report path under the data dir when outputPath is omitted', async () => {
    seedFindings(baseDir, sessionId, [
      { id: 'f-1', tool: 'nmap', target: '10.0.0.1', severity: 'critical', title: 'crit', ts: 1 },
    ]);

    const result = await reportWriteTool.run(
      { baseDir, sessionId, format: 'markdown' },
      makeCtx(),
    );

    expect(result.path).toBe(join(homeDir, 'gmft', 'reports', `${sessionId}.md`));
    expect(existsSync(result.path)).toBe(true);
  });

  it('rejects outputPath that escapes the reports dir via ..', async () => {
    seedFindings(baseDir, sessionId, [
      { id: 'f-1', tool: 'nmap', target: '10.0.0.1', severity: 'medium', title: 'm', ts: 1 },
    ]);

    await expect(
      reportWriteTool.run(
        { baseDir, sessionId, format: 'markdown', outputPath: '/tmp/Trash/../../etc/passwd' },
        makeCtx(),
      ),
    ).rejects.toThrow(/reports dir|contains a "\.\."/);
  });

  it('honors the selection sidecar: only checkedIds are included (overrides severity)', async () => {
    seedFindings(baseDir, sessionId, [
      { id: 'f-1', tool: 'nmap', target: '10.0.0.1', severity: 'critical', title: 'a-crit', ts: 1 },
      { id: 'f-2', tool: 'nikto', target: '10.0.0.1', severity: 'high', title: 'b-high', ts: 2 },
      { id: 'f-3', tool: 'sqlmap', target: '10.0.0.1', severity: 'low', title: 'c-low', ts: 3 },
    ]);
    // Operator checked only f-1 and f-3 (skipped the high one).
    writeFileSync(
      join(baseDir, `${sessionId}.selections.json`),
      JSON.stringify({ checkedIds: ['f-1', 'f-3'] }),
      'utf8',
    );

    const result = await reportWriteTool.run(
      { baseDir, sessionId, format: 'markdown', severityFilter: 'info' },
      makeCtx(),
    );

    expect(result.findingCount).toBe(2);
    const body = readFileSync(result.path, 'utf8');
    expect(body).toContain('a-crit');
    expect(body).toContain('c-low');
    expect(body).not.toContain('b-high');
  });

  it('writes a valid JSON report with metadata + findings array (includeEvidence default true)', async () => {
    seedFindings(baseDir, sessionId, [
      { id: 'f-1', tool: 'nmap', target: '10.0.0.1', severity: 'high', title: 'open port', evidence: '22/tcp open ssh', ts: 1 },
      { id: 'f-2', tool: 'nikto', target: '10.0.0.1', severity: 'low', title: 'cookie flag', evidence: 'Set-Cookie: foo=bar', ts: 2 },
      { id: 'f-3', tool: 'sqlmap', target: '10.0.0.1', severity: 'info', title: 'noise', ts: 3 },
    ]);

    const result = await reportWriteTool.run(
      { baseDir, sessionId, format: 'json', severityFilter: 'low' },
      makeCtx(),
    );

    expect(result.format).toBe('json');
    expect(result.findingCount).toBe(2); // f-1 + f-2 (f-3 is info, dropped)
    expect(result.path.endsWith(`${sessionId}.json`)).toBe(true);
    const body = readFileSync(result.path, 'utf8');
    const doc = JSON.parse(body);
    expect(doc.schema).toBe('gmft.report.v1');
    expect(doc.sessionId).toBe(sessionId);
    expect(typeof doc.generatedAt).toBe('string');
    expect(doc.count).toBe(2);
    expect(doc.severities).toEqual({ info: 0, low: 1, medium: 0, high: 1, critical: 0 });
    expect(doc.findings).toHaveLength(2);
    expect(doc.findings[0].id).toBe('f-1');
    expect(doc.findings[0].evidence).toBe('22/tcp open ssh');
    expect(doc.findings[1].id).toBe('f-2');
  });

  it('JSON output honors includeEvidence=false and strips the evidence field', async () => {
    seedFindings(baseDir, sessionId, [
      { id: 'f-1', tool: 'nmap', target: '10.0.0.1', severity: 'high', title: 'open port', evidence: '22/tcp open ssh', ts: 1 },
    ]);

    const result = await reportWriteTool.run(
      { baseDir, sessionId, format: 'json', severityFilter: 'low', includeEvidence: false },
      makeCtx(),
    );

    expect(result.findingCount).toBe(1);
    const body = readFileSync(result.path, 'utf8');
    const doc = JSON.parse(body);
    expect(doc.findings[0].id).toBe('f-1');
    expect(doc.findings[0].title).toBe('open port');
    expect('evidence' in doc.findings[0]).toBe(false);
  });
});
