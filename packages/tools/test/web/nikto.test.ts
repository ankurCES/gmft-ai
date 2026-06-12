import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('../../src/shared/runner', () => ({
  run: vi.fn(),
}));

import { niktoTool, parseNiktoText } from '../../src/web/nikto.js';
import { run } from '../../src/shared/runner.js';

const FIXTURE = readFileSync(
  join(__dirname, 'fixtures/nikto-sample.txt'),
  'utf8',
);

describe('nikto tool', () => {
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

  it('parses plain text into Finding[]', () => {
    const findings = parseNiktoText(FIXTURE, 'https://example.com');
    expect(findings.length).toBeGreaterThanOrEqual(4);
    expect(findings.every((f) => f.target === 'https://example.com')).toBe(true);
    expect(
      findings.every((f) =>
        ['low', 'medium', 'high', 'critical'].includes(f.severity),
      ),
    ).toBe(true);
    expect(findings.some((f) => f.title.toLowerCase().includes('admin'))).toBe(
      true,
    );
  });

  it('run() returns parsed findings', async () => {
    const out = await niktoTool.run({ target: 'https://example.com' }, {} as any);
    expect(out.findings.length).toBeGreaterThan(0);
    expect(out.mode).toBe('host');
  });

  it('registers with name=nikto, category=binary, no flags', () => {
    expect(niktoTool.name).toBe('nikto');
    expect(niktoTool.category).toBe('binary');
    expect(niktoTool.flags).toEqual([]);
  });
});
