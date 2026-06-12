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

import { rustscanTool, parseRustscanOutput, rustscanFindings } from '../../src/network/rustscan.js';
import { run } from '../../src/shared/runner.js';

const SAMPLE_GREPPABLE = [
  JSON.stringify({
    ip: '10.0.0.1',
    ports: [
      { portid: '80', service: 'http' },
      { portid: '443', service: 'https' },
    ],
  }),
  JSON.stringify({
    ip: '10.0.0.2',
    ports: [{ portid: '22', service: 'ssh' }, 3306],
  }),
].join('\n');

describe('rustscan input schema', () => {
  it('requires target', () => {
    const r = rustscanTool.input.safeParse({});
    expect(r.success).toBe(false);
  });

  it('defaults ports to 1-65535 and ulimit to 5000', () => {
    const r = rustscanTool.input.safeParse({ target: '10.0.0.0/24' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.ports).toBe('1-65535');
      expect(r.data.ulimit).toBe(5000);
    }
  });

  it('accepts custom ports and ulimit', () => {
    const r = rustscanTool.input.safeParse({
      target: '10.0.0.0/24',
      ports: '80,443',
      ulimit: 1000,
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.ports).toBe('80,443');
      expect(r.data.ulimit).toBe(1000);
    }
  });

  it('rejects non-positive ulimit', () => {
    const r = rustscanTool.input.safeParse({ target: '10.0.0.0/24', ulimit: 0 });
    expect(r.success).toBe(false);
  });
});

describe('rustscan argv construction', () => {
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
    await rustscanTool.run({ target: '10.0.0.1', ports: '80,443', ulimit: 1000 });
    const opts = vi.mocked(run).mock.calls[0]![0]!;
    expect(opts.argv[0]).toBe('rustscan');
    expect(opts.argv).toContain('-a');
    expect(opts.argv).toContain('10.0.0.1');
    expect(opts.argv).toContain('-r');
    expect(opts.argv).toContain('80,443');
    expect(opts.argv).toContain('--ulimit');
    expect(opts.argv).toContain('1000');
    expect(opts.argv).toContain('-g');
    expect(opts.image).toBe('gmft/network:0.3');
    expect(opts.timeoutMs).toBeGreaterThanOrEqual(60_000);
  });
});

describe('parseRustscanOutput', () => {
  it('returns no ports for empty input', () => {
    expect(parseRustscanOutput('').openPorts).toEqual([]);
    expect(parseRustscanOutput('').count).toBe(0);
  });

  it('parses greppable JSON with structured port objects', () => {
    const r = parseRustscanOutput(SAMPLE_GREPPABLE);
    expect(r.openPorts).toHaveLength(4);
    expect(r.count).toBe(4);
    expect(r.openPorts[0]).toEqual({ port: 80, ip: '10.0.0.1', service: 'http' });
    expect(r.openPorts[2]).toEqual({ port: 22, ip: '10.0.0.2', service: 'ssh' });
    expect(r.openPorts[3]).toEqual({ port: 3306, ip: '10.0.0.2' });
  });

  it('handles plain-string port arrays', () => {
    const r = parseRustscanOutput(JSON.stringify({ ports: ['80', '443'] }));
    expect(r.openPorts).toEqual([{ port: 80 }, { port: 443 }]);
  });

  it('ignores non-JSON and non-object lines', () => {
    const r = parseRustscanOutput(
      [
        'not json',
        JSON.stringify({ ports: ['22'] }),
        '{broken json',
        '',
      ].join('\n'),
    );
    expect(r.openPorts).toEqual([{ port: 22 }]);
  });

  it('ignores entries with non-integer or out-of-range ports', () => {
    const r = parseRustscanOutput(
      JSON.stringify({
        ports: [
          { portid: '99999' },  // out of range
          { portid: '0' },      // not positive
          { portid: 'abc' },    // NaN
          { portid: '80' },     // valid
        ],
      }),
    );
    expect(r.openPorts).toEqual([{ port: 80 }]);
  });

  it('skips records that have no ports field', () => {
    const r = parseRustscanOutput(JSON.stringify({ ip: '10.0.0.1' }));
    expect(r.openPorts).toEqual([]);
  });
});

describe('rustscanFindings', () => {
  it('emits one Finding per open port', () => {
    const r = parseRustscanOutput(SAMPLE_GREPPABLE);
    const findings = rustscanFindings(r, '10.0.0.0/24');
    expect(findings).toHaveLength(4);
    for (const f of findings) {
      expect(f.tool).toBe('rustscan');
      expect(f.target).toBe('10.0.0.0/24');
      expect(f.severity).toBe('medium');
    }
  });

  it('uses a target-derived slug in the id', () => {
    const r = parseRustscanOutput(JSON.stringify({ ports: [{ portid: '80' }] }));
    const findings = rustscanFindings(r, '10.0.0.0/24');
    expect(findings[0]!.id).toMatch(/^rustscan-10\.0\.0\.0-24-80-0-\d+$/);
  });

  it('includes the service name in the title when present', () => {
    const r = parseRustscanOutput(
      JSON.stringify({ ports: [{ portid: '443', service: 'https' }] }),
    );
    const findings = rustscanFindings(r, '10.0.0.1');
    expect(findings[0]!.title).toBe('Open port 443 (https)');
  });

  it('returns no findings for an empty scan', () => {
    const findings = rustscanFindings({ openPorts: [], count: 0 }, '10.0.0.0/24');
    expect(findings).toEqual([]);
  });
});

describe('rustscan run envelope', () => {
  beforeEach(() => {
    vi.mocked(run).mockReset();
    vi.mocked(run).mockResolvedValue({
      exitCode: 0,
      stdout: SAMPLE_GREPPABLE,
      stderr: '',
      durationMs: 50,
      mode: 'docker',
      fellBack: false,
    });
  });

  it('returns the standard envelope with openPorts and findings', async () => {
    const out = await rustscanTool.run({ target: '10.0.0.0/24' });
    expect(out.openPorts).toHaveLength(4);
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
    const out = await rustscanTool.run({ target: '10.0.0.0/24' });
    expect(out.fellBack).toBe(true);
    expect(out.mode).toBe('host+landlock');
  });
});

describe('rustscan tool metadata', () => {
  it('has the right name, category, flags, and targetsFromFile', () => {
    expect(rustscanTool.name).toBe('rustscan');
    expect(rustscanTool.category).toBe('recon');
    expect(rustscanTool.flags).toContain('targetRequired');
    expect(rustscanTool.targetsFromFile).toBe(true);
  });
});
