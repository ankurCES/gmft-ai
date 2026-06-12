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

import { masscanTool, parseMasscanOutput, masscanFindings } from '../../src/network/masscan.js';
import { run } from '../../src/shared/runner.js';

const SAMPLE_PORTS = [
  'Starting masscan 1.0.6',
  'Discovered open port 80/tcp on 10.0.0.1',
  'Discovered open port 443/tcp on 10.0.0.1',
  'Discovered open port 22/tcp on 10.0.0.2',
  'Discovered open port 53/udp on 10.0.0.1',
].join('\n');

describe('masscan input schema', () => {
  it('requires target', () => {
    const r = masscanTool.input.safeParse({ ports: '80', rate: 1000 });
    expect(r.success).toBe(false);
  });

  it('requires ports', () => {
    const r = masscanTool.input.safeParse({ target: '10.0.0.0/24', rate: 1000 });
    expect(r.success).toBe(false);
  });

  it('requires rate (positive integer)', () => {
    const r1 = masscanTool.input.safeParse({ target: '10.0.0.0/24', ports: '0-65535' });
    expect(r1.success).toBe(false);
    const r2 = masscanTool.input.safeParse({
      target: '10.0.0.0/24',
      ports: '0-65535',
      rate: -1,
    });
    expect(r2.success).toBe(false);
    const r3 = masscanTool.input.safeParse({
      target: '10.0.0.0/24',
      ports: '0-65535',
      rate: 1.5,
    });
    expect(r3.success).toBe(false);
  });

  it('accepts a valid payload', () => {
    const r = masscanTool.input.safeParse({
      target: '10.0.0.0/24',
      ports: '0-65535',
      rate: 1000,
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.target).toBe('10.0.0.0/24');
      expect(r.data.rate).toBe(1000);
    }
  });
});

describe('masscan argv construction', () => {
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
    await masscanTool.run({ target: '10.0.0.0/24', ports: '80,443', rate: 5000 });
    const opts = vi.mocked(run).mock.calls[0]![0]!;
    expect(opts.argv[0]).toBe('masscan');
    expect(opts.argv).toContain('-p');
    expect(opts.argv).toContain('80,443');
    expect(opts.argv).toContain('--rate');
    expect(opts.argv).toContain('5000');
    expect(opts.argv).toContain('-oL');
    expect(opts.argv).toContain('-');
    expect(opts.argv).toContain('10.0.0.0/24');
    expect(opts.image).toBe('gmft/network:0.3');
    expect(opts.timeoutMs).toBeGreaterThanOrEqual(60_000);
  });
});

describe('parseMasscanOutput', () => {
  it('returns no ports for empty input', () => {
    expect(parseMasscanOutput('').openPorts).toEqual([]);
    expect(parseMasscanOutput('').count).toBe(0);
  });

  it('returns no ports for whitespace-only input', () => {
    expect(parseMasscanOutput('\n\n  \n').openPorts).toEqual([]);
  });

  it('parses a single open TCP port', () => {
    const r = parseMasscanOutput('Discovered open port 80/tcp on 10.0.0.1\n');
    expect(r.openPorts).toEqual([{ port: 80, protocol: 'tcp', ip: '10.0.0.1' }]);
    expect(r.count).toBe(1);
  });

  it('parses multiple open ports across hosts', () => {
    const r = parseMasscanOutput(SAMPLE_PORTS);
    expect(r.openPorts).toHaveLength(4);
    expect(r.count).toBe(4);
    expect(r.openPorts[0]).toEqual({ port: 80, protocol: 'tcp', ip: '10.0.0.1' });
    expect(r.openPorts[3]).toEqual({ port: 53, protocol: 'udp', ip: '10.0.0.1' });
  });

  it('parses UDP ports', () => {
    const r = parseMasscanOutput('Discovered open port 53/udp on 10.0.0.1\n');
    expect(r.openPorts[0]).toEqual({ port: 53, protocol: 'udp', ip: '10.0.0.1' });
  });

  it('ignores banner / non-port lines', () => {
    const sample = [
      'Starting masscan 1.0.6',
      'rate:  1000.00-kpps,',
      'Discovered open port 80/tcp on 10.0.0.1',
    ].join('\n');
    const r = parseMasscanOutput(sample);
    expect(r.openPorts).toHaveLength(1);
  });
});

describe('masscanFindings', () => {
  it('emits one Finding per open port', () => {
    const r = parseMasscanOutput(SAMPLE_PORTS);
    const findings = masscanFindings(r, '10.0.0.0/24');
    expect(findings).toHaveLength(4);
    for (const f of findings) {
      expect(f.tool).toBe('masscan');
      expect(f.target).toBe('10.0.0.0/24');
      expect(f.severity).toBe('medium');
    }
  });

  it('uses a target-derived slug in the id', () => {
    const r = parseMasscanOutput('Discovered open port 80/tcp on 10.0.0.1\n');
    const findings = masscanFindings(r, '10.0.0.0/24');
    // Dots are kept in the slug; only non [a-zA-Z0-9.-] chars become '-'
    expect(findings[0]!.id).toMatch(/^masscan-10\.0\.0\.0-24-80-tcp-0-\d+$/);
  });

  it('includes the ip:port/proto in the title and evidence when ip is present', () => {
    const r = parseMasscanOutput('Discovered open port 443/tcp on 10.0.0.1\n');
    const findings = masscanFindings(r, '10.0.0.0/24');
    expect(findings[0]!.title).toBe('Open TCP port 443 on 10.0.0.1');
    expect(findings[0]!.evidence).toBe('10.0.0.1:443/tcp');
  });

  it('returns no findings for an empty scan', () => {
    const findings = masscanFindings({ openPorts: [], count: 0 }, '10.0.0.0/24');
    expect(findings).toEqual([]);
  });
});

describe('masscan run envelope', () => {
  beforeEach(() => {
    vi.mocked(run).mockReset();
    vi.mocked(run).mockResolvedValue({
      exitCode: 0,
      stdout: SAMPLE_PORTS,
      stderr: '',
      durationMs: 50,
      mode: 'docker',
      fellBack: false,
    });
  });

  it('returns the standard envelope with openPorts and findings', async () => {
    const out = await masscanTool.run({
      target: '10.0.0.0/24',
      ports: '80',
      rate: 1000,
    });
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
    const out = await masscanTool.run({
      target: '10.0.0.0/24',
      ports: '80',
      rate: 1000,
    });
    expect(out.fellBack).toBe(true);
    expect(out.mode).toBe('host+landlock');
  });
});

describe('masscan tool metadata', () => {
  it('has the right name, category, flags, and targetsFromFile', () => {
    expect(masscanTool.name).toBe('masscan');
    expect(masscanTool.category).toBe('recon');
    expect(masscanTool.flags).toContain('targetRequired');
    expect(masscanTool.targetsFromFile).toBe(true);
  });
});
