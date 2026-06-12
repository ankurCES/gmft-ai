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

import { whatwebTool } from '../../src/network/whatweb.js';
import { run } from '../../src/shared/runner.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ndjsonFixture = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'whatweb-sample.ndjson'),
  'utf8',
);

describe('whatwebTool', () => {
  beforeEach(() => {
    vi.mocked(run).mockReset();
    vi.mocked(run).mockResolvedValue({
      exitCode: 0,
      stdout: ndjsonFixture,
      stderr: '',
      durationMs: 100,
      mode: 'docker',
      fellBack: false,
    });
  });

  it('has the right metadata', () => {
    expect(whatwebTool.name).toBe('whatweb');
    expect(whatwebTool.category).toBe('recon');
    expect(whatwebTool.flags).toContain('targetRequired');
  });

  it('parses NDJSON into technologies', async () => {
    const out = await whatwebTool.run({ url: 'https://example.com' });
    expect(out.technologies.length).toBeGreaterThan(0);
    const names = out.technologies.map((t) => t.name);
    expect(names).toContain('HTTPServer');
    expect(names).toContain('WebFramework');
    expect(names).toContain('Title');
    const apache = out.technologies.find((t) => t.name === 'HTTPServer');
    expect(apache?.value).toBe('nginx');
  });

  it('emits one finding per technology', async () => {
    const out = await whatwebTool.run({ url: 'https://example.com' });
    expect(out.findings.length).toBe(out.technologies.length);
    for (const f of out.findings) {
      expect(f.tool).toBe('whatweb');
      expect(f.target).toBe('https://example.com');
      expect(f.title).toMatch(/^Tech /);
    }
  });

  it('forwards the url to whatweb with --log-json=- and --no-errors -q', async () => {
    await whatwebTool.run({ url: 'https://example.com', aggression: 2 });
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        argv: expect.arrayContaining([
          'whatweb',
          '--no-errors',
          '-q',
          '--log-json=-',
          '-a',
          '2',
          'https://example.com',
        ]),
        image: 'gmft/network:0.1',
      }),
    );
  });
});
