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

import { ldapsearchTool, parseLdapsearchLdif, ldapsearchFindings } from '../../src/network/ldapsearch.js';
import { run } from '../../src/shared/runner.js';

// A small LDIF fixture that exercises: version line, comment, a single entry
// with one attr, an entry with multiple attrs, a multi-valued attr, and
// multiple entries separated by a blank line.
const SAMPLE_LDIF = [
  'version: 1',
  '',
  '# top-level comment',
  'dn: dc=example,dc=com',
  'objectClass: top',
  'objectClass: domain',
  'dc: example',
  '',
  'dn: ou=people,dc=example,dc=com',
  'objectClass: organizationalUnit',
  'ou: people',
  'description: People org',
  'description: Human resources',
  '',
  'dn: cn=alice,ou=people,dc=example,dc=com',
  'objectClass: person',
  'cn: alice',
  '',
].join('\n');

describe('ldapsearch input schema', () => {
  it('requires host', () => {
    const r = ldapsearchTool.input.safeParse({ baseDN: 'dc=example,dc=com' });
    expect(r.success).toBe(false);
  });

  it('requires baseDN', () => {
    const r = ldapsearchTool.input.safeParse({ host: 'ldap.example.com' });
    expect(r.success).toBe(false);
  });

  it('accepts a valid payload and defaults scope to sub', () => {
    const r = ldapsearchTool.input.safeParse({ host: 'ldap.example.com', baseDN: 'dc=example,dc=com' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.scope).toBe('sub');
    }
  });

  it('rejects an invalid scope', () => {
    const r = ldapsearchTool.input.safeParse({
      host: 'ldap.example.com',
      baseDN: 'dc=example,dc=com',
      scope: 'subtree',
    });
    expect(r.success).toBe(false);
  });
});

describe('ldapsearch argv construction', () => {
  beforeEach(() => {
    vi.mocked(run).mockReset();
    vi.mocked(run).mockResolvedValue({
      exitCode: 0,
      stdout: SAMPLE_LDIF,
      stderr: '',
      durationMs: 100,
      mode: 'docker',
      fellBack: false,
    });
  });

  it('with default scope= sub uses -s sub and -LLL', async () => {
    await ldapsearchTool.run({ host: 'ldap.example.com', baseDN: 'dc=example,dc=com' });
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        argv: expect.arrayContaining(['ldapsearch', '-x', '-H', 'ldap://ldap.example.com', '-b', 'dc=example,dc=com', '-s', 'sub', '-LLL']),
        image: 'gmft/network:0.3',
        timeoutMs: expect.any(Number) as number,
      }),
    );
    const opts = vi.mocked(run).mock.calls[0]![0]!;
    expect(opts.argv[0]).toBe('ldapsearch');
    expect(opts.argv).toContain('-x');
    expect(opts.argv).toContain('-H');
    expect(opts.argv).toContain('ldap://ldap.example.com');
    expect(opts.argv).toContain('-b');
    expect(opts.argv).toContain('dc=example,dc=com');
    expect(opts.argv).toContain('-s');
    expect(opts.argv).toContain('sub');
    expect(opts.argv).toContain('-LLL');
    expect(opts.image).toBe('gmft/network:0.3');
    expect(opts.timeoutMs).toBeGreaterThanOrEqual(60_000);
  });

  it('with scope= base uses -s base', async () => {
    await ldapsearchTool.run({
      host: 'ldap.example.com',
      baseDN: 'dc=example,dc=com',
      scope: 'base',
    });
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        argv: expect.arrayContaining(['-s', 'base']),
        image: 'gmft/network:0.3',
        timeoutMs: expect.any(Number) as number,
      }),
    );
    const opts = vi.mocked(run).mock.calls[0]![0]!;
    expect(opts.argv[0]).toBe('ldapsearch');
    expect(opts.argv).toContain('-x');
    expect(opts.argv).toContain('-H');
    expect(opts.argv).toContain('ldap://ldap.example.com');
    expect(opts.argv).toContain('-b');
    expect(opts.argv).toContain('dc=example,dc=com');
    expect(opts.argv).toContain('-s');
    expect(opts.argv).toContain('base');
    expect(opts.argv).toContain('-LLL');
    expect(opts.image).toBe('gmft/network:0.3');
    expect(opts.timeoutMs).toBeGreaterThanOrEqual(60_000);
  });
});

describe('parseLdapsearchLdif', () => {
  it('returns no entries for empty input', () => {
    expect(parseLdapsearchLdif('').entries).toEqual([]);
  });

  it('parses a single entry with one attribute', () => {
    const ldif = 'dn: dc=example,dc=com\nobjectClass: top\n';
    const { entries } = parseLdapsearchLdif(ldif);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.dn).toBe('dc=example,dc=com');
    expect(entries[0]!.attrs).toEqual({ objectClass: ['top'] });
  });

  it('parses a single entry with multiple attributes', () => {
    const ldif = 'dn: dc=example,dc=com\nobjectClass: top\nobjectClass: domain\ndc: example\n';
    const { entries } = parseLdapsearchLdif(ldif);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.dn).toBe('dc=example,dc=com');
    expect(entries[0]!.attrs).toEqual({
      objectClass: ['top', 'domain'],
      dc: ['example'],
    });
  });

  it('treats repeated attr lines as multi-valued', () => {
    const ldif = 'dn: ou=people,dc=example,dc=com\ndescription: People org\ndescription: HR\n';
    const { entries } = parseLdapsearchLdif(ldif);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.attrs.description).toEqual(['People org', 'HR']);
  });

  it('parses multiple entries separated by blank lines', () => {
    const { entries } = parseLdapsearchLdif(SAMPLE_LDIF);
    expect(entries).toHaveLength(3);
    expect(entries[0]!.dn).toBe('dc=example,dc=com');
    expect(entries[1]!.dn).toBe('ou=people,dc=example,dc=com');
    expect(entries[2]!.dn).toBe('cn=alice,ou=people,dc=example,dc=com');
  });

  it('ignores #-prefixed comments and version: 1 headers', () => {
    const { entries } = parseLdapsearchLdif(SAMPLE_LDIF);
    // version: 1 should not show up as an entry or as an attribute
    for (const e of entries) {
      expect(e.dn.startsWith('version:')).toBe(false);
      expect(e.attrs['version']).toBeUndefined();
    }
  });
});

describe('ldapsearchFindings', () => {
  it('emits one Finding per entry, all with tool= ldapsearch and the host as target', () => {
    const { entries } = parseLdapsearchLdif(SAMPLE_LDIF);
    const findings = ldapsearchFindings({ entries }, 'ldap.example.com');
    expect(findings).toHaveLength(3);
    for (let i = 0; i < findings.length; i++) {
      const f = findings[i]!;
      expect(f.tool).toBe('ldapsearch');
      expect(f.target).toBe('ldap.example.com');
      expect(f.severity).toBe('low');
      expect(f.title).toBe(`LDAP entry: ${entries[i]!.dn}`);
      expect(f.id).toMatch(/^ldapsearch-ldap\.example\.com-\d+-\d+$/);
    }
  });

  it('records the target as the input host, not the DN', () => {
    const { entries } = parseLdapsearchLdif(SAMPLE_LDIF);
    const findings = ldapsearchFindings({ entries }, 'other.host');
    for (const f of findings) {
      expect(f.target).toBe('other.host');
    }
  });

  it('returns no findings for an empty entries list', () => {
    const findings = ldapsearchFindings({ entries: [] }, 'ldap.example.com');
    expect(findings).toEqual([]);
  });
});

describe('ldapsearch run envelope', () => {
  beforeEach(() => {
    vi.mocked(run).mockReset();
    vi.mocked(run).mockResolvedValue({
      exitCode: 0,
      stdout: SAMPLE_LDIF,
      stderr: '',
      durationMs: 100,
      mode: 'docker',
      fellBack: false,
    });
  });

  it('returns the standard envelope with entries and findings', async () => {
    const out = await ldapsearchTool.run({ host: 'ldap.example.com', baseDN: 'dc=example,dc=com' });
    expect(out.entries).toHaveLength(3);
    expect(out.count).toBe(3);
    expect(out.findings).toHaveLength(3);
    expect(out.durationMs).toBe(100);
    expect(out.mode).toBe('docker');
    expect(out.fellBack).toBe(false);
  });

  it('propagates fellBack from the runner', async () => {
    vi.mocked(run).mockResolvedValue({
      exitCode: 0,
      stdout: '',
      stderr: '',
      durationMs: 200,
      mode: 'host',
      fellBack: true,
    });
    const out = await ldapsearchTool.run({ host: 'ldap.example.com', baseDN: 'dc=example,dc=com' });
    expect(out.fellBack).toBe(true);
    expect(out.mode).toBe('host');
    expect(out.durationMs).toBe(200);
  });
});

describe('ldapsearch tool metadata', () => {
  it('has the right name, category, flags, and targetsFromFile', () => {
    expect(ldapsearchTool.name).toBe('ldapsearch');
    expect(ldapsearchTool.category).toBe('recon');
    expect(ldapsearchTool.flags).toContain('targetRequired');
    expect(ldapsearchTool.targetsFromFile).toBe(true);
  });
});
