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

import { enum4linuxTool, parseEnum4linuxOutput, enum4linuxFindings } from '../../src/network/enum4linux.js';
import { run } from '../../src/shared/runner.js';

const SAMPLE_OUTPUT = [
  'Starting enum4linux v0.8.9',
  ' =========================',
  '|    Target    |  10.0.0.1  |',
  ' =========================',
  '',
  'Users on 10.0.0.1',
  '===============',
  'user:[Administrator] rid:[0x1f4]',
  'user:[admin] rid:[0x1f5]',
  'user:[guest] rid:[0x1f6]',
  '',
  'Share Enumeration on 10.0.0.1',
  '=============================',
  'Sharename       Type      Comment',
  '---------       ----      -------',
  'ADMIN$          Disk      Remote Admin',
  'C$              Disk      Default share',
  'IPC$            IPC       Remote IPC',
  'Users           Disk      Home folders',
  '',
  'Groups on 10.0.0.1',
  '=================',
  'group:[Domain Admins] rid:[0x200]',
  'group:[Domain Users] rid:[0x201]',
  '',
  'OS information on 10.0.0.1',
  '==========================',
  'OS: Windows 10.0 Build 19041',
  '',
  '[+] Done',
].join('\n');

describe('enum4linux input schema', () => {
  it('requires target', () => {
    const r = enum4linuxTool.input.safeParse({});
    expect(r.success).toBe(false);
  });

  it('defaults timeout to 10', () => {
    const r = enum4linuxTool.input.safeParse({ target: '10.0.0.1' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.timeout).toBe(10);
    }
  });

  it('accepts credentials and a custom timeout', () => {
    const r = enum4linuxTool.input.safeParse({
      target: '10.0.0.1',
      username: 'admin',
      password: 'pass',
      timeout: 30,
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.username).toBe('admin');
      expect(r.data.password).toBe('pass');
      expect(r.data.timeout).toBe(30);
    }
  });

  it('rejects timeout > 60', () => {
    const r = enum4linuxTool.input.safeParse({ target: '10.0.0.1', timeout: 120 });
    expect(r.success).toBe(false);
  });

  it('rejects non-positive timeout', () => {
    const r = enum4linuxTool.input.safeParse({ target: '10.0.0.1', timeout: 0 });
    expect(r.success).toBe(false);
  });
});

describe('enum4linux argv construction', () => {
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
    await enum4linuxTool.run({ target: '10.0.0.1' });
    const opts = vi.mocked(run).mock.calls[0]![0]!;
    expect(opts.argv[0]).toBe('enum4linux');
    expect(opts.argv).toContain('-a');
    expect(opts.argv).toContain('-t');
    expect(opts.argv).toContain('10');
    expect(opts.argv[opts.argv.length - 1]).toBe('10.0.0.1');
    expect(opts.argv).not.toContain('-u');
    expect(opts.argv).not.toContain('-p');
    expect(opts.image).toBe('gmft/network:0.3');
    expect(opts.timeoutMs).toBeGreaterThanOrEqual(60_000);
  });

  it('includes -u and -p when credentials are set', async () => {
    await enum4linuxTool.run({ target: '10.0.0.1', username: 'admin', password: 'pass' });
    const opts = vi.mocked(run).mock.calls[0]![0]!;
    expect(opts.argv).toContain('-u');
    expect(opts.argv).toContain('admin');
    expect(opts.argv).toContain('-p');
    expect(opts.argv).toContain('pass');
  });
});

describe('parseEnum4linuxOutput', () => {
  it('returns empty arrays and empty raw for empty input', () => {
    const r = parseEnum4linuxOutput('');
    expect(r.users).toEqual([]);
    expect(r.shares).toEqual([]);
    expect(r.groups).toEqual([]);
    expect(r.os).toBeUndefined();
    expect(r.raw).toBe('');
  });

  it('parses a classic enum4linux sample', () => {
    const r = parseEnum4linuxOutput(SAMPLE_OUTPUT);
    expect(r.users).toEqual(['Administrator', 'admin', 'guest']);
    expect(r.shares).toEqual(['ADMIN$', 'C$', 'IPC$', 'Users']);
    expect(r.groups).toEqual(['Domain Admins', 'Domain Users']);
    expect(r.os).toBe('Windows 10.0 Build 19041');
  });

  it('parses enum4linux-ng style output', () => {
    const ngOutput = [
      'Users on 10.0.0.1',
      '===============',
      'user:alice',
      'user:bob',
      'Share Enumeration on 10.0.0.1',
      '=============================',
      'Sharename       Type      Comment',
      'BACKUP          Disk      Backup share',
      'PRINT$          Disk      Printer drivers',
      'OS information on 10.0.0.1',
      '==========================',
      'OS details: Microsoft Windows Server 2019',
    ].join('\n');
    const r = parseEnum4linuxOutput(ngOutput);
    expect(r.users).toEqual(['alice', 'bob']);
    expect(r.shares).toEqual(['BACKUP', 'PRINT$']);
    expect(r.os).toBe('Microsoft Windows Server 2019');
  });

  it('dedupes users, shares, and groups', () => {
    const dup = [
      'Users on 10.0.0.1',
      '===============',
      'user:admin',
      'user:admin',
      'user:guest',
    ].join('\n');
    const r = parseEnum4linuxOutput(dup);
    expect(r.users).toEqual(['admin', 'guest']);
  });

  it('preserves the full raw text', () => {
    const r = parseEnum4linuxOutput(SAMPLE_OUTPUT);
    expect(r.raw).toBe(SAMPLE_OUTPUT);
  });

  it('handles missing sections gracefully', () => {
    const partial = 'OS information on 10.0.0.1\n==========================\nOS: Linux 5.4\n';
    const r = parseEnum4linuxOutput(partial);
    expect(r.os).toBe('Linux 5.4');
    expect(r.users).toEqual([]);
    expect(r.shares).toEqual([]);
    expect(r.groups).toEqual([]);
  });
});

describe('enum4linuxFindings', () => {
  it('emits one Finding per user with medium severity', () => {
    const r = parseEnum4linuxOutput(SAMPLE_OUTPUT);
    const findings = enum4linuxFindings(r, '10.0.0.1');
    const userFindings = findings.filter((f) => f.title.startsWith('SMB user:'));
    expect(userFindings).toHaveLength(3);
    for (const f of userFindings) {
      expect(f.tool).toBe('enum4linux');
      expect(f.target).toBe('10.0.0.1');
      expect(f.severity).toBe('medium');
    }
  });

  it('marks admin shares (ADMIN$, C$, IPC$) as high severity', () => {
    const r = parseEnum4linuxOutput(SAMPLE_OUTPUT);
    const findings = enum4linuxFindings(r, '10.0.0.1');
    const adminShare = findings.find((f) => f.evidence === 'ADMIN$');
    const normalShare = findings.find((f) => f.evidence === 'Users');
    expect(adminShare).toBeDefined();
    expect(adminShare!.severity).toBe('high');
    expect(adminShare!.title).toBe('Admin SMB share: ADMIN$');
    expect(normalShare).toBeDefined();
    expect(normalShare!.severity).toBe('medium');
    expect(normalShare!.title).toBe('SMB share: Users');
  });

  it('emits one Finding per group with low severity', () => {
    const r = parseEnum4linuxOutput(SAMPLE_OUTPUT);
    const findings = enum4linuxFindings(r, '10.0.0.1');
    const groupFindings = findings.filter((f) => f.title.startsWith('SMB group:'));
    expect(groupFindings).toHaveLength(2);
    for (const f of groupFindings) {
      expect(f.severity).toBe('low');
    }
  });

  it('uses a target-derived slug in the id', () => {
    const r = parseEnum4linuxOutput(SAMPLE_OUTPUT);
    const findings = enum4linuxFindings(r, '10.0.0.1');
    const userFinding = findings.find((f) => f.title === 'SMB user: admin');
    expect(userFinding).toBeDefined();
    expect(userFinding!.id).toMatch(/^enum4linux-user-10\.0\.0\.1-admin-\d+$/);
  });

  it('returns no findings for an empty result set', () => {
    const findings = enum4linuxFindings(
      { users: [], shares: [], groups: [], raw: '' },
      '10.0.0.1',
    );
    expect(findings).toEqual([]);
  });
});

describe('enum4linux run envelope', () => {
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

  it('returns the standard envelope with users, shares, groups, and findings', async () => {
    const out = await enum4linuxTool.run({ target: '10.0.0.1' });
    expect(out.users).toHaveLength(3);
    expect(out.shares).toHaveLength(4);
    expect(out.groups).toHaveLength(2);
    expect(out.os).toBe('Windows 10.0 Build 19041');
    // 3 users + 4 shares + 2 groups = 9 findings
    expect(out.findings).toHaveLength(9);
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
    const out = await enum4linuxTool.run({ target: '10.0.0.1' });
    expect(out.fellBack).toBe(true);
    expect(out.mode).toBe('host+landlock');
  });
});

describe('enum4linux tool metadata', () => {
  it('has the right name, category, flags, and targetsFromFile', () => {
    expect(enum4linuxTool.name).toBe('enum4linux');
    expect(enum4linuxTool.category).toBe('recon');
    expect(enum4linuxTool.flags).toContain('targetRequired');
    expect(enum4linuxTool.targetsFromFile).toBe(true);
  });
});
