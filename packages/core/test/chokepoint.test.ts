/**
 * Tests for the chokepoint's four built-in rules + the aggregator's
 * rule order. The rule order is contractual (documented in
 * `rules.ts`); the bottom-of-file tests assert it so any reorder
 * is a breaking change that requires an ADR.
 */

import { describe, it, expect } from 'vitest';
import { createChokepoint, readChokepointEnv, type ChokepointCall, type ChokepointEnv } from '../src/chokepoint/index.js';

const baseEnv: ChokepointEnv = {
  allowPrivateNetworks: false,
  allowElevation: false,
  denylist: [],
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
    it('allows a plain call with no flags', () => {
      const cp = createChokepoint(baseEnv);
      expect(cp.decide(call())).toEqual({ kind: 'allow' });
    });
  });

  describe('targetRequired rule', () => {
    it('allows a valid target', () => {
      const cp = createChokepoint(baseEnv);
      expect(cp.decide(call({ flags: ['targetRequired'], args: { target: 'example.com' } })))
        .toEqual({ kind: 'allow' });
    });

    it('denies a missing target', () => {
      const cp = createChokepoint(baseEnv);
      expect(cp.decide(call({ flags: ['targetRequired'], args: {} })))
        .toEqual({ kind: 'deny', reason: 'target required (missing)' });
    });

    it('denies a non-string target', () => {
      const cp = createChokepoint(baseEnv);
      expect(cp.decide(call({ flags: ['targetRequired'], args: { target: 42 } })))
        .toEqual({ kind: 'deny', reason: 'target required (missing)' });
    });

    it('denies a target with illegal characters', () => {
      const cp = createChokepoint(baseEnv);
      expect(cp.decide(call({ flags: ['targetRequired'], args: { target: 'foo bar' } })))
        .toEqual({ kind: 'deny', reason: 'target "foo bar" contains illegal characters' });
    });

    it('denies a 10.x target when allowPrivateNetworks is false', () => {
      const cp = createChokepoint(baseEnv);
      expect(cp.decide(call({ flags: ['targetRequired'], args: { target: '10.0.0.1' } })).kind)
        .toBe('deny');
    });

    it('allows a 10.x target when allowPrivateNetworks is true', () => {
      const cp = createChokepoint({ ...baseEnv, allowPrivateNetworks: true });
      expect(cp.decide(call({ flags: ['targetRequired'], args: { target: '10.0.0.1' } })))
        .toEqual({ kind: 'allow' });
    });

    it('denies a 127.x target (loopback) by default', () => {
      const cp = createChokepoint(baseEnv);
      expect(cp.decide(call({ flags: ['targetRequired'], args: { target: '127.0.0.1' } })).kind)
        .toBe('deny');
    });

    it('denies a 192.168.x target by default', () => {
      const cp = createChokepoint(baseEnv);
      expect(cp.decide(call({ flags: ['targetRequired'], args: { target: '192.168.1.1' } })).kind)
        .toBe('deny');
    });

    it('denies a 172.16-31.x target by default', () => {
      const cp = createChokepoint(baseEnv);
      expect(cp.decide(call({ flags: ['targetRequired'], args: { target: '172.20.5.1' } })).kind)
        .toBe('deny');
    });

    it('denies a 169.254.x target (link-local) by default', () => {
      const cp = createChokepoint(baseEnv);
      expect(cp.decide(call({ flags: ['targetRequired'], args: { target: '169.254.169.254' } })).kind)
        .toBe('deny');
    });

    it('denies the "localhost" hostname by default', () => {
      const cp = createChokepoint(baseEnv);
      expect(cp.decide(call({ flags: ['targetRequired'], args: { target: 'localhost' } })).kind)
        .toBe('deny');
    });

    it('denies a target on the operator denylist', () => {
      const cp = createChokepoint({ ...baseEnv, denylist: ['evil.example.com'] });
      expect(cp.decide(call({ flags: ['targetRequired'], args: { target: 'evil.example.com' } })))
        .toEqual({ kind: 'deny', reason: 'target "evil.example.com" is on the chokepoint denylist' });
    });

    it('denies a targetRequired call whose args.target does not match the session target', () => {
      // The chokepoint binds the whole session to one host. Any tool
      // call whose args.target drifts off the session target is denied
      // with a "scope mismatch" reason. The session target itself is
      // set at boot (CLI --target, see AgentApp) and is immutable for
      // the lifetime of the run.
      const cp = createChokepoint({ ...baseEnv, sessionTarget: 'scanme.nmap.org' });
      expect(cp.decide(call({ flags: ['targetRequired'], args: { target: 'other.example.com' } })))
        .toEqual({
          kind: 'deny',
          reason:
            'target "other.example.com" does not match session target "scanme.nmap.org" ' +
            '(start a new session with --target <host> to change scope)',
        });
    });

    it('allows a targetRequired call whose args.target matches the session target', () => {
      const cp = createChokepoint({ ...baseEnv, sessionTarget: 'scanme.nmap.org' });
      expect(cp.decide(call({ flags: ['targetRequired'], args: { target: 'scanme.nmap.org' } })).kind)
        .toBe('allow');
    });

    it('skips the session-target check when sessionTarget is unset', () => {
      // Without --target, the chokepoint does not enforce cross-call
      // binding. Per-call args.target is still format- and denylist-
      // checked, but any well-formed target is allowed.
      const cp = createChokepoint({ ...baseEnv });
      expect(cp.decide(call({ flags: ['targetRequired'], args: { target: 'one.example.com' } })).kind)
        .toBe('allow');
      expect(cp.decide(call({ flags: ['targetRequired'], args: { target: 'two.example.com' } })).kind)
        .toBe('allow');
    });

    it('reads sessionTarget through readChokepointEnv when provided', () => {
      const env = readChokepointEnv({
        cfg: { chokepoint: { allowPrivateNetworks: false, denylist: [] } },
        sessionTarget: 'scanme.nmap.org',
      });
      expect(env.sessionTarget).toBe('scanme.nmap.org');
    });

    it('leaves sessionTarget undefined when readChokepointEnv is called without one', () => {
      const env = readChokepointEnv({
        cfg: { chokepoint: { allowPrivateNetworks: false, denylist: [] } },
      });
      expect(env.sessionTarget).toBeUndefined();
    });

    it('skips the target check when targetRequired is not in flags', () => {
      const cp = createChokepoint(baseEnv);
      // No target, no targetRequired — still allowed.
      expect(cp.decide(call({ flags: [], args: {} })))
        .toEqual({ kind: 'allow' });
    });
  });

  describe('destructive rule', () => {
    it('confirms a destructive tool', () => {
      const cp = createChokepoint(baseEnv);
      expect(cp.decide(call({ flags: ['destructive'] })))
        .toEqual({ kind: 'confirm', reason: 'tool "test" is destructive; confirm to proceed' });
    });
  });

  describe('requiresElevation rule', () => {
    it('denies an elevated tool when allowElevation is false', () => {
      const cp = createChokepoint(baseEnv);
      expect(cp.decide(call({ flags: ['requiresElevation'] })))
        .toEqual({ kind: 'deny', reason: 'tool "test" requires GMFT_ALLOW_ELEVATION=true' });
    });

    it('allows an elevated tool when allowElevation is true', () => {
      const cp = createChokepoint({ ...baseEnv, allowElevation: true });
      expect(cp.decide(call({ flags: ['requiresElevation'] })))
        .toEqual({ kind: 'allow' });
    });
  });

  describe('typeToConfirm rule', () => {
    it('returns a type-then-confirm decision when typeToConfirm is set', () => {
      const cp = createChokepoint(baseEnv);
      const d = cp.decide(call({ typeToConfirm: 'attack' }));
      expect(d).toEqual({
        kind: 'type-then-confirm',
        reason: 'tool "test" is high-friction; type "attack" to confirm',
        prompt: 'attack',
      });
    });

    it('does NOT fire for tools that have no typeToConfirm', () => {
      const cp = createChokepoint(baseEnv);
      expect(cp.decide(call({ flags: [] })).kind).toBe('allow');
    });

    it('typeToConfirm beats plain destructive: a tool that has both gets the stricter prompt', () => {
      const cp = createChokepoint(baseEnv);
      const d = cp.decide(call({ flags: ['destructive'], typeToConfirm: 'attack' }));
      expect(d.kind).toBe('type-then-confirm');
      if (d.kind === 'type-then-confirm') {
        expect(d.prompt).toBe('attack');
      }
    });
  });

  describe('rule order (elevation -> destructive -> typeToConfirm -> target -> allow)', () => {
    it('elevation beats destructive: elevated+destructive denies without elevation', () => {
      const cp = createChokepoint(baseEnv);
      const d = cp.decide(call({ flags: ['destructive', 'requiresElevation'] }));
      expect(d.kind).toBe('deny');
      if (d.kind === 'deny') {
        expect(d.reason).toMatch(/GMFT_ALLOW_ELEVATION/);
      }
    });

    it('destructive beats target: destructive+bad target still confirms (not denies)', () => {
      const cp = createChokepoint(baseEnv);
      const d = cp.decide(call({
        flags: ['destructive', 'targetRequired'],
        args: { target: 'foo bar' }, // illegal char
      }));
      expect(d.kind).toBe('confirm');
    });

    it('with elevation+targetRequired+bad target, elevation passes then target denies', () => {
      const cp = createChokepoint({ ...baseEnv, allowElevation: true });
      const d = cp.decide(call({
        flags: ['requiresElevation', 'targetRequired'],
        args: { target: 'foo bar' },
      }));
      expect(d.kind).toBe('deny');
      if (d.kind === 'deny') {
        expect(d.reason).toMatch(/illegal characters/);
      }
    });

    it('elevation beats typeToConfirm: elevated+typeToConfirm denies without elevation', () => {
      const cp = createChokepoint(baseEnv);
      const d = cp.decide(call({
        flags: ['requiresElevation'],
        typeToConfirm: 'attack',
      }));
      expect(d.kind).toBe('deny');
      if (d.kind === 'deny') {
        expect(d.reason).toMatch(/GMFT_ALLOW_ELEVATION/);
      }
    });
  });
});

describe('readChokepointEnv', () => {
  it('reads allowPrivateNetworks + denylist from cfg', () => {
    const got = readChokepointEnv({
      cfg: { chokepoint: { allowPrivateNetworks: true, denylist: ['x', 'y'] } },
      env: {},
    });
    expect(got).toEqual({ allowPrivateNetworks: true, allowElevation: false, denylist: ['x', 'y'] });
  });

  it('sets allowElevation from GMFT_ALLOW_ELEVATION=true', () => {
    const got = readChokepointEnv({
      cfg: { chokepoint: { allowPrivateNetworks: false, denylist: [] } },
      env: { GMFT_ALLOW_ELEVATION: 'true' },
    });
    expect(got.allowElevation).toBe(true);
  });

  it('treats GMFT_ALLOW_ELEVATION="1" as false (must be exactly "true")', () => {
    const got = readChokepointEnv({
      cfg: { chokepoint: { allowPrivateNetworks: false, denylist: [] } },
      env: { GMFT_ALLOW_ELEVATION: '1' },
    });
    expect(got.allowElevation).toBe(false);
  });
});
