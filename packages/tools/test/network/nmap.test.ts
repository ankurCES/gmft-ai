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

import { nmapTool } from '../../src/network/nmap';
import { run } from '../../src/shared/runner';
import * as fs from 'node:fs';
import * as path from 'node:path';

const xmlFixture = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'nmap-sample.xml'),
  'utf8',
);

describe('nmapTool', () => {
  beforeEach(() => {
    vi.mocked(run).mockReset();
    vi.mocked(run).mockResolvedValue({
      exitCode: 0,
      stdout: xmlFixture,
      stderr: '',
      durationMs: 100,
      mode: 'docker',
      fellBack: false,
    });
  });

  it('has the right metadata', () => {
    expect(nmapTool.name).toBe('nmap');
    expect(nmapTool.category).toBe('recon');
    expect(nmapTool.flags).toContain('targetRequired');
  });

  it('parses nmap XML into hosts + findings', async () => {
    const out = await nmapTool.run({ target: 'scanme.nmap.org' });
    expect(out.hosts).toHaveLength(1);
    expect(out.hosts[0].address).toBe('45.33.32.156');
    expect(out.hosts[0].hostname).toBe('scanme.nmap.org');
    expect(out.hosts[0].ports).toHaveLength(3);

    const ssh = out.findings.find((f) => f.title.includes('22/tcp'));
    expect(ssh).toBeDefined();
    expect(ssh!.severity).toBe('medium');
    expect(ssh!.evidence).toContain('ssh');
    expect(out.xml).toBe(xmlFixture);
    expect(out.durationMs).toBeGreaterThanOrEqual(0);
    expect(out.mode).toBe('docker');
  });

  it('emits one finding per open port', async () => {
    const out = await nmapTool.run({ target: 'scanme.nmap.org' });
    const open = out.findings.filter((f) => f.title.includes('open'));
    expect(open).toHaveLength(2); // 22 and 80 are open; 443 is closed
  });

  it('forwards the target to nmap and uses gmft/network:0.1 image', async () => {
    await nmapTool.run({ target: 'scanme.nmap.org', ports: '22,80', timing: 5 });
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        argv: expect.arrayContaining([
          'nmap',
          '-oX',
          '-',
          '-p',
          '22,80',
          '-T5',
          'scanme.nmap.org',
        ]),
        image: 'gmft/network:0.1',
      }),
    );
  });

  // v0.1 phase 6 — D.4 wires nmap into scope mode. The flag
  // gates the executor's `executeWithScope` (refuses to fan out
  // tools that haven't opted in) so we pin it down here.
  it('declares targetsFromFile: true so executeWithScope can fan it out', () => {
    expect(nmapTool.targetsFromFile).toBe(true);
  });
});
