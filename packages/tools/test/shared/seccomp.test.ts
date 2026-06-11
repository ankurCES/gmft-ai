import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { seccompAvailable, _resetSeccompForTest } from '../../src/shared/seccomp';

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
