import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { run } from '../../src/shared/runner';
import { setCapabilitiesForTest, resetCapabilitiesForTest, type RunnerCapabilities } from '../../src/shared/capabilities';

describe('run (host+landlock integration)', () => {
  beforeEach(() => resetCapabilitiesForTest());
  afterEach(() => resetCapabilitiesForTest());

  it('falls back to plain host (no landlock) on a host without landlock, even with an allowlist', async () => {
    // Force a "no landlock" capabilities snapshot.
    setCapabilitiesForTest({
      landlock: 'unavailable',
      landlockAbi: null,
      seccomp: 'unavailable',
      docker: 'unavailable',
      resolvedAuto: 'host',
    });

    const r = await run({
      argv: ['node', '-e', "console.log('hello from runner')"],
      forceHost: true,
      fsAllowRead: ['/usr', '/tmp'],
      fsAllowWrite: ['/tmp'],
    });
    expect(r.mode).toBe('host');
    expect(r.sandboxed).toBeFalsy();
    expect(r.landlockAbi).toBeUndefined();
    expect(r.landlockPaths).toBeUndefined();
  });

  it('reports host+landlock mode in result metadata when landlock is "available" in the test seam', async () => {
    // The runner reads runnerCapabilities() to decide whether to apply
    // landlock. We override the snapshot to claim landlock is available;
    // the runner will then wire the preExec hook. The preExec hook
    // will call applyLandlock(), which itself calls landlockAvailable()
    // — the LIVE probe, not the test seam. On this dev host the live
    // probe says unavailable, so applyLandlock() will throw, preExec
    // will process.exit(126), and the child will fail. We tolerate
    // either outcome (success-on-a-host-with-landlock OR exit-126 here)
    // and only assert on the resolved mode in the *failed* run.
    //
    // The clean way to assert on the mode+paths is to assert on the
    // call path before the child runs. We do that by checking the
    // resolved mode on a run that fails with exit 126.
    setCapabilitiesForTest({
      landlock: 'available',
      landlockAbi: 4,
      seccomp: 'unavailable',
      docker: 'unavailable',
      resolvedAuto: 'host+landlock',
    });

    const r = await run({
      argv: ['node', '-e', "console.log('sandboxed')"],
      forceHost: true,
      fsAllowRead: ['/usr', '/tmp'],
      fsAllowWrite: ['/tmp'],
    });
    // On a host without real landlock, the child exits 126 (preExec
    // bail). On a host WITH real landlock, the child runs to completion
    // and returns mode 'host+landlock'. We assert the runner's path
    // resolution by checking that we are NOT in plain 'host' mode.
    expect(r.mode).not.toBe('host');
    expect(['host+landlock']).toContain(r.mode);
  });

  it('reports plain host (not host+landlock) when no allowlist is passed', async () => {
    setCapabilitiesForTest({
      landlock: 'available',
      landlockAbi: 4,
      seccomp: 'unavailable',
      docker: 'unavailable',
      resolvedAuto: 'host+landlock',
    });

    const r = await run({
      argv: ['node', '-e', "console.log('hi')"],
      forceHost: true,
      // no fsAllowRead/Write/MakeReg
    });
    expect(r.mode).toBe('host');
    expect(r.sandboxed).toBeFalsy();
  });
});
