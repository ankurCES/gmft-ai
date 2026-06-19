/**
 * Tests for the chokepoint's four built-in rules + the aggregator's
 * rule order. The rule order is contractual (documented in
 * `rules.ts`); the bottom-of-file tests assert it so any reorder
 * is a breaking change that requires an ADR.
 */

import { describe, it, expect } from 'vitest';
import { createChokepoint, readChokepointEnv, type ChokepointCall, type ChokepointEnv } from '../src/chokepoint/index.js';
import type { RunnerCapabilitiesShape } from '../src/chokepoint/requires-sandbox.js';

// v0.2.D: a neutral runner-capabilities snapshot for tests that
// don't care about the new rule. `resolvedAuto: 'docker'` keeps the
// new `checkRequiresSandbox` rule inert for tests that predate it.
const testCaps: RunnerCapabilitiesShape = {
  resolvedAuto: 'docker',
};

const baseEnv: ChokepointEnv = {
  allowPrivateNetworks: false,
  allowElevation: false,
  denylist: [],
  // v0.3.B — empty allowlist is the back-compat default. Individual
  // describe blocks override it as needed.
  allowlist: [],
  runnerCapabilities: testCaps,
  allowUnsandboxedDestructive: false,
};

function call(overrides: Partial<ChokepointCall> = {}): ChokepointCall {
  return {
    tool: 'test',
    category: 'note',
    flags: [],
    args: {},
    ...overrides,
  };
}

describe('createChokepoint', () => {
  describe('read-only / no flags', () => {
    it('allows a plain call with no flags', async () => {
      const cp = createChokepoint(baseEnv);
      expect(await cp.decide(call())).toEqual({ kind: 'allow' });
    });
  });

  describe('targetRequired rule', () => {
    it('allows a valid target', async () => {
      const cp = createChokepoint(baseEnv);
      expect(await cp.decide(call({ flags: ['targetRequired'], args: { target: 'example.com' } })))
        .toEqual({ kind: 'allow' });
    });

    it('denies a missing target', async () => {
      const cp = createChokepoint(baseEnv);
      expect(await cp.decide(call({ flags: ['targetRequired'], args: {} })))
        .toEqual({ kind: 'deny', reason: 'target required (missing)' });
    });

    it('denies a non-string target', async () => {
      const cp = createChokepoint(baseEnv);
      expect(await cp.decide(call({ flags: ['targetRequired'], args: { target: 42 } })))
        .toEqual({ kind: 'deny', reason: 'target required (missing)' });
    });

    it('denies a target with illegal characters', async () => {
      const cp = createChokepoint(baseEnv);
      expect(await cp.decide(call({ flags: ['targetRequired'], args: { target: 'foo bar' } })))
        .toEqual({ kind: 'deny', reason: 'target "foo bar" contains illegal characters' });
    });

    it('denies a 10.x target when allowPrivateNetworks is false', async () => {
      const cp = createChokepoint(baseEnv);
      expect((await cp.decide(call({ flags: ['targetRequired'], args: { target: '10.0.0.1' } }))).kind)
        .toBe('deny');
    });

    it('allows a 10.x target when allowPrivateNetworks is true', async () => {
      const cp = createChokepoint({ ...baseEnv, allowPrivateNetworks: true });
      expect(await cp.decide(call({ flags: ['targetRequired'], args: { target: '10.0.0.1' } })))
        .toEqual({ kind: 'allow' });
    });

    it('denies a 127.x target (loopback) by default', async () => {
      const cp = createChokepoint(baseEnv);
      expect((await cp.decide(call({ flags: ['targetRequired'], args: { target: '127.0.0.1' } }))).kind)
        .toBe('deny');
    });

    it('denies a 192.168.x target by default', async () => {
      const cp = createChokepoint(baseEnv);
      expect((await cp.decide(call({ flags: ['targetRequired'], args: { target: '192.168.1.1' } }))).kind)
        .toBe('deny');
    });

    it('denies a 172.16-31.x target by default', async () => {
      const cp = createChokepoint(baseEnv);
      expect((await cp.decide(call({ flags: ['targetRequired'], args: { target: '172.20.5.1' } }))).kind)
        .toBe('deny');
    });

    it('denies a 169.254.x target (link-local) by default', async () => {
      const cp = createChokepoint(baseEnv);
      expect((await cp.decide(call({ flags: ['targetRequired'], args: { target: '169.254.169.254' } }))).kind)
        .toBe('deny');
    });

    it('denies the "localhost" hostname by default', async () => {
      const cp = createChokepoint(baseEnv);
      expect((await cp.decide(call({ flags: ['targetRequired'], args: { target: 'localhost' } }))).kind)
        .toBe('deny');
    });

    it('denies a target on the operator denylist', async () => {
      const cp = createChokepoint({ ...baseEnv, denylist: ['evil.example.com'] });
      expect(await cp.decide(call({ flags: ['targetRequired'], args: { target: 'evil.example.com' } })))
        .toEqual({ kind: 'deny', reason: 'target "evil.example.com" is on the chokepoint denylist' });
    });

    // v0.3.B — per-invocation allowlist (--scope <path>). Empty list
    // is a no-op (back-compat); non-empty list denies anything not
    // explicitly listed. The check fires AFTER the denylist, so a
    // host can be both allowlisted and denylisted (deny wins).
    it('skips the allowlist check when allowlist is empty (back-compat)', async () => {
      const cp = createChokepoint({ ...baseEnv, allowlist: [] });
      expect((await cp.decide(call({ flags: ['targetRequired'], args: { target: 'one.example.com' } }))).kind)
        .toBe('allow');
      expect((await cp.decide(call({ flags: ['targetRequired'], args: { target: 'two.example.com' } }))).kind)
        .toBe('allow');
    });

    it('denies a target not in the non-empty allowlist', async () => {
      const cp = createChokepoint({ ...baseEnv, allowlist: ['scanme.nmap.org', 'testphp.vulnweb.com'] });
      expect(await cp.decide(call({ flags: ['targetRequired'], args: { target: 'other.example.com' } })))
        .toEqual({
          kind: 'deny',
          reason:
            'target "other.example.com" is not in the session allowlist ' +
            '(loaded from --scope; 2 entries listed)',
        });
    });

    it('allows a target that is in the non-empty allowlist', async () => {
      const cp = createChokepoint({ ...baseEnv, allowlist: ['scanme.nmap.org'] });
      expect((await cp.decide(call({ flags: ['targetRequired'], args: { target: 'scanme.nmap.org' } }))).kind)
        .toBe('allow');
    });

    it('uses singular "entry" wording for a single-entry allowlist', async () => {
      const cp = createChokepoint({ ...baseEnv, allowlist: ['scanme.nmap.org'] });
      expect(await cp.decide(call({ flags: ['targetRequired'], args: { target: 'other.example.com' } })))
        .toEqual({
          kind: 'deny',
          reason:
            'target "other.example.com" is not in the session allowlist ' +
            '(loaded from --scope; 1 entry listed)',
        });
    });

    it('denies a targetRequired call whose args.target does not match the session target', async () => {
      // The chokepoint binds the whole session to one host. Any tool
      // call whose args.target drifts off the session target is denied
      // with a "scope mismatch" reason. The session target itself is
      // set at boot (CLI --target, see AgentApp) and is immutable for
      // the lifetime of the run.
      const cp = createChokepoint({ ...baseEnv, sessionTarget: 'scanme.nmap.org' });
      expect(await cp.decide(call({ flags: ['targetRequired'], args: { target: 'other.example.com' } })))
        .toEqual({
          kind: 'deny',
          reason:
            'target "other.example.com" does not match session target "scanme.nmap.org" ' +
            '(start a new session with --target <host> to change scope)',
        });
    });

    it('allows a targetRequired call whose args.target matches the session target', async () => {
      const cp = createChokepoint({ ...baseEnv, sessionTarget: 'scanme.nmap.org' });
      expect((await cp.decide(call({ flags: ['targetRequired'], args: { target: 'scanme.nmap.org' } }))).kind)
        .toBe('allow');
    });

    it('skips the session-target check when sessionTarget is unset', async () => {
      // Without --target, the chokepoint does not enforce cross-call
      // binding. Per-call args.target is still format- and denylist-
      // checked, but any well-formed target is allowed.
      const cp = createChokepoint({ ...baseEnv });
      expect((await cp.decide(call({ flags: ['targetRequired'], args: { target: 'one.example.com' } }))).kind)
        .toBe('allow');
      expect((await cp.decide(call({ flags: ['targetRequired'], args: { target: 'two.example.com' } }))).kind)
        .toBe('allow');
    });

    it('reads sessionTarget through readChokepointEnv when provided', async () => {
      const env = readChokepointEnv({
        cfg: { chokepoint: { allowPrivateNetworks: false, denylist: [] } },
        sessionTarget: 'scanme.nmap.org',
      });
      expect(env.sessionTarget).toBe('scanme.nmap.org');
    });

    it('leaves sessionTarget undefined when readChokepointEnv is called without one', async () => {
      const env = readChokepointEnv({
        cfg: { chokepoint: { allowPrivateNetworks: false, denylist: [] } },
      });
      expect(env.sessionTarget).toBeUndefined();
    });

    it('skips the target check when targetRequired is not in flags', async () => {
      const cp = createChokepoint(baseEnv);
      // No target, no targetRequired — still allowed.
      expect(await cp.decide(call({ flags: [], args: {} })))
        .toEqual({ kind: 'allow' });
    });
  });

  describe('destructive rule', () => {
    it('confirms a destructive tool', async () => {
      const cp = createChokepoint(baseEnv);
      expect(await cp.decide(call({ flags: ['destructive'] })))
        .toEqual({ kind: 'confirm', reason: 'tool "test" is destructive; confirm to proceed' });
    });
  });

  describe('requiresElevation rule', () => {
    it('denies an elevated tool when allowElevation is false', async () => {
      const cp = createChokepoint(baseEnv);
      expect(await cp.decide(call({ flags: ['requiresElevation'] })))
        .toEqual({ kind: 'deny', reason: 'tool "test" requires GMFT_ALLOW_ELEVATION=true' });
    });

    it('allows an elevated tool when allowElevation is true', async () => {
      const cp = createChokepoint({ ...baseEnv, allowElevation: true });
      expect(await cp.decide(call({ flags: ['requiresElevation'] })))
        .toEqual({ kind: 'allow' });
    });
  });

  describe('typeToConfirm rule', () => {
    it('returns a type-then-confirm decision when typeToConfirm is set', async () => {
      const cp = createChokepoint(baseEnv);
      const d = await cp.decide(call({ typeToConfirm: 'attack' }));
      expect(d).toEqual({
        kind: 'type-then-confirm',
        reason: 'tool "test" is high-friction; type "attack" to confirm',
        prompt: 'attack',
      });
    });

    it('does NOT fire for tools that have no typeToConfirm', async () => {
      const cp = createChokepoint(baseEnv);
      expect((await cp.decide(call({ flags: [] }))).kind).toBe('allow');
    });

    it('typeToConfirm beats plain destructive: a tool that has both gets the stricter prompt', async () => {
      const cp = createChokepoint(baseEnv);
      const d = await cp.decide(call({ flags: ['destructive'], typeToConfirm: 'attack' }));
      expect(d.kind).toBe('type-then-confirm');
      if (d.kind === 'type-then-confirm') {
        expect(d.prompt).toBe('attack');
      }
    });
  });

  describe('rule order (elevation -> destructive -> typeToConfirm -> target -> allow)', () => {
    it('elevation beats destructive: elevated+destructive denies without elevation', async () => {
      const cp = createChokepoint(baseEnv);
      const d = await cp.decide(call({ flags: ['destructive', 'requiresElevation'] }));
      expect(d.kind).toBe('deny');
      if (d.kind === 'deny') {
        expect(d.reason).toMatch(/GMFT_ALLOW_ELEVATION/);
      }
    });

    it('destructive beats target: destructive+bad target still confirms (not denies)', async () => {
      const cp = createChokepoint(baseEnv);
      const d = await cp.decide(call({
        flags: ['destructive', 'targetRequired'],
        args: { target: 'foo bar' }, // illegal char
      }));
      expect(d.kind).toBe('confirm');
    });

    it('with elevation+targetRequired+bad target, elevation passes then target denies', async () => {
      const cp = createChokepoint({ ...baseEnv, allowElevation: true });
      const d = await cp.decide(call({
        flags: ['requiresElevation', 'targetRequired'],
        args: { target: 'foo bar' },
      }));
      expect(d.kind).toBe('deny');
      if (d.kind === 'deny') {
        expect(d.reason).toMatch(/illegal characters/);
      }
    });

    it('elevation beats typeToConfirm: elevated+typeToConfirm denies without elevation', async () => {
      const cp = createChokepoint(baseEnv);
      const d = await cp.decide(call({
        flags: ['requiresElevation'],
        typeToConfirm: 'attack',
      }));
      expect(d.kind).toBe('deny');
      if (d.kind === 'deny') {
        expect(d.reason).toMatch(/GMFT_ALLOW_ELEVATION/);
      }
    });

    it('requiresSandbox beats allow: elevated+host+allowElevation+no-override is deny', async () => {
      // v0.2.D: when the runner resolves to `host` (no Docker, no
      // landlock) and the operator has NOT opted in to
      // GMFT_ALLOW_UNSANDBOXED_DESTRUCTIVE, the chokepoint denies
      // elevated tools rather than letting them run unsandboxed.
      // (Destructive tools get a confirm prompt first — see the
      // next test — so the new rule is observably tested via the
      // elevated path.)
      const cp = createChokepoint({
        ...baseEnv,
        allowElevation: true,
        runnerCapabilities: { ...testCaps, resolvedAuto: 'host' },
      });
      const d = await cp.decide(call({ flags: ['requiresElevation'] }));
      expect(d.kind).toBe('deny');
      if (d.kind === 'deny') {
        expect(d.reason).toMatch(/host fallback for destructive/);
      }
    });

    it('destructive beats requiresSandbox: destructive+host still gets the confirm prompt first', async () => {
      // The confirm prompt must come BEFORE the unsandboxed deny.
      // Otherwise the user would be locked out of a destructive tool
      // without ever being told *why* they could confirm it. The
      // runner itself is then responsible for refusing to actually
      // run the tool on the host.
      const cp = createChokepoint({
        ...baseEnv,
        runnerCapabilities: { ...testCaps, resolvedAuto: 'host' },
      });
      const d = await cp.decide(call({ flags: ['destructive'] }));
      // checkDestructive fires at position 3, checkRequiresSandbox at
      // position 5. Confirm should win.
      expect(d.kind).toBe('confirm');
    });

    it('elevation beats requiresSandbox: elevated+host+no-allowElevation denies with elevation reason first', async () => {
      // Elevated tools deny with the elevation reason first; the
      // unsandboxed deny never fires because the elevation rule
      // returns non-null earlier in the chain.
      const cp = createChokepoint({
        ...baseEnv,
        runnerCapabilities: { ...testCaps, resolvedAuto: 'host' },
      });
      const d = await cp.decide(call({ flags: ['requiresElevation'] }));
      expect(d.kind).toBe('deny');
      if (d.kind === 'deny') {
        expect(d.reason).toMatch(/GMFT_ALLOW_ELEVATION/);
      }
    });

    it('requiresSandbox yields to allowUnsandboxedDestructive override', async () => {
      // Same setup as the deny case, but with the opt-in env. The
      // operator accepts responsibility and the tool runs.
      const cp = createChokepoint({
        ...baseEnv,
        allowElevation: true,
        allowUnsandboxedDestructive: true,
        runnerCapabilities: { ...testCaps, resolvedAuto: 'host' },
      });
      const d = await cp.decide(call({ flags: ['requiresElevation'] }));
      expect(d.kind).toBe('allow');
    });

    // v0.4-B — AD-specific rule order (ADR-0018 §D.4):
    //   1. checkAdScope            — deny category:'ad' + scope
    //   2. checkDomainController   — deny realm-lookup match
    //   3. checkElevation          — (canonical)
    //   4. checkTypeToConfirm      — (canonical)
    //   5. checkDestructive        — (canonical)
    //   6. checkTarget             — (canonical)
    //
    // The two AD rules fire first (cheap, category-level). The DC
    // check fires before checkElevation so the operator sees the
    // more-informative "PDC match" reason when both apply.
    it('checkAdScope beats checkElevation: AD tool + scope + elevation denies with scope reason first', async () => {
      const cp = createChokepoint({
        ...baseEnv,
        allowElevation: true,
      });
      const d = await cp.decide(call({
        category: 'ad',
        tool: 'psexec',
        flags: ['destructive', 'targetRequired', 'requiresElevation'],
        args: { target: 'dc01.corp.example.com', scope: ['dc01.corp.example.com'] },
        typeToConfirm: 'attack',
      }));
      expect(d.kind).toBe('deny');
      if (d.kind === 'deny') {
        expect(d.reason).toMatch(/one target at a time/);
        expect(d.reason).not.toMatch(/GMFT_ALLOW_ELEVATION/);
      }
    });

    it('checkDomainController beats checkElevation: AD tool vs PDC + elevation denies with DC reason first', async () => {
      // realmLookup=true + PDC match: the DC rule must fire before
      // checkElevation so the operator gets the more-informative
      // "PDC match" reason rather than the generic "needs
      // GMFT_ALLOW_ELEVATION" reason.
      const cp = createChokepoint({
        ...baseEnv,
        allowElevation: true,
        realmLookup: true,
        pdcCache: {
          async getPdc() {
            return 'dc01.corp.example.com';
          },
        },
      });
      const d = await cp.decide(call({
        category: 'ad',
        tool: 'psexec',
        flags: ['destructive', 'targetRequired', 'requiresElevation'],
        args: { target: 'dc01.corp.example.com' },
        typeToConfirm: 'attack',
      }));
      expect(d.kind).toBe('deny');
      if (d.kind === 'deny') {
        expect(d.reason).toMatch(/domain controller/);
        expect(d.reason).not.toMatch(/GMFT_ALLOW_ELEVATION/);
      }
    });

    it('checkAdScope beats checkDomainController: scope + PDC match denies with scope reason first', async () => {
      // Both AD rules could fire (category: 'ad', scope is set,
      // AND the target is the PDC). The scope rule fires first so
      // the operator gets the cheaper, more-actionable error.
      const cp = createChokepoint({
        ...baseEnv,
        realmLookup: true,
        pdcCache: {
          async getPdc() {
            return 'dc01.corp.example.com';
          },
        },
      });
      const d = await cp.decide(call({
        category: 'ad',
        tool: 'psexec',
        flags: ['destructive', 'targetRequired'],
        args: { target: 'dc01.corp.example.com', scope: ['dc01.corp.example.com'] },
        typeToConfirm: 'attack',
      }));
      expect(d.kind).toBe('deny');
      if (d.kind === 'deny') {
        expect(d.reason).toMatch(/one target at a time/);
      }
    });
  });
});

describe('readChokepointEnv', () => {
  it('reads allowPrivateNetworks + denylist from cfg', async () => {
    const got = readChokepointEnv({
      cfg: { chokepoint: { allowPrivateNetworks: true, denylist: ['x', 'y'] } },
      env: {},
    });
    expect(got.allowPrivateNetworks).toBe(true);
    expect(got.denylist).toEqual(['x', 'y']);
    expect(got.allowElevation).toBe(false);
    expect(got.allowUnsandboxedDestructive).toBe(false);
    expect(got.runnerCapabilities).toBeDefined();
  });

  it('sets allowElevation from GMFT_ALLOW_ELEVATION=true', async () => {
    const got = readChokepointEnv({
      cfg: { chokepoint: { allowPrivateNetworks: false, denylist: [] } },
      env: { GMFT_ALLOW_ELEVATION: 'true' },
    });
    expect(got.allowElevation).toBe(true);
  });

  it('treats GMFT_ALLOW_ELEVATION="1" as false (must be exactly "true")', async () => {
    const got = readChokepointEnv({
      cfg: { chokepoint: { allowPrivateNetworks: false, denylist: [] } },
      env: { GMFT_ALLOW_ELEVATION: '1' },
    });
    expect(got.allowElevation).toBe(false);
  });

  it('sets allowUnsandboxedDestructive from GMFT_ALLOW_UNSANDBOXED_DESTRUCTIVE=true', async () => {
    const got = readChokepointEnv({
      cfg: { chokepoint: { allowPrivateNetworks: false, denylist: [] } },
      env: { GMFT_ALLOW_UNSANDBOXED_DESTRUCTIVE: 'true' },
    });
    expect(got.allowUnsandboxedDestructive).toBe(true);
  });

  it('treats GMFT_ALLOW_UNSANDBOXED_DESTRUCTIVE="1" as false (must be exactly "true")', async () => {
    const got = readChokepointEnv({
      cfg: { chokepoint: { allowPrivateNetworks: false, denylist: [] } },
      env: { GMFT_ALLOW_UNSANDBOXED_DESTRUCTIVE: '1' },
    });
    expect(got.allowUnsandboxedDestructive).toBe(false);
  });

  // v0.3.B — per-invocation allowlist plumbing.
  it('defaults allowlist to [] when not provided (back-compat)', async () => {
    const got = readChokepointEnv({
      cfg: { chokepoint: { allowPrivateNetworks: false, denylist: [] } },
      env: {},
    });
    expect(got.allowlist).toEqual([]);
  });

  it('passes the provided allowlist through verbatim', async () => {
    const got = readChokepointEnv({
      cfg: { chokepoint: { allowPrivateNetworks: false, denylist: [] } },
      env: {},
      allowlist: ['scanme.nmap.org', '10.0.0.5'],
    });
    expect(got.allowlist).toEqual(['scanme.nmap.org', '10.0.0.5']);
  });
});
