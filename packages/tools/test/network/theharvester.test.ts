import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/shared/runner', () => ({
  run: vi.fn(async () => ({
    exitCode: 0,
    stdout: '',
    stderr: '',
    durationMs: 100,
    mode: 'docker',
    fellBack: false,
  })),
}));

import { theHarvesterTool } from '../../src/network/theharvester.js';
import { run } from '../../src/shared/runner.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

const textFixture = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'theharvester-sample.txt'),
  'utf8',
);

describe('theHarvesterTool', () => {
  beforeEach(() => {
    vi.mocked(run).mockReset();
    vi.mocked(run).mockResolvedValue({
      exitCode: 0,
      stdout: textFixture,
      stderr: '',
      durationMs: 100,
      mode: 'docker',
      fellBack: false,
    });
  });

  it('has the right metadata', () => {
    expect(theHarvesterTool.name).toBe('the_harvester');
    expect(theHarvesterTool.category).toBe('recon');
    expect(theHarvesterTool.flags).toContain('targetRequired');
  });

  it('parses emails + hosts + urls', async () => {
    const out = await theHarvesterTool.run({ domain: 'example.com' });
    expect(out.emails).toEqual(['info@example.com', 'admin@example.com', 'security@example.com']);
    expect(out.hosts).toEqual([
      { host: 'www.example.com', address: '93.184.216.34' },
      { host: 'mail.example.com', address: '93.184.216.35' },
    ]);
    expect(out.urls).toEqual(['https://example.com/login']);
  });

  it('emits one finding per email/host/url', async () => {
    const out = await theHarvesterTool.run({ domain: 'example.com' });
    // 3 emails + 2 hosts + 1 URL = 6 findings
    expect(out.findings).toHaveLength(6);
    for (const f of out.findings) {
      expect(f.tool).toBe('the_harvester');
      expect(f.target).toBe('example.com');
    }
    expect(out.findings.some((f) => f.title.startsWith('Email '))).toBe(true);
    expect(out.findings.some((f) => f.title.startsWith('Host '))).toBe(true);
    expect(out.findings.some((f) => f.title.startsWith('URL '))).toBe(true);
  });

  it('forwards domain + sources + limit to theHarvester', async () => {
    await theHarvesterTool.run({ domain: 'example.com', sources: ['google', 'crtsh'], limit: 200 });
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        argv: expect.arrayContaining([
          'theHarvester',
          '-d',
          'example.com',
          '-b',
          'google,crtsh',
          '-l',
          '200',
          '-f',
          '-',
        ]),
        image: 'gmft/network:0.1',
      }),
    );
  });
});
