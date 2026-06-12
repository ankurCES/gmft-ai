import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('../../src/shared/runner', () => ({
  run: vi.fn(),
}));

import { sqlmapTool, parseSqlmapText } from '../../src/web/sqlmap.js';
import { run } from '../../src/shared/runner.js';

const FIXTURE = readFileSync(
  join(__dirname, 'fixtures/sqlmap-sample.txt'),
  'utf8',
);

describe('sqlmap tool (destructive)', () => {
  beforeEach(() => {
    vi.mocked(run).mockReset();
    vi.mocked(run).mockResolvedValue({
      exitCode: 0,
      stdout: FIXTURE,
      stderr: '',
      durationMs: 200,
      mode: 'host',
      fellBack: false,
    });
  });

  it('parses text into Finding[] with a critical severity injection finding', () => {
    const findings = parseSqlmapText(FIXTURE, 'https://example.com/?id=1');
    expect(findings.length).toBeGreaterThan(0);
    const injectable = findings.find((f) =>
      f.title.toLowerCase().includes('injection'),
    );
    expect(injectable).toBeDefined();
    expect(injectable?.severity).toBe('critical');
    expect(injectable?.target).toBe('https://example.com/?id=1');
  });

  it('run() returns parsed findings', async () => {
    const out = await sqlmapTool.run(
      { url: 'https://example.com/?id=1' },
      {} as any,
    );
    expect(out.findings.length).toBeGreaterThan(0);
  });

  it('is flagged destructive (chokepoint will require confirm)', () => {
    expect(sqlmapTool.flags).toContain('destructive');
    expect(sqlmapTool.name).toBe('sqlmap');
    expect(sqlmapTool.category).toBe('binary');
  });
});
