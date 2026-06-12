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

import { subfinderTool, parseSubfinderOutput, subfinderFindings } from '../../src/network/subfinder.js';
import { run } from '../../src/shared/runner.js';

const SAMPLE_SUBS = [
  'www.example.com',
  'api.example.com',
  'mail.example.com',
  'staging.example.com',
].join('\n');

describe('subfinder input schema', () => {
  it('requires domain', () => {
    const r = subfinderTool.input.safeParse({});
    expect(r.success).toBe(false);
  });

  it('defaults timeout to 30', () => {
    const r = subfinderTool.input.safeParse({ domain: 'example.com' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.timeout).toBe(30);
    }
  });

  it('accepts custom timeout and sources', () => {
    const r = subfinderTool.input.safeParse({
      domain: 'example.com',
      timeout: 10,
      sources: ['crtsh', 'dnsdumpster'],
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.timeout).toBe(10);
      expect(r.data.sources).toEqual(['crtsh', 'dnsdumpster']);
    }
  });

  it('rejects timeout > 60', () => {
    const r = subfinderTool.input.safeParse({ domain: 'example.com', timeout: 120 });
    expect(r.success).toBe(false);
  });

  it('rejects non-positive timeout', () => {
    const r = subfinderTool.input.safeParse({ domain: 'example.com', timeout: 0 });
    expect(r.success).toBe(false);
  });
});

describe('subfinder argv construction', () => {
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

  it('builds the right argv with default timeout and uses gmft/network:0.3', async () => {
    await subfinderTool.run({ domain: 'example.com' });
    const opts = vi.mocked(run).mock.calls[0]![0]!;
    expect(opts.argv[0]).toBe('subfinder');
    expect(opts.argv).toContain('-d');
    expect(opts.argv).toContain('example.com');
    expect(opts.argv).toContain('-timeout');
    expect(opts.argv).toContain('30');
    expect(opts.argv).toContain('-silent');
    expect(opts.argv).toContain('-nW');
    expect(opts.image).toBe('gmft/network:0.3');
    expect(opts.timeoutMs).toBeGreaterThanOrEqual(60_000);
  });

  it('includes -sources when provided', async () => {
    await subfinderTool.run({ domain: 'example.com', sources: ['crtsh', 'rapiddns'] });
    const opts = vi.mocked(run).mock.calls[0]![0]!;
    expect(opts.argv).toContain('-sources');
    expect(opts.argv).toContain('crtsh,rapiddns');
  });

  it('omits -sources when the array is empty', async () => {
    await subfinderTool.run({ domain: 'example.com', sources: [] });
    const opts = vi.mocked(run).mock.calls[0]![0]!;
    expect(opts.argv).not.toContain('-sources');
  });
});

describe('parseSubfinderOutput', () => {
  it('returns no subdomains for empty input', () => {
    expect(parseSubfinderOutput('').subdomains).toEqual([]);
    expect(parseSubfinderOutput('').count).toBe(0);
  });

  it('parses newline-delimited subdomains', () => {
    const r = parseSubfinderOutput(SAMPLE_SUBS);
    expect(r.subdomains).toEqual([
      'www.example.com',
      'api.example.com',
      'mail.example.com',
      'staging.example.com',
    ]);
    expect(r.count).toBe(4);
  });

  it('trims whitespace from each line', () => {
    const r = parseSubfinderOutput('  www.example.com  \n\tapi.example.com\n');
    expect(r.subdomains).toEqual(['www.example.com', 'api.example.com']);
  });

  it('skips blank lines', () => {
    const r = parseSubfinderOutput('www.example.com\n\n\napi.example.com\n\n');
    expect(r.subdomains).toEqual(['www.example.com', 'api.example.com']);
  });

  it('ignores banner-style lines that leak through without -silent', () => {
    const r = parseSubfinderOutput(
      ['[INF] Current subfinder version', 'www.example.com', 'Starting...'].join('\n'),
    );
    expect(r.subdomains).toEqual(['www.example.com']);
  });
});

describe('subfinderFindings', () => {
  it('emits one Finding per subdomain with info severity', () => {
    const r = parseSubfinderOutput(SAMPLE_SUBS);
    const findings = subfinderFindings(r, 'example.com');
    expect(findings).toHaveLength(4);
    for (const f of findings) {
      expect(f.tool).toBe('subfinder');
      expect(f.target).toBe('example.com');
      expect(f.severity).toBe('info');
      expect(f.title).toContain('Subdomain discovered');
    }
  });

  it('uses a target-derived slug in the id', () => {
    const r = parseSubfinderOutput('www.example.com');
    const findings = subfinderFindings(r, 'example.com');
    expect(findings[0]!.id).toMatch(/^subfinder-example\.com-0-\d+$/);
  });

  it('returns no findings for an empty result set', () => {
    const findings = subfinderFindings({ subdomains: [], count: 0 }, 'example.com');
    expect(findings).toEqual([]);
  });
});

describe('subfinder run envelope', () => {
  beforeEach(() => {
    vi.mocked(run).mockReset();
    vi.mocked(run).mockResolvedValue({
      exitCode: 0,
      stdout: SAMPLE_SUBS,
      stderr: '',
      durationMs: 50,
      mode: 'docker',
      fellBack: false,
    });
  });

  it('returns the standard envelope with subdomains and findings', async () => {
    const out = await subfinderTool.run({ domain: 'example.com' });
    expect(out.subdomains).toHaveLength(4);
    expect(out.count).toBe(4);
    expect(out.findings).toHaveLength(4);
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
    const out = await subfinderTool.run({ domain: 'example.com' });
    expect(out.fellBack).toBe(true);
    expect(out.mode).toBe('host+landlock');
  });
});

describe('subfinder tool metadata', () => {
  it('has the right name, category, flags, and targetsFromFile', () => {
    expect(subfinderTool.name).toBe('subfinder');
    expect(subfinderTool.category).toBe('recon');
    expect(subfinderTool.flags).toContain('targetRequired');
    expect(subfinderTool.targetsFromFile).toBe(true);
  });
});
