import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { assertBinary, isPrereqCheckSkipped } from '../../src/shared/prereq.js';

describe('assertBinary', () => {
  it('returns the path of a binary that exists', () => {
    const path = assertBinary('node');
    expect(path).toMatch(/node/);
  });

  it('throws with a remediation hint for a missing binary', () => {
    expect(() => assertBinary('definitely-not-a-real-binary-xyz', 'install it')).toThrow(
      /Required binary not found/,
    );
    try {
      assertBinary('definitely-not-a-real-binary-xyz', 'install it');
    } catch (err) {
      expect((err as Error).message).toMatch(/install it/);
    }
  });

  it('includes the binary name in the error message', () => {
    expect(() => assertBinary('totally-fake-binary-abc')).toThrow(/totally-fake-binary-abc/);
  });
});

describe('isPrereqCheckSkipped', () => {
  const original = process.env.GMFT_SKIP_PREREQ;
  beforeEach(() => {
    delete process.env.GMFT_SKIP_PREREQ;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.GMFT_SKIP_PREREQ;
    else process.env.GMFT_SKIP_PREREQ = original;
  });

  it('returns false by default', () => {
    expect(isPrereqCheckSkipped()).toBe(false);
  });

  it('returns true when GMFT_SKIP_PREREQ=1', () => {
    process.env.GMFT_SKIP_PREREQ = '1';
    expect(isPrereqCheckSkipped()).toBe(true);
  });
});
