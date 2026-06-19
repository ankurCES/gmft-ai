/**
 * v0.4-B — Tests for `checkAdScope`.
 *
 * ADR-0018 §D.2: category: 'ad' + any --scope source (args.scope or
 * the CLI's --scope flag) ⇒ deny. The rule fires for ANY AD tool
 * call that has a scope attached; the tool name itself is irrelevant.
 *
 * What we cover:
 *  1. Each of the 5 AD tools + args.scope ⇒ deny
 *  2. Each of the 5 AD tools + cliScope=true ⇒ deny
 *  3. AD tool WITHOUT any scope source ⇒ allow (passes through to
 *     the next rule; target-only enforcement happens later in chain)
 *  4. Non-AD tool + args.scope ⇒ allow (the rule is AD-only)
 *  5. Non-AD tool + cliScope=true ⇒ allow
 *  6. category: 'ad' is the gate, not the tool name (a tool with the
 *     name 'psexec' but category: 'shell' is not blocked)
 *  7. The deny reason matches the canonical ADR-0018 §D.2 wording
 *     so the TUI/audit-log output is consistent across all AD tools
 */

import { describe, it, expect } from 'vitest';
import { createChokepoint, type ChokepointCall, type ChokepointEnv } from '../src/chokepoint/index.js';
import type { RunnerCapabilitiesShape } from '../src/chokepoint/requires-sandbox.js';

const testCaps: RunnerCapabilitiesShape = {
  resolvedAuto: 'docker',
};

const baseEnv: ChokepointEnv = {
  allowPrivateNetworks: true,
  allowElevation: false,
  denylist: [],
  allowlist: [],
  runnerCapabilities: testCaps,
  allowUnsandboxedDestructive: false,
};

const AD_TOOLS = ['psexec', 'wmiexec', 'secretsdump', 'kerberoast', 'asreproast'] as const;

function adCall(toolName: string, overrides: Partial<ChokepointCall> = {}): ChokepointCall {
  return {
    tool: toolName,
    category: 'ad',
    flags: ['destructive', 'targetRequired'],
    args: { target: 'dc01.corp.example.com' },
    ...overrides,
  };
}

describe('checkAdScope (ADR-0018 §D.2)', () => {
  describe('each AD tool + args.scope ⇒ deny', () => {
    for (const toolName of AD_TOOLS) {
      it(`${toolName} with args.scope is denied`, async () => {
        const cp = createChokepoint(baseEnv);
        const d = await cp.decide(adCall(toolName, { args: { target: 'dc01.corp.example.com', scope: ['host1', 'host2'] } }));
        expect(d.kind).toBe('deny');
        if (d.kind === 'deny') {
          expect(d.reason).toMatch(/one target at a time/);
        }
      });
    }
  });

  describe('each AD tool + cliScope=true ⇒ deny', () => {
    for (const toolName of AD_TOOLS) {
      it(`${toolName} with cliScope is denied`, async () => {
        const cp = createChokepoint(baseEnv);
        const d = await cp.decide(adCall(toolName, { cliScope: true }));
        expect(d.kind).toBe('deny');
        if (d.kind === 'deny') {
          expect(d.reason).toMatch(/one target at a time/);
        }
      });
    }
  });

  describe('AD tool WITHOUT scope ⇒ passes through to the next rule', () => {
    it('reaches checkTypeToConfirm when scope is absent', async () => {
      // The 5 AD tools all set typeToConfirm: 'attack'. With no scope
      // attached, the chain reaches checkTypeToConfirm and returns
      // a 'type-then-confirm' decision (the destructive confirm
      // prompt). This is the canonical AD-tool happy path.
      const cp = createChokepoint(baseEnv);
      const d = await cp.decide(adCall('psexec', { typeToConfirm: 'attack' }));
      expect(d.kind).toBe('type-then-confirm');
      if (d.kind === 'type-then-confirm') {
        expect(d.prompt).toBe('attack');
      }
    });
  });

  describe('non-AD tool + scope ⇒ allow (rule is AD-only)', () => {
    it('nmap with --scope is allowed past checkAdScope', async () => {
      const cp = createChokepoint(baseEnv);
      const d = await cp.decide({
        tool: 'nmap',
        category: 'recon',
        flags: ['targetRequired'],
        args: { target: 'scanme.nmap.org', scope: ['scanme.nmap.org', 'testphp.vulnweb.com'] },
        cliScope: true,
      });
      // checkAdScope passes (not category: 'ad'); the rest of the
      // chain also passes (allowPrivateNetworks is true here so
      // the public target is allowed). Final decision is allow.
      expect(d.kind).toBe('allow');
    });

    it('shell_exec with --scope is allowed past checkAdScope', async () => {
      const cp = createChokepoint(baseEnv);
      const d = await cp.decide({
        tool: 'shell_exec',
        category: 'shell',
        flags: [],
        args: {},
        cliScope: true,
      });
      expect(d.kind).toBe('allow');
    });
  });

  describe('category: "ad" is the gate, not the tool name', () => {
    it('a tool named "psexec" with category: "shell" is not blocked', async () => {
      // Edge case: somebody adds a non-AD tool that happens to be
      // named like an AD tool. The check is category-based, so the
      // scope rule should NOT fire.
      const cp = createChokepoint(baseEnv);
      const d = await cp.decide({
        tool: 'psexec',
        category: 'shell',
        flags: [],
        args: {},
        cliScope: true,
      });
      expect(d.kind).toBe('allow');
    });
  });

  describe('deny reason is canonical', () => {
    it('matches the ADR-0018 §D.2 wording', async () => {
      const cp = createChokepoint(baseEnv);
      const d = await cp.decide(adCall('secretsdump', { cliScope: true }));
      expect(d.kind).toBe('deny');
      if (d.kind === 'deny') {
        expect(d.reason).toBe(
          'AD tools must be called one target at a time; --scope is not supported for this category.',
        );
      }
    });
  });

  describe('null/undefined scope sources do NOT trigger the rule', () => {
    it('args.scope === undefined does not trigger', async () => {
      // With no scope AND typeToConfirm: 'attack' set, the chain
      // reaches checkTypeToConfirm (after checkAdScope passes) and
      // returns type-then-confirm. This is the canonical AD-tool
      // happy path: scope-check passes, type-then-confirm prompts.
      const cp = createChokepoint(baseEnv);
      const d = await cp.decide(
        adCall('psexec', {
          typeToConfirm: 'attack',
          args: { target: 'dc01.corp.example.com', scope: undefined },
        }),
      );
      expect(d.kind).toBe('type-then-confirm');
    });

    it('args.scope === null does not trigger', async () => {
      const cp = createChokepoint(baseEnv);
      const d = await cp.decide(
        adCall('psexec', {
          typeToConfirm: 'attack',
          args: { target: 'dc01.corp.example.com', scope: null },
        }),
      );
      expect(d.kind).toBe('type-then-confirm');
    });

    it('cliScope === undefined does not trigger', async () => {
      const cp = createChokepoint(baseEnv);
      const d = await cp.decide(
        adCall('psexec', { typeToConfirm: 'attack', cliScope: undefined }),
      );
      expect(d.kind).toBe('type-then-confirm');
    });
  });
});
