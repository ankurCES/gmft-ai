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

import { dnsenumTool } from '../../src/network/dnsenum.js';
import { run } from '../../src/shared/runner.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

const textFixture = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'dnsenum-sample.txt'),
  'utf8',
);

describe('dnsenumTool', () => {
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
    expect(dnsenumTool.name).toBe('dnsenum');
    expect(dnsenumTool.category).toBe('recon');
    expect(dnsenumTool.flags).toContain('targetRequired');
  });

  it('parses host addresses + nameservers + MX', async () => {
    const out = await dnsenumTool.run({ domain: 'example.com' });
    expect(out.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ host: 'example.com', address: '93.184.216.34' }),
      ]),
    );
    expect(out.nameservers).toContain('ns1.example.com');
    expect(out.nameservers).toContain('ns2.example.com');
    expect(out.mx).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ host: 'mail.example.com', pref: 10 }),
      ]),
    );
  });

  it('emits one Finding per discovered host', async () => {
    const out = await dnsenumTool.run({ domain: 'example.com' });
    expect(out.findings.length).toBeGreaterThanOrEqual(4);
    for (const f of out.findings) {
      expect(f.tool).toBe('dnsenum');
      expect(f.target).toBe('example.com');
      expect(f.severity).toBe('info');
    }
  });

  it('forwards the domain to dnsenum and uses --noreverse -o -', async () => {
    await dnsenumTool.run({ domain: 'example.com' });
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        argv: expect.arrayContaining(['dnsenum', '--noreverse', '-o', '-', 'example.com']),
        image: 'gmft/network:0.1',
      }),
    );
  });
});
