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

import { dnsreconTool, parseDnsreconOutput, dnsreconFindings } from '../../src/network/dnsrecon.js';
import { run } from '../../src/shared/runner.js';

const SAMPLE_OUTPUT = [
  '[*] Performing General Lookups',
  '[*] Starting DNS Enumeration',
  '[A] example.com 93.184.216.34',
  '[AAAA] example.com 2606:2800:220:1:248:1893:25c8:1946',
  '[NS] example.com ns1.example.com',
  '[MX] example.com 10 mail.example.com',
  '[TXT] example.com v=spf1 -all',
  '[SOA] example.com ns1.example.com admin.example.com 2024010101 7200 3600 1209600 3600',
  '',
  '[*] 7 records found',
].join('\n');

describe('dnsrecon input schema', () => {
  it('requires domain', () => {
    const r = dnsreconTool.input.safeParse({});
    expect(r.success).toBe(false);
  });

  it('defaults type to std', () => {
    const r = dnsreconTool.input.safeParse({ domain: 'example.com' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.type).toBe('std');
    }
  });

  it('accepts custom type and nameserver', () => {
    const r = dnsreconTool.input.safeParse({
      domain: 'example.com',
      type: 'axfr',
      nameserver: '1.1.1.1',
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.type).toBe('axfr');
      expect(r.data.nameserver).toBe('1.1.1.1');
    }
  });

  it('rejects invalid type', () => {
    const r = dnsreconTool.input.safeParse({ domain: 'example.com', type: 'nope' });
    expect(r.success).toBe(false);
  });
});

describe('dnsrecon argv construction', () => {
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
    await dnsreconTool.run({ domain: 'example.com' });
    const opts = vi.mocked(run).mock.calls[0]![0]!;
    expect(opts.argv[0]).toBe('dnsrecon');
    expect(opts.argv).toContain('-d');
    expect(opts.argv).toContain('example.com');
    expect(opts.argv).toContain('-t');
    expect(opts.argv).toContain('std');
    expect(opts.argv).not.toContain('-n');
    expect(opts.image).toBe('gmft/network:0.3');
    expect(opts.timeoutMs).toBeGreaterThanOrEqual(60_000);
  });

  it('includes -n when nameserver is set', async () => {
    await dnsreconTool.run({ domain: 'example.com', nameserver: '8.8.8.8' });
    const opts = vi.mocked(run).mock.calls[0]![0]!;
    expect(opts.argv).toContain('-n');
    expect(opts.argv).toContain('8.8.8.8');
  });
});

describe('parseDnsreconOutput', () => {
  it('returns no records for empty input', () => {
    expect(parseDnsreconOutput('').records).toEqual([]);
    expect(parseDnsreconOutput('').count).toBe(0);
  });

  it('parses bracketed-type records', () => {
    const r = parseDnsreconOutput(SAMPLE_OUTPUT);
    // 6 actual records (A, AAAA, NS, MX, TXT, SOA). The footer
    // "[*] 7 records found" is decorative and intentionally skipped.
    expect(r.count).toBe(6);
    expect(r.records[0]).toEqual({ type: 'A', name: 'example.com', value: '93.184.216.34' });
    expect(r.records[1]).toEqual({ type: 'AAAA', name: 'example.com', value: '2606:2800:220:1:248:1893:25c8:1946' });
  });

  it('parses the SOA record with multi-token value', () => {
    const r = parseDnsreconOutput(SAMPLE_OUTPUT);
    const soa = r.records.find((x) => x.type === 'SOA');
    expect(soa).toBeDefined();
    expect(soa!.name).toBe('example.com');
    expect(soa!.value).toContain('ns1.example.com');
  });

  it('parses bare-type records (A example.com 1.2.3.4)', () => {
    const r = parseDnsreconOutput('A example.com 1.2.3.4\nNS example.com ns1.example.com');
    expect(r.records).toEqual([
      { type: 'A', name: 'example.com', value: '1.2.3.4' },
      { type: 'NS', name: 'example.com', value: 'ns1.example.com' },
    ]);
  });

  it('ignores banner / progress / footer lines', () => {
    const r = parseDnsreconOutput(SAMPLE_OUTPUT);
    for (const rec of r.records) {
      expect(rec.value).not.toMatch(/^\[.\]/);
      expect(rec.value).not.toMatch(/^Performing/);
    }
  });

  it('skips separator and summary lines', () => {
    const r = parseDnsreconOutput('[*] banner\n---\nA example.com 1.2.3.4\n[*] 1 records found\n');
    expect(r.records).toEqual([{ type: 'A', name: 'example.com', value: '1.2.3.4' }]);
  });
});

describe('dnsreconFindings', () => {
  it('emits one Finding per record', () => {
    const r = parseDnsreconOutput(SAMPLE_OUTPUT);
    const findings = dnsreconFindings(r, 'example.com');
    expect(findings).toHaveLength(6);
    for (const f of findings) {
      expect(f.tool).toBe('dnsrecon');
      expect(f.target).toBe('example.com');
    }
  });

  it('uses high severity for SOA and NS', () => {
    const r = parseDnsreconOutput('[NS] example.com ns1.example.com\n[SOA] example.com ns1.example.com admin');
    const findings = dnsreconFindings(r, 'example.com');
    expect(findings[0]!.severity).toBe('high');
    expect(findings[1]!.severity).toBe('high');
  });

  it('uses medium severity for A, AAAA, CNAME', () => {
    const r = parseDnsreconOutput(
      '[A] example.com 1.2.3.4\n[AAAA] example.com ::1\n[CNAME] alias.example.com target.example.com',
    );
    const findings = dnsreconFindings(r, 'example.com');
    for (const f of findings) {
      expect(f.severity).toBe('medium');
    }
  });

  it('uses info severity for MX, TXT, and other types', () => {
    const r = parseDnsreconOutput('[MX] example.com 10 mail\n[TXT] example.com v=spf1 -all');
    const findings = dnsreconFindings(r, 'example.com');
    for (const f of findings) {
      expect(f.severity).toBe('info');
    }
  });

  it('uses a target-derived slug in the id', () => {
    const r = parseDnsreconOutput('[A] example.com 1.2.3.4');
    const findings = dnsreconFindings(r, 'example.com');
    expect(findings[0]!.id).toMatch(/^dnsrecon-example\.com-A-0-\d+$/);
  });

  it('returns no findings for an empty result set', () => {
    const findings = dnsreconFindings({ records: [], count: 0 }, 'example.com');
    expect(findings).toEqual([]);
  });
});

describe('dnsrecon run envelope', () => {
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

  it('returns the standard envelope with records and findings', async () => {
    const out = await dnsreconTool.run({ domain: 'example.com' });
    expect(out.records).toHaveLength(6);
    expect(out.count).toBe(6);
    expect(out.findings).toHaveLength(6);
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
    const out = await dnsreconTool.run({ domain: 'example.com' });
    expect(out.fellBack).toBe(true);
    expect(out.mode).toBe('host+landlock');
  });
});

describe('dnsrecon tool metadata', () => {
  it('has the right name, category, flags, and targetsFromFile', () => {
    expect(dnsreconTool.name).toBe('dnsrecon');
    expect(dnsreconTool.category).toBe('recon');
    expect(dnsreconTool.flags).toContain('targetRequired');
    expect(dnsreconTool.targetsFromFile).toBe(true);
  });
});
