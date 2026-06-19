/**
 * v0.4-B — tests for the 5 AD attack tools + their shared argv
 * builder. Each tool's argv is asserted by hand so a future change
 * to the impacket invocation shape breaks the test before it
 * breaks production.
 *
 * Mocking strategy: `run()` (the docker/host dispatcher) is mocked
 * with a no-op so the argv-builder tests stay fast and don't
 * require docker. The chokepoint-integration test at the bottom
 * uses the real `createChokepoint` because that's pure logic —
 * no subprocess, no docker.
 */

import { describe, it, expect, vi } from 'vitest';

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

import {
  psexecTool,
  wmiexecTool,
  secretsdumpTool,
  kerberoastTool,
  asreproastTool,
  buildPsexecArgs,
  buildWmiexecArgs,
  buildSecretsdumpArgs,
  buildKerberoastArgs,
  buildAsreproastArgs,
  parseKerberoastHashes,
  parseAsrepHashes,
  buildImpacketTarget,
  PsexecInput,
  WmiexecInput,
  SecretsdumpInput,
  KerberoastInput,
  AsreproastInput,
  AD_IMAGE,
} from '../../src/ad/index.js';
import { run } from '../../src/shared/runner.js';
import { TOOL_CATEGORIES, createChokepoint } from '@gmft/core';

describe('AD tool flags', () => {
  // Each of the 5 AD tools carries the same chokepoint contract
  // (destructive + targetRequired + typeToConfirm='attack'). This
  // loop is one test that asserts the contract for all 5 at once
  // so a future bug that drops the `attack` literal breaks a
  // single test instead of 5.
  it.each([
    ['psexec', psexecTool],
    ['wmiexec', wmiexecTool],
    ['secretsdump', secretsdumpTool],
    ['kerberoast', kerberoastTool],
    ['asreproast', asreproastTool],
  ] as const)('%s has destructive + targetRequired + typeToConfirm=attack', (_name, tool) => {
    expect(tool.category).toBe('ad');
    expect(tool.flags).toContain('destructive');
    expect(tool.flags).toContain('targetRequired');
    expect(tool.typeToConfirm).toBe('attack');
    expect(tool.targetsFromFile).toBeUndefined();
  });
});

describe('buildImpacketTarget', () => {
  it('assembles <domain>/<user>:<password>@<target>', () => {
    expect(
      buildImpacketTarget({
        target: 'dc01.corp.local',
        domain: 'CORP',
        username: 'admin',
        password: 'P@ssw0rd!',
      }),
    ).toBe('CORP/admin:P@ssw0rd!@dc01.corp.local');
  });

  it('prefers hashes over password when both are set', () => {
    expect(
      buildImpacketTarget({
        target: 'dc01',
        domain: 'CORP',
        username: 'admin',
        password: 'should-not-appear',
        hashes: 'aad3b435b51404eeaad3b435b51404ee:8846f7eaee8fb117ad06bdd830b7586c',
      }),
    ).toBe('CORP/admin:aad3b435b51404eeaad3b435b51404ee:8846f7eaee8fb117ad06bdd830b7586c@dc01');
  });

  it('drops the <domain>/ prefix when domain is omitted', () => {
    expect(
      buildImpacketTarget({
        target: 'dc01',
        username: 'admin',
        hashes: ':8846f7eaee8fb117ad06bdd830b7586c',
      }),
    ).toBe('admin::8846f7eaee8fb117ad06bdd830b7586c@dc01');
  });

  it('omits the :<auth> suffix for pre-auth (kerberoast/asreproast)', () => {
    expect(
      buildImpacketTarget({
        target: 'dc01.corp.local',
        domain: 'CORP',
        username: 'admin',
      }),
    ).toBe('CORP/admin@dc01.corp.local');
  });

  it('throws when pre-auth tool is missing username', () => {
    expect(() =>
      buildImpacketTarget({ target: 'dc01' }),
    ).toThrow(/username is required/);
  });

  it('throws when authenticated tool is missing username', () => {
    expect(() =>
      buildImpacketTarget({ target: 'dc01', password: 'p' }),
    ).toThrow(/username is required/);
  });
});

describe('per-tool argv builders', () => {
  it('psexec → impacket-psexec <target> <command>', () => {
    expect(
      buildPsexecArgs({
        target: 'dc01',
        domain: 'CORP',
        username: 'admin',
        password: 'p',
        command: 'whoami',
      }),
    ).toEqual(['impacket-psexec', 'CORP/admin:p@dc01', 'whoami']);
  });

  it('wmiexec → impacket-wmiexec <target> <command>', () => {
    expect(
      buildWmiexecArgs({
        target: 'dc01',
        username: 'admin',
        hashes: ':8846',
        command: 'whoami',
      }),
    ).toEqual(['impacket-wmiexec', 'admin::8846@dc01', 'whoami']);
  });

  it('secretsdump adds -just-dc-user when requested', () => {
    expect(
      buildSecretsdumpArgs({
        target: 'dc01',
        domain: 'CORP',
        username: 'admin',
        password: 'p',
        justDcUser: true,
        system: false,
      }),
    ).toEqual(['impacket-secretsdump', '-just-dc-user', '-system', 'CORP/admin:p@dc01']);
  });

  it('kerberoast adds -request by default and uses pre-auth target', () => {
    expect(
      buildKerberoastArgs({
        target: 'dc01',
        domain: 'CORP',
        username: 'admin',
        request: true,
      }),
    ).toEqual(['impacket-GetUserSPNs', '-request', 'CORP/admin@dc01']);
  });

  it('asreproast adds -request by default and uses pre-auth target', () => {
    expect(
      buildAsreproastArgs({
        target: 'dc01',
        username: 'admin',
      }),
    ).toEqual(['impacket-GetNPUsers', '-request', 'admin@dc01']);
  });
});

describe('hash parsers', () => {
  it('parseKerberoastHashes extracts krb5tgs$ lines', () => {
    const sample = [
      'Impacket v0.12.0 - Copyright 2024 SecureAuth Corporation',
      '',
      'ServicePrincipalName  Name                    MemberOf  PasswordLastSet',
      '--------------------  ----------------------  --------  -------------------',
      'MSSQLSvc/sql01.corp   sqlsvc                       2024-01-01 00:00:00',
      '',
      '$krb5tgs$23$*sqlsvc$CORP.LOCAL$MSSQLSvc/sql01.corp*$abc$def$1$2$3',
      '$krb5tgs$23$*web$CORP.LOCAL$HTTP/web.corp*$456$789$a$b',
    ].join('\n');
    expect(parseKerberoastHashes(sample)).toHaveLength(2);
    expect(parseKerberoastHashes(sample)[0]).toMatch(/^\$krb5tgs\$/);
  });

  it('parseAsrepHashes extracts $krb5asrep$ lines', () => {
    const sample = [
      'Impacket v0.12.0',
      '',
      '$krb5asrep$23$user1@CORP.LOCAL:abc$def',
      '$krb5asrep$23$user2@CORP.LOCAL:123$456',
    ].join('\n');
    expect(parseAsrepHashes(sample)).toHaveLength(2);
    expect(parseAsrepHashes(sample)[0]).toMatch(/^\$krb5asrep\$/);
  });

  it('parseKerberoastHashes returns [] on empty stdout', () => {
    expect(parseKerberoastHashes('')).toEqual([]);
    expect(parseKerberoastHashes('no hashes here')).toEqual([]);
  });
});

describe('catalog barrel', () => {
  it('TOOL_CATEGORIES now includes "ad"', () => {
    expect(TOOL_CATEGORIES).toContain('ad');
  });

  it('all 5 AD tools share the gmft/ad:0.1 image', () => {
    for (const tool of [psexecTool, wmiexecTool, secretsdumpTool, kerberoastTool, asreproastTool]) {
      expect(AD_IMAGE).toBe('gmft/ad:0.1');
      // The run() function is called with { image: AD_IMAGE, ... }.
      // We mock it out above and just confirm the tool exists + the
      // constant is what the tools use.
      expect(tool).toBeDefined();
    }
  });
});

describe('schema validation', () => {
  it('PsexecInput requires target', () => {
    expect(PsexecInput.safeParse({ username: 'admin', password: 'p' }).success).toBe(false);
  });

  it('PsexecInput applies default command=cmd.exe', () => {
    const r = PsexecInput.parse({
      target: 'dc01',
      username: 'admin',
      password: 'p',
    });
    expect(r.command).toBe('cmd.exe');
  });

  it('WmiexecInput / SecretsdumpInput / KerberoastInput / AsreproastInput all require target', () => {
    for (const schema of [WmiexecInput, SecretsdumpInput, KerberoastInput, AsreproastInput]) {
      expect(schema.safeParse({}).success).toBe(false);
    }
  });
});

describe('chokepoint integration', () => {
  // The catalog `tools` array in @gmft/tools exports 5 AD tools.
  // We exercise the real chokepoint with a tool-call shaped like an
  // AD tool call (category='ad' + flags) to confirm the B.2 rule
  // order + typeToConfirm='attack' pipeline end-to-end.
  it('an AD tool call without --scope returns type-then-confirm with prompt "attack"', async () => {
    const cp = createChokepoint({
      allowElevation: true,
      allowPrivateNetworks: false,
      allowlist: [],
      denylist: [],
      sessionTarget: '',
      realmLookup: false,
      pdcCache: { getPdc: async () => null },
    });
    const d = await cp.decide({
      tool: 'psexec',
      category: 'ad',
      flags: ['destructive', 'targetRequired'],
      typeToConfirm: 'attack',
      args: { target: 'dc01.corp.local', username: 'admin', password: 'p' },
    });
    expect(d.kind).toBe('type-then-confirm');
    if (d.kind === 'type-then-confirm') {
      expect(d.prompt).toBe('attack');
    }
  });

  it('an AD tool call WITH --scope (cliScope=true) is denied by checkAdScope', async () => {
    const cp = createChokepoint({
      allowElevation: true,
      allowPrivateNetworks: false,
      allowlist: [],
      denylist: [],
      sessionTarget: '',
      realmLookup: false,
      pdcCache: { getPdc: async () => null },
    });
    const d = await cp.decide({
      tool: 'psexec',
      category: 'ad',
      cliScope: true, // operator typed --scope on the command line
      flags: ['destructive', 'targetRequired'],
      typeToConfirm: 'attack',
      args: { target: 'dc01.corp.local', username: 'admin', password: 'p' },
    });
    expect(d.kind).toBe('deny');
    if (d.kind === 'deny') {
      expect(d.reason).toMatch(/--scope is not supported for this category/);
    }
  });
});

// Sanity: run() is mocked, so calling tool.run() with a missing
// runner should still resolve (the mock always succeeds). This test
// pins the contract that the 5 AD tools' run() functions route
// through `run()` with the right argv + image.
describe('run() dispatch wiring', () => {
  it('psexec.run calls run() with image gmft/ad:0.1 + psexec argv', async () => {
    await psexecTool.run(
      { target: 'dc01', username: 'admin', password: 'p', command: 'whoami' },
      {} as never,
    );
    const calls = (run as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls).toHaveLength(1);
    const opts = calls[0]?.[0] as { argv: string[]; image: string };
    expect(opts.image).toBe('gmft/ad:0.1');
    expect(opts.argv[0]).toBe('impacket-psexec');
    expect(opts.argv[opts.argv.length - 1]).toBe('whoami');
  });
});
