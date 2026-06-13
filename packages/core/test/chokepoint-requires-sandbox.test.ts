/**
 * Tests for the v0.2.D `checkRequiresSandbox` chokepoint rule.
 *
 * The rule denies destructive/elevated tools when:
 *   1. the resolved runner is `host` (no Docker, no landlock), AND
 *   2. the env does not have GMFT_ALLOW_UNSANDBOXED_DESTRUCTIVE=true.
 *
 * The rule-ordering tests for the new rule live in `chokepoint.test.ts`
 * (under the "rule order" describe block); this file covers the rule's
 * own behavior in isolation.
 */

import { describe, it, expect } from 'vitest';
import { createChokepoint, type ChokepointCall, type ChokepointEnv } from '../src/chokepoint/index.js';
import { checkRequiresSandbox, type RunnerCapabilitiesShape } from '../src/chokepoint/requires-sandbox.js';

const sandboxedCaps: RunnerCapabilitiesShape = {
  resolvedAuto: 'docker',
};

const landlockCaps: RunnerCapabilitiesShape = {
  resolvedAuto: 'host+landlock',
};

const hostCaps: RunnerCapabilitiesShape = {
  resolvedAuto: 'host',
};

function env(overrides: Partial<ChokepointEnv> = {}): ChokepointEnv {
  return {
    allowPrivateNetworks: false,
    allowElevation: false,
    denylist: [],
    // v0.3.B — empty allowlist is the back-compat default. Tests
    // in this file predate the allowlist field; the new rule in
    // `checkTarget` reads `env.allowlist.length` so we must set it
    // to `[]` (not omit it).
    allowlist: [],
    runnerCapabilities: hostCaps,
    allowUnsandboxedDestructive: false,
    ...overrides,
  };
}

function call(overrides: Partial<ChokepointCall> = {}): ChokepointCall {
  return {
    tool: 'test',
    category: 'shell',
    flags: [],
    args: {},
    ...overrides,
  };
}

describe('checkRequiresSandbox rule', () => {
  it('allow w/ docker: destructive+resolvedAuto=docker is allowed', () => {
    const cp = createChokepoint(env({ runnerCapabilities: sandboxedCaps }));
    expect(cp.decide(call({ flags: ['destructive'] })).kind).toBe('confirm');
    // The destructive rule still prompts the user; the new rule
    // does not interfere when a sandboxed runner is available.
  });

  it('allow w/ landlock: destructive+resolvedAuto=host+landlock is allowed', () => {
    const cp = createChokepoint(env({ runnerCapabilities: landlockCaps }));
    expect(cp.decide(call({ flags: ['destructive'] })).kind).toBe('confirm');
  });

  it('deny when host+no-landlock+destructive (no override)', () => {
    const cp = createChokepoint(env({ runnerCapabilities: hostCaps }));
    const d = cp.decide(call({ flags: ['destructive'] }));
    // checkDestructive fires BEFORE checkRequiresSandbox, so the user
    // still gets the confirm prompt. The unsandboxed deny only fires
    // for elevated tools (which have no confirm step).
    expect(d.kind).toBe('confirm');
  });

  it('deny when host+no-landlock+elevated (no override)', () => {
    const cp = createChokepoint(env({ runnerCapabilities: hostCaps }));
    const d = cp.decide(call({ flags: ['requiresElevation'] }));
    // No allowElevation -> elevation rule denies first.
    expect(d.kind).toBe('deny');
    if (d.kind === 'deny') {
      expect(d.reason).toMatch(/GMFT_ALLOW_ELEVATION/);
    }
  });

  it('deny when host+no-landlock+elevated+allowElevation (no override)', () => {
    // Elevation passes; the unsandboxed rule then denies.
    const cp = createChokepoint(env({
      runnerCapabilities: hostCaps,
      allowElevation: true,
    }));
    const d = cp.decide(call({ flags: ['requiresElevation'] }));
    expect(d.kind).toBe('deny');
    if (d.kind === 'deny') {
      expect(d.reason).toMatch(/host fallback for destructive/);
    }
  });

  it('allow with GMFT_ALLOW_UNSANDBOXED_DESTRUCTIVE=true: same as deny case but allowed', () => {
    const cp = createChokepoint(env({
      runnerCapabilities: hostCaps,
      allowElevation: true,
      allowUnsandboxedDestructive: true,
    }));
    const d = cp.decide(call({ flags: ['requiresElevation'] }));
    expect(d.kind).toBe('allow');
  });

  it('allow when tool is read-only: resolvedAuto=host, no flags -> allow', () => {
    const cp = createChokepoint(env({ runnerCapabilities: hostCaps }));
    expect(cp.decide(call())).toEqual({ kind: 'allow' });
  });

  it('allow when tool has targetRequired but not destructive/elevated', () => {
    const cp = createChokepoint(env({ runnerCapabilities: hostCaps }));
    const d = cp.decide(call({
      flags: ['targetRequired'],
      args: { target: 'example.com' },
    }));
    expect(d.kind).toBe('allow');
  });

  it('checkRequiresSandbox in isolation: destructive+host returns the deny', () => {
    // Bypass the aggregator and call the rule directly to verify the
    // rule's own deny behavior. At the aggregator level the
    // checkDestructive rule wins, so the user gets a confirm prompt
    // first; the runner then refuses to actually run the tool on
    // the host. See `chokepoint.test.ts` for the rule-order
    // assertion.
    const d = checkRequiresSandbox(
      call({ flags: ['destructive'] }),
      env({ runnerCapabilities: hostCaps }),
    );
    expect(d).toEqual({
      kind: 'deny',
      reason:
        'host fallback for destructive/elevated tools requires Docker or kernel landlock ' +
        '(set GMFT_ALLOW_UNSANDBOXED_DESTRUCTIVE=true to override; not recommended)',
    });
  });
});
