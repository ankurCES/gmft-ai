/**
 * v0.3.B — integration test: the full --scope wiring path.
 *
 * This is the single end-to-end check that "loading a scope file
 * at the CLI and threading it into the chokepoint actually gates
 * tool calls." The two unit-test surfaces cover the halves
 * independently:
 *
 *   - `scope-file.test.ts` covers `loadScopeFile` (parsing, dedup,
 *     entry validation, error codes).
 *   - `chokepoint.test.ts` covers `checkTarget` against a non-empty
 *     `allowlist` (deny reason, singular/plural wording,
 *     empty-list no-op).
 *
 * What those halves don't cover: that the *array shape* returned
 * by `loadScopeFile` is what `readChokepointEnv` actually accepts
 * and that the resulting chokepoint denies an unlisted target. If
 * a future refactor narrows the type of `ChokepointEnv.allowlist`
 * (e.g. to `string[]` instead of `readonly string[]`) or wraps the
 * array, this test catches it before a user hits it in production.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChokepoint, readChokepointEnv, type ChokepointCall } from '@gmft/core';
import { loadScopeFile } from '../src/scope-file.js';

function scratchDir(): string {
  return mkdtempSync(join(tmpdir(), 'gmft-scope-e2e-'));
}

function targetCall(overrides: Partial<ChokepointCall> = {}): ChokepointCall {
  return {
    tool: 'nmap',
    category: 'network',
    flags: ['targetRequired'],
    args: { target: 'scanme.nmap.org' },
    ...overrides,
  };
}

describe('scope file → chokepoint end-to-end', () => {
  it('a loaded scope file gates the chokepoint to its listed targets', async () => {
    const dir = scratchDir();
    try {
      const p = join(dir, 'scope.json');
      writeFileSync(p, JSON.stringify({ allow: ['scanme.nmap.org', '10.0.0.5'] }));

      // Step 1: load + parse + dedup the file (the CLI's --scope path).
      const loaded = loadScopeFile(p);
      expect(loaded.allow).toEqual(['scanme.nmap.org', '10.0.0.5']);

      // Step 2: thread the array into the chokepoint env (AgentApp's
      // construction site). `cfg.chokepoint.denylist: []` is the
      // operator's default (no persisted denylist in v0.3.B).
      const env = readChokepointEnv({
        cfg: { chokepoint: { allowPrivateNetworks: false, denylist: [] } },
        env: {},
        allowlist: loaded.allow,
      });
      expect(env.allowlist).toEqual(['scanme.nmap.org', '10.0.0.5']);

      // Step 3: the resulting chokepoint denies an unlisted target.
      const cp = createChokepoint(env);
      const deny = await cp.decide(targetCall({ args: { target: 'other.example.com' } }));
      expect(deny).toEqual({
        kind: 'deny',
        reason:
          'target "other.example.com" is not in the session allowlist ' +
          '(loaded from --scope; 2 entries listed)',
      });

      // Step 4: a listed target is still allowed.
      const allow = await cp.decide(targetCall({ args: { target: 'scanme.nmap.org' } }));
      expect(allow.kind).toBe('allow');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('omitting the allowlist (no --scope flag) keeps the back-compat behavior', async () => {
    // This pins the contract that an empty allowlist is a true
    // no-op: any well-formed target passes the target-rule. The
    // denylist (also empty here) is the only negative check; that
    // is the pre-v0.3.B operator experience.
    const env = readChokepointEnv({
      cfg: { chokepoint: { allowPrivateNetworks: false, denylist: [] } },
      env: {},
      // no allowlist key — back-compat default is []
    });
    const cp = createChokepoint(env);
    expect(env.allowlist).toEqual([]);
    expect((await cp.decide(targetCall({ args: { target: 'one.example.com' } }))).kind).toBe('allow');
    expect((await cp.decide(targetCall({ args: { target: 'two.example.com' } }))).kind).toBe('allow');
  });

  it('an empty allowlist from a scope file with no entries is a no-op (operator chose to allow nothing explicitly)', async () => {
    // Edge case: the operator writes `{ "allow": [] }` on purpose
    // to mean "deny every target". That's almost certainly a
    // misconfiguration, but the loader accepts it and the
    // chokepoint treats it as "any target is unlisted → deny".
    // Pin that behavior so a future "empty means allow-all" change
    // has to update this test in lockstep.
    const dir = scratchDir();
    try {
      const p = join(dir, 'scope.json');
      writeFileSync(p, JSON.stringify({ allow: [] }));
      const loaded = loadScopeFile(p);
      expect(loaded.allow).toEqual([]);

      const env = readChokepointEnv({
        cfg: { chokepoint: { allowPrivateNetworks: false, denylist: [] } },
        env: {},
        allowlist: loaded.allow,
      });
      // `allowlist: []` is the explicit no-op (per the back-compat
      // contract on `checkTarget`): a literal empty array, not
      // undefined, still means "no allowlist enforced".
      const cp = createChokepoint(env);
      expect((await cp.decide(targetCall({ args: { target: 'scanme.nmap.org' } }))).kind).toBe('allow');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
