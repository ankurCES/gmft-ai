import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('../../src/shared/runner', () => ({
  run: vi.fn(),
}));

import { ffufTool, parseFfufJson } from '../../src/web/ffuf';
import { run } from '../../src/shared/runner';

const FIXTURE = readFileSync(
  join(__dirname, 'fixtures/ffuf-sample.json'),
  'utf8',
);

describe('ffuf tool', () => {
  beforeEach(() => {
    vi.mocked(run).mockReset();
    vi.mocked(run).mockResolvedValue({
      exitCode: 0,
      stdout: FIXTURE,
      stderr: '',
      durationMs: 50,
      mode: 'host',
      fellBack: false,
    });
  });

  it('parses JSON into Finding[]', () => {
    const findings = parseFfufJson(FIXTURE, 'https://example.com');
    expect(findings).toHaveLength(4);
    expect(findings[0].title).toMatch(/admin/);
    expect(findings[0].title).toMatch(/200/);
    expect(findings[0].target).toBe('https://example.com');
  });

  it('run() returns parsed findings', async () => {
    const out = await ffufTool.run(
      { url: 'https://example.com/FUZZ' },
      {} as any,
    );
    expect(out.findings).toHaveLength(4);
  });

  it('registers with name=ffuf, category=binary, no flags', () => {
    expect(ffufTool.name).toBe('ffuf');
    expect(ffufTool.category).toBe('binary');
    expect(ffufTool.flags).toEqual([]);
  });
});
