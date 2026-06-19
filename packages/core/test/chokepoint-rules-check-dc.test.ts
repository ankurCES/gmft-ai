/**
 * v0.4-B — Tests for `checkDomainController`.
 *
 * ADR-0018 §D.3: when `env.realmLookup === true` and
 * `call.category === 'ad'`, deny any call whose `args.target` matches
 * the session host's PDC (case-insensitive). The PDC is cached via
 * `env.pdcCache.getPdc()` (a single shell-out to `realm list --name-only`,
 * per-session).
 *
 * The cache returns three values:
 *   - non-empty string — the PDC FQDN, match against args.target
 *   - '' (empty) — `realm list` ran but found no PDC; deny ALL AD calls
 *   - null — cache disabled (should be unreachable when realmLookup is on)
 *
 * What we cover:
 *  1. realmLookup=true + PDC match ⇒ deny with canonical reason
 *  2. realmLookup=true + non-PDC target ⇒ allow (passes through)
 *  3. realmLookup=true + PDC='' (no realm) ⇒ deny ALL AD calls
 *  4. realmLookup=false ⇒ rule is fully skipped (no shell-out cost)
 *  5. PDC compare is case-insensitive
 *  6. Empty target ⇒ skip the rule (checkTarget fires later)
 *  7. Non-AD tool + realmLookup=true ⇒ rule is skipped (category gate)
 *  8. The deny reason is the canonical ADR-0018 §D.3 wording
 *  9. Each of the 5 AD tools behaves consistently under DC match
 */

import { describe, it, expect } from 'vitest';
import { createChokepoint, type ChokepointCall, type ChokepointEnv, type PdcCache } from '../src/chokepoint/index.js';
import type { RunnerCapabilitiesShape } from '../src/chokepoint/requires-sandbox.js';

const testCaps: RunnerCapabilitiesShape = {
  resolvedAuto: 'docker',
};

const AD_TOOLS = ['psexec', 'wmiexec', 'secretsdump', 'kerberoast', 'asreproast'] as const;

function adCall(toolName: string, target: string, overrides: Partial<ChokepointCall> = {}): ChokepointCall {
  return {
    tool: toolName,
    category: 'ad',
    flags: ['destructive', 'targetRequired'],
    args: { target },
    typeToConfirm: 'attack',
    ...overrides,
  };
}

function fakePdcCache(value: string | null): PdcCache {
  return {
    async getPdc() {
      return value;
    },
  };
}

function envWith(opts: {
  realmLookup: boolean;
  pdc?: string | null;
}): ChokepointEnv {
  return {
    allowPrivateNetworks: true,
    allowElevation: false,
    denylist: [],
    allowlist: [],
    runnerCapabilities: testCaps,
    allowUnsandboxedDestructive: false,
    realmLookup: opts.realmLookup,
    pdcCache: fakePdcCache(opts.realmLookup ? (opts.pdc ?? 'dc01.corp.example.com') : null),
  };
}

describe('checkDomainController (ADR-0018 §D.3)', () => {
  describe('realmLookup=true + PDC match ⇒ deny', () => {
    it('exact PDC FQDN match is denied', async () => {
      const cp = createChokepoint(envWith({ realmLookup: true, pdc: 'dc01.corp.example.com' }));
      const d = await cp.decide(adCall('psexec', 'dc01.corp.example.com'));
      expect(d.kind).toBe('deny');
      if (d.kind === 'deny') {
        expect(d.reason).toMatch(/domain controller/);
      }
    });

    it('deny reason matches the canonical ADR-0018 §D.3 wording', async () => {
      const cp = createChokepoint(envWith({ realmLookup: true, pdc: 'dc01.corp.example.com' }));
      const d = await cp.decide(adCall('secretsdump', 'DC01.CORP.EXAMPLE.COM'));
      expect(d.kind).toBe('deny');
      if (d.kind === 'deny') {
        expect(d.reason).toBe(
          "target matches the session's domain controller; this is blocked by default for AD tools",
        );
      }
    });

    it('each of the 5 AD tools is denied when targeting the PDC', async () => {
      for (const tool of AD_TOOLS) {
        const cp = createChokepoint(envWith({ realmLookup: true, pdc: 'dc01.corp.example.com' }));
        const d = await cp.decide(adCall(tool, 'dc01.corp.example.com'));
        expect(d.kind, `${tool} against PDC should be denied`).toBe('deny');
      }
    });
  });

  describe('realmLookup=true + non-PDC target ⇒ allow (chain continues)', () => {
    it('a workstation target reaches the destructive confirm prompt', async () => {
      const cp = createChokepoint(envWith({ realmLookup: true, pdc: 'dc01.corp.example.com' }));
      const d = await cp.decide(adCall('secretsdump', 'workstation01.corp.example.com'));
      // checkDomainController passes (not the PDC), checkElevation
      // passes (no requiresElevation flag), checkTypeToConfirm
      // fires with 'attack'. Final decision: type-then-confirm.
      expect(d.kind).toBe('type-then-confirm');
    });
  });

  describe('realmLookup=true + PDC="" (no realm) ⇒ deny ALL AD calls', () => {
    it('denies with a "verify realm" remediation hint', async () => {
      const cp = createChokepoint(envWith({ realmLookup: true, pdc: '' }));
      const d = await cp.decide(adCall('psexec', 'anyhost.example.com'));
      expect(d.kind).toBe('deny');
      if (d.kind === 'deny') {
        expect(d.reason).toMatch(/realm list/);
      }
    });
  });

  describe('realmLookup=false ⇒ rule is fully skipped', () => {
    it('does not consult pdcCache (null cache is fine)', async () => {
      const cp = createChokepoint(envWith({ realmLookup: false }));
      // pdcCache is the disabled factory (returns null); the rule
      // short-circuits before calling getPdc. Final decision
      // should be type-then-confirm (the normal AD-tool confirm).
      const d = await cp.decide(adCall('psexec', 'workstation01.corp.example.com'));
      expect(d.kind).toBe('type-then-confirm');
    });

    it('allows a target that would have been the PDC when realmLookup=false', async () => {
      // Back-compat: the v0.4-A chokepoint has no DC rule at all.
      // When realmLookup is off, AD tools against the session host
      // are no different from AD tools against any other host —
      // they go through the normal chain.
      const cp = createChokepoint(envWith({ realmLookup: false }));
      const d = await cp.decide(adCall('secretsdump', 'dc01.corp.example.com'));
      expect(d.kind).toBe('type-then-confirm');
    });
  });

  describe('case-insensitive PDC match', () => {
    it('DC01.CORP.EXAMPLE.COM matches dc01.corp.example.com', async () => {
      const cp = createChokepoint(envWith({ realmLookup: true, pdc: 'dc01.corp.example.com' }));
      const d = await cp.decide(adCall('psexec', 'DC01.CORP.EXAMPLE.COM'));
      expect(d.kind).toBe('deny');
    });

    it('Dc01.CoRp.ExAmPlE.cOm matches dc01.corp.example.com', async () => {
      const cp = createChokepoint(envWith({ realmLookup: true, pdc: 'dc01.corp.example.com' }));
      const d = await cp.decide(adCall('psexec', 'Dc01.CoRp.ExAmPlE.cOm'));
      expect(d.kind).toBe('deny');
    });
  });

  describe('empty target skips the rule', () => {
    it('empty string target does not trigger the DC check; checkTypeToConfirm fires first', async () => {
      // The chain order is checkAdScope → checkDomainController →
      // checkElevation → checkTypeToConfirm → checkDestructive →
      // checkTarget. checkDomainController skips (it doesn't
      // duplicate the missing-target error), then checkTypeToConfirm
      // fires because typeToConfirm: 'attack' is set. checkTarget
      // never gets a chance to deny.
      const cp = createChokepoint(envWith({ realmLookup: true, pdc: 'dc01.corp.example.com' }));
      const d = await cp.decide(adCall('psexec', ''));
      expect(d.kind).toBe('type-then-confirm');
    });

    it('non-string target does not trigger the DC check; checkTypeToConfirm fires first', async () => {
      const cp = createChokepoint(envWith({ realmLookup: true, pdc: 'dc01.corp.example.com' }));
      const d = await cp.decide(adCall('psexec', /* @ts-expect-error: testing non-string */ 42));
      expect(d.kind).toBe('type-then-confirm');
    });
  });

  describe('non-AD tool + realmLookup=true ⇒ rule is skipped', () => {
    it('nmap against the PDC is allowed (category: "ad" is the gate)', async () => {
      const cp = createChokepoint(envWith({ realmLookup: true, pdc: 'dc01.corp.example.com' }));
      const d = await cp.decide({
        tool: 'nmap',
        category: 'recon',
        flags: ['targetRequired'],
        args: { target: 'dc01.corp.example.com' },
      });
      // checkDomainController skips (not category: 'ad'); chain
      // passes (allowPrivateNetworks is true in envWith). Final
      // decision: allow.
      expect(d.kind).toBe('allow');
    });
  });

  describe('runs BEFORE checkElevation (ADR §D.4 ordering)', () => {
    it('an AD tool against the PDC with requiresElevation denies with the DC reason first', async () => {
      // The DC check must fire before the elevation check so the
      // operator sees the more-informative "PDC match" reason rather
      // than the generic "needs GMFT_ALLOW_ELEVATION" reason.
      const cp = createChokepoint(envWith({ realmLookup: true, pdc: 'dc01.corp.example.com' }));
      const d = await cp.decide(adCall('psexec', 'dc01.corp.example.com', { flags: ['destructive', 'targetRequired', 'requiresElevation'] }));
      expect(d.kind).toBe('deny');
      if (d.kind === 'deny') {
        expect(d.reason).toMatch(/domain controller/);
        expect(d.reason).not.toMatch(/GMFT_ALLOW_ELEVATION/);
      }
    });
  });
});
