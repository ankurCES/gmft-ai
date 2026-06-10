import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('../../src/shared/runner', () => ({
  run: vi.fn(),
}));

import { gobusterTool, parseGobusterText } from '../../src/web/gobuster';
import { run } from '../../src/shared/runner';

const FIXTURE = readFileSync(
  join(__dirname, 'fixtures/gobuster-sample.txt'),
  'utf8',
);

describe('gobuster tool', () => {
  beforeEach(() => {
    vi.mocked(run).mockReset();
    vi.mocked(run).mockResolvedValue({
      exitCode: 0,
      stdout: FIXTURE,
      stderr: '',
      durationMs: 100,
      mode: 'host',
      fellBack: false,
    });
  });

  it('parses text into Finding[] with one entry per discovered path', () => {
    const findings = parseGobusterText(FIXTURE, 'https://example.com');
    expect(findings).toHaveLength(5);
    expect(findings[0].tool).toBe('gobuster');
    expect(findings[0].target).toBe('https://example.com');
    expect(findings[0].title).toContain('/admin');
    expect(findings[0].title).toContain('200');
  });

  it('run() returns parsed findings', async () => {
    const out = await gobusterTool.run({ url: 'https://example.com' }, {} as any);
    expect(out.findings).toHaveLength(5);
  });

  it('registers with name=gobuster, category=binary, no flags', () => {
    expect(gobusterTool.name).toBe('gobuster');
    expect(gobusterTool.category).toBe('binary');
    expect(gobusterTool.flags).toEqual([]);
  });
});
