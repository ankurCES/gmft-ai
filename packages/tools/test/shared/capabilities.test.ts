import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runnerCapabilities, setCapabilitiesForTest, resetCapabilitiesForTest, type RunnerCapabilities } from '../../src/shared/capabilities';

describe('runnerCapabilities', () => {
  beforeEach(() => resetCapabilitiesForTest());
  afterEach(() => resetCapabilitiesForTest());

  it('returns a RunnerCapabilities object with all expected fields', () => {
    const caps = runnerCapabilities();
    expect(caps).toBeTypeOf('object');
    expect(['available', 'unavailable', 'denied']).toContain(caps.landlock);
    expect(['available', 'unavailable', 'denied']).toContain(caps.seccomp);
    expect(['available', 'unavailable', 'denied']).toContain(caps.docker);
    expect(caps.landlockAbi === null || typeof caps.landlockAbi === 'number').toBe(true);
    expect(['host', 'host+landlock', 'docker']).toContain(caps.resolvedAuto);
  });

  it('setCapabilitiesForTest overrides the snapshot; resetCapabilitiesForTest restores the live probe', () => {
    const fake: RunnerCapabilities = {
      landlock: 'available',
      landlockAbi: 4,
      seccomp: 'available',
      docker: 'unavailable',
      resolvedAuto: 'host+landlock',
    };
    setCapabilitiesForTest(fake);
    expect(runnerCapabilities()).toEqual(fake);

    resetCapabilitiesForTest();
    const live = runnerCapabilities();
    // The live probe may differ, but the test seam should be gone.
    expect(live).not.toBe(fake);
  });

  it('default snapshot reports unavailable landlock on a host without kernel support (this dev host)', () => {
    resetCapabilitiesForTest();
    const caps = runnerCapabilities();
    // This dev host has no landlock in the kernel. The probe must
    // report unavailable. If a real landlock kernel is added later,
    // this test will need to be re-evaluated.
    expect(caps.landlock).toBe('unavailable');
    expect(caps.landlockAbi).toBeNull();
  });
});
