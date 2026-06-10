import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('../../src/shared/runner', () => ({
  run: vi.fn(),
}));

import { nucleiTool, parseNucleiNdjson } from '../../src/web/nuclei';
import { run } from '../../src/shared/runner';

const FIXTURE = readFileSync(
  join(__dirname, 'fixtures/nuclei-sample.ndjson'),
  'utf8',
);

describe('nuclei tool', () => {
  beforeEach(() => {
    vi.mocked(run).mockReset();
    vi.mocked(run).mockResolvedValue({
      exitCode: 0,
      stdout: FIXTURE,
      stderr: '',
      durationMs: 123,
      mode: 'host',
      fellBack: false,
    });
  });

  it('parses ndjson into Finding[]', () => {
    const findings = parseNucleiNdjson(FIXTURE);
    expect(findings).toHaveLength(3);
    expect(findings[0].severity).toBe('critical');
    expect(findings[0].tool).toBe('nuclei');
    expect(findings[0].title).toMatch(/Log4j/);
    expect(findings[0].target).toMatch(/example\.com/);
  });

  it('run() invokes the runner and returns parsed findings + mode', async () => {
    const out = await nucleiTool.run({ target: 'https://example.com' }, {} as any);
    expect(out.findings).toHaveLength(3);
    expect(out.mode).toBe('host');
    expect(vi.mocked(run)).toHaveBeenCalledWith(
      expect.objectContaining({
        argv: expect.arrayContaining(['nuclei', '-u', 'https://example.com', '-json', '-silent']),
      }),
    );
  });

  it('registers with the right name, category, and flags', () => {
    expect(nucleiTool.name).toBe('nuclei');
    expect(nucleiTool.category).toBe('binary');
    expect(nucleiTool.flags).toEqual([]);
  });
});
