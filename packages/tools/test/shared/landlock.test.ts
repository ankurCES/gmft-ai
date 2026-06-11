import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { landlockAvailable, applyLandlock, _resetLandlockForTest, LANDLOCK_ABI_MIN, LANDLOCK_ABI_MAX } from '../../src/shared/landlock';

describe('landlockAvailable', () => {
  // Force a fresh probe for each test so prior tests don't pollute the cache.
  beforeEach(() => _resetLandlockForTest());
  afterEach(() => _resetLandlockForTest());

  it('returns available:false, abiVersion:null, reason:unsupported-platform on non-Linux', () => {
    const original = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    try {
      const s = landlockAvailable();
      expect(s).toEqual({ available: false, abiVersion: null, reason: 'unsupported-platform' });
    } finally {
      Object.defineProperty(process, 'platform', { value: original, configurable: true });
    }
  });

  it('rejects an out-of-range ABI returned by the shim (Finding 1 — kernel reuses syscall 444)', () => {
    // This dev host returns 8 from the shim (no landlock in the kernel).
    // The probe MUST classify this as unavailable, not available: true with abiVersion: 8.
    const s = landlockAvailable();
    if (s.abiVersion !== null) {
      // If the host happens to have a real landlock ABI, the value
      // MUST be in [LANDLOCK_ABI_MIN, LANDLOCK_ABI_MAX].
      expect(s.abiVersion).toBeGreaterThanOrEqual(LANDLOCK_ABI_MIN);
      expect(s.abiVersion).toBeLessThanOrEqual(LANDLOCK_ABI_MAX);
    } else {
      // The probe correctly reported unavailable.
      expect(s.available).toBe(false);
      expect(s.reason).toMatch(/kernel-too-old|unsupported-platform|probe-failed|sysctl-mismatch/);
    }
  });
});

describe('applyLandlock', () => {
  beforeEach(() => _resetLandlockForTest());
  afterEach(() => _resetLandlockForTest());

  it('throws when called with no allowlist (refuses to lock down the child entirely)', () => {
    expect(() => applyLandlock({})).toThrowError(/no allowlist/i);
  });

  it('throws with a clear remediation message when landlock is not available', () => {
    // This dev host has no landlock; applyLandlock must refuse rather
    // than silently no-op.
    expect(() => applyLandlock({ fsAllowRead: ['/usr'] })).toThrowError(/not available/i);
  });
});
