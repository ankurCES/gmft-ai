import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  seccompAvailable,
  applySeccomp,
  buildSeccompBpf,
  _resetSeccompForTest,
} from '../../src/shared/seccomp';

describe('seccompAvailable', () => {
  beforeEach(() => _resetSeccompForTest());
  afterEach(() => _resetSeccompForTest());

  it('returns a SeccompStatus object with the correct shape', () => {
    const s = seccompAvailable();
    expect(s).toBeTypeOf('object');
    expect(typeof s.available).toBe('boolean');
    expect(['disabled', 'strict', 'filter', 'unknown']).toContain(s.mode);
  });

  it('returns available: false on non-Linux (no seccomp probe attempted)', () => {
    const original = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    try {
      const s = seccompAvailable();
      expect(s).toEqual({ available: false, mode: 'disabled' });
    } finally {
      Object.defineProperty(process, 'platform', { value: original, configurable: true });
    }
  });

  it('caches the result (probe is stable for the life of the process)', () => {
    const a = seccompAvailable();
    const b = seccompAvailable();
    expect(a).toBe(b);
  });
});

describe('buildSeccompBpf', () => {
  it('defaults to an allowlist policy when none is given', () => {
    const prog = buildSeccompBpf();
    // Allowlist layout: 1 (arch) + 1 (arch check) + 1 (nr) + N (chain) + 1 (KILL) + 1 (ALLOW)
    // The default allowlist is ~21 entries → 25 insns.
    expect(prog.length).toBeGreaterThan(10);
    // The first insn is the arch load.
    expect(prog.insns[0]!.k).toBe(4);
  });

  it('builds a denylist when policy="denylist" is requested', () => {
    const prog = buildSeccompBpf({
      policy: 'denylist',
      deniedSyscalls: [101, 246],
    });
    // Denylist layout: 1 + 1 + 1 + 2 (chain) + 1 (ALLOW) + 1 (KILL) = 7
    expect(prog.length).toBe(7);
  });

  it('honors a custom allowedSyscalls list', () => {
    const prog = buildSeccompBpf({
      policy: 'allowlist',
      allowedSyscalls: [1, 2, 3],
    });
    // 1 + 1 + 1 + 3 + 1 + 1 = 8
    expect(prog.length).toBe(8);
    // The chain entries should be 1, 2, 3.
    expect(prog.insns[3]!.k).toBe(1);
    expect(prog.insns[4]!.k).toBe(2);
    expect(prog.insns[5]!.k).toBe(3);
  });
});

describe('applySeccomp (negative tests — no kernel mutation)', () => {
  it('refuses to run on non-Linux', () => {
    const original = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    try {
      expect(() => applySeccomp()).toThrow(/not on Linux/);
    } finally {
      Object.defineProperty(process, 'platform', { value: original, configurable: true });
    }
  });

  it('refuses an empty allowlist (would block all syscalls including exit)', () => {
    // We construct a synthetic call that DOES make it past the platform
    // gate by temporarily flipping process.platform to 'linux' (the
    // host IS linux on this dev box, so the gate is normally a no-op;
    // we leave it as-is and just test the policy refusal). The shim
    // will fail because we're running in the test process — but the
    // empty-allowlist check happens before the shim call, so we get
    // a clean refusal.
    expect(() =>
      applySeccomp({ policy: 'allowlist', allowedSyscalls: [] }),
    ).toThrow(/empty allowlist/);
  });
});
