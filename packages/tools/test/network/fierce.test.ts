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

import { fierceTool, parseFierceOutput, fierceFindings } from '../../src/network/fierce.js';
import { run } from '../../src/shared/runner.js';

const SAMPLE_OUTPUT = [
  'Now performing 1895 test(s) for example.com',
  'Zone: example.com',
  'NS: ns1.example.com',
  'Wildcard: not found',
  'Found: www.example.com -> 93.184.216.34',
  'Found: mail.example.com -> 93.184.216.40',
  'Found: ftp.example.com',
  'Done',
].join('\n');

describe('fierce input schema', () => {
  it('requires domain', () => {
    const r = fierceTool.input.safeParse({});
    expect(r.success).toBe(false);
  });

  it('defaults delay to 0', () => {
    const r = fierceTool.input.safeParse({ domain: 'example.com' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.delay).toBe(0);
    }
  });

  it('accepts nameserver and wordlist', () => {
    const r = fierceTool.input.safeParse({
      domain: 'example.com',
      nameserver: '1.1.1.1',
      wordlist: '/usr/share/wordlist.txt',
      delay: 2,
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.nameserver).toBe('1.1.1.1');
      expect(r.data.wordlist).toBe('/usr/share/wordlist.txt');
      expect(r.data.delay).toBe(2);
    }
  });

  it('rejects delay > 10', () => {
    const r = fierceTool.input.safeParse({ domain: 'example.com', delay: 20 });
    expect(r.success).toBe(false);
  });
});

describe('fierce argv construction', () => {
  beforeEach(() => {
    vi.mocked(run).mockReset();
    vi.mocked(run).mockResolvedValue({
      exitCode: 0,
      stdout: '',
      stderr: '',
      durationMs: 12,
      mode: 'docker',
      fellBack: false,
    });
  });

  it('builds the right argv and uses gmft/network:0.3', async () => {
    await fierceTool.run({ domain: 'example.com' });
    const opts = vi.mocked(run).mock.calls[0]![0]!;
    expect(opts.argv[0]).toBe('fierce');
    expect(opts.argv).toContain('-dns');
    expect(opts.argv).toContain('example.com');
    expect(opts.argv).toContain('-delay');
    expect(opts.argv).toContain('0');
    expect(opts.argv).not.toContain('-dnsserver');
    expect(opts.argv).not.toContain('-wordlist');
    expect(opts.image).toBe('gmft/network:0.3');
    expect(opts.timeoutMs).toBeGreaterThanOrEqual(60_000);
  });

  it('includes -dnsserver when nameserver is set', async () => {
    await fierceTool.run({ domain: 'example.com', nameserver: '8.8.8.8' });
    const opts = vi.mocked(run).mock.calls[0]![0]!;
    expect(opts.argv).toContain('-dnsserver');
    expect(opts.argv).toContain('8.8.8.8');
  });

  it('includes -wordlist when set', async () => {
    await fierceTool.run({ domain: 'example.com', wordlist: '/wordlist.txt' });
    const opts = vi.mocked(run).mock.calls[0]![0]!;
    expect(opts.argv).toContain('-wordlist');
    expect(opts.argv).toContain('/wordlist.txt');
  });
});

describe('parseFierceOutput', () => {
  it('returns no hosts for empty input', () => {
    expect(parseFierceOutput('').hosts).toEqual([]);
    expect(parseFierceOutput('').count).toBe(0);
  });

  it('parses "Found: name -> ip" lines', () => {
    const r = parseFierceOutput('Found: www.example.com -> 93.184.216.34\n');
    expect(r.hosts).toEqual([{ name: 'www.example.com', ip: '93.184.216.34' }]);
  });

  it('parses bare "Found: name" lines (no IP)', () => {
    const r = parseFierceOutput('Found: ftp.example.com\n');
    expect(r.hosts).toEqual([{ name: 'ftp.example.com' }]);
  });

  it('parses a mixed sample', () => {
    const r = parseFierceOutput(SAMPLE_OUTPUT);
    expect(r.count).toBe(3);
    expect(r.hosts[0]).toEqual({ name: 'www.example.com', ip: '93.184.216.34' });
    expect(r.hosts[1]).toEqual({ name: 'mail.example.com', ip: '93.184.216.40' });
    expect(r.hosts[2]).toEqual({ name: 'ftp.example.com' });
  });

  it('ignores banner / progress / section lines', () => {
    const r = parseFierceOutput(SAMPLE_OUTPUT);
    for (const h of r.hosts) {
      expect(h.name).not.toMatch(/^(Now|Zone|NS|Wildcard|Done)$/);
    }
  });
});

describe('fierceFindings', () => {
  it('emits one Finding per host with low severity', () => {
    const r = parseFierceOutput(SAMPLE_OUTPUT);
    const findings = fierceFindings(r, 'example.com');
    expect(findings).toHaveLength(3);
    for (const f of findings) {
      expect(f.tool).toBe('fierce');
      expect(f.target).toBe('example.com');
      expect(f.severity).toBe('low');
    }
  });

  it('includes the IP in the title when present', () => {
    const r = parseFierceOutput('Found: www.example.com -> 1.2.3.4\n');
    const findings = fierceFindings(r, 'example.com');
    expect(findings[0]!.title).toBe('Discovered host: www.example.com -> 1.2.3.4');
    expect(findings[0]!.evidence).toBe('www.example.com -> 1.2.3.4');
  });

  it('omits the IP from the title when not present', () => {
    const r = parseFierceOutput('Found: ftp.example.com\n');
    const findings = fierceFindings(r, 'example.com');
    expect(findings[0]!.title).toBe('Discovered host: ftp.example.com');
    expect(findings[0]!.evidence).toBe('ftp.example.com');
  });

  it('uses a target-derived slug in the id', () => {
    const r = parseFierceOutput('Found: www.example.com -> 1.2.3.4\n');
    const findings = fierceFindings(r, 'example.com');
    expect(findings[0]!.id).toMatch(/^fierce-example\.com-0-\d+$/);
  });

  it('returns no findings for an empty result set', () => {
    const findings = fierceFindings({ hosts: [], count: 0 }, 'example.com');
    expect(findings).toEqual([]);
  });
});

describe('fierce run envelope', () => {
  beforeEach(() => {
    vi.mocked(run).mockReset();
    vi.mocked(run).mockResolvedValue({
      exitCode: 0,
      stdout: SAMPLE_OUTPUT,
      stderr: '',
      durationMs: 50,
      mode: 'docker',
      fellBack: false,
    });
  });

  it('returns the standard envelope with hosts and findings', async () => {
    const out = await fierceTool.run({ domain: 'example.com' });
    expect(out.hosts).toHaveLength(3);
    expect(out.count).toBe(3);
    expect(out.findings).toHaveLength(3);
    expect(out.durationMs).toBe(50);
    expect(out.mode).toBe('docker');
    expect(out.fellBack).toBe(false);
  });

  it('propagates fellBack from the runner', async () => {
    vi.mocked(run).mockResolvedValue({
      exitCode: 0,
      stdout: '',
      stderr: '',
      durationMs: 0,
      mode: 'host+landlock',
      fellBack: true,
    });
    const out = await fierceTool.run({ domain: 'example.com' });
    expect(out.fellBack).toBe(true);
    expect(out.mode).toBe('host+landlock');
  });
});

describe('fierce tool metadata', () => {
  it('has the right name, category, flags, and targetsFromFile', () => {
    expect(fierceTool.name).toBe('fierce');
    expect(fierceTool.category).toBe('recon');
    expect(fierceTool.flags).toContain('targetRequired');
    expect(fierceTool.targetsFromFile).toBe(true);
  });
});
