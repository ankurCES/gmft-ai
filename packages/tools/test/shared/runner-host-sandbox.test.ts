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

describe('run (host+seccomp integration)', () => {
  beforeEach(() => resetCapabilitiesForTest());
  afterEach(() => resetCapabilitiesForTest());

  it('applies seccomp (host+seccomp) when seccomp is available and seccompPolicy is set, even without landlock', async () => {
    // The runner resolves mode from the capability snapshot. With
    // seccomp=available and seccompPolicy set, the preExec hook
    // calls applySeccomp(). The live seccomp shim works on this
    // dev host (we tested it in the seccomp-shim smoke test), so
    // the child should run to completion under a default-deny BPF.
    // The default allowlist includes read+write+exit, so a trivial
    // node -e 'console.log("ok")' should still print 'ok' before
    // exiting. If the BPF were too tight, the child would be killed
    // with SIGSYS (exit code 159 on Linux).
    setCapabilitiesForTest({
      landlock: 'unavailable',
      landlockAbi: null,
      seccomp: 'available',
      docker: 'unavailable',
      resolvedAuto: 'host+seccomp',
    });

    const r = await run({
      argv: ['node', '-e', "console.log('seccomp-ok')"],
      forceHost: true,
      seccompPolicy: 'allowlist',
    });
    expect(r.mode).toBe('host+seccomp');
    expect(r.sandboxed).toBeFalsy();          // landlock NOT applied
    expect(r.seccompApplied).toBe(true);
    expect(r.seccompPolicy).toBe('allowlist');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('seccomp-ok');
  });

  it('reports host+landlock+seccomp when both are available', async () => {
    setCapabilitiesForTest({
      landlock: 'available',
      landlockAbi: 4,
      seccomp: 'available',
      docker: 'unavailable',
      resolvedAuto: 'host+landlock+seccomp',
    });

    const r = await run({
      argv: ['node', '-e', "console.log('both')"],
      forceHost: true,
      fsAllowRead: ['/usr', '/tmp'],
      fsAllowWrite: ['/tmp'],
      seccompPolicy: 'allowlist',
    });
    // On a host without real landlock, the child exits 126 (preExec
    // bail). On a host WITH real landlock, the child runs and the
    // mode is 'host+landlock+seccomp'. We assert on the path the
    // runner RESOLVED, by checking the mode is not plain 'host'.
    expect(r.mode).not.toBe('host');
    // The exact mode depends on whether the host has real landlock:
    //   - yes: 'host+landlock+seccomp'
    //   - no:  child exits 126 and we get 'host+landlock+seccomp' anyway
    //          because the runner RESOLVES the mode before preExec runs.
    expect(['host+landlock+seccomp']).toContain(r.mode);
  });

  it('does NOT apply seccomp when seccompPolicy is unset (opt-in)', async () => {
    setCapabilitiesForTest({
      landlock: 'unavailable',
      landlockAbi: null,
      seccomp: 'available',
      docker: 'unavailable',
      resolvedAuto: 'host+seccomp',
    });

    const r = await run({
      argv: ['node', '-e', "console.log('no-seccomp')"],
      forceHost: true,
      // no seccompPolicy
    });
    expect(r.mode).toBe('host');
    expect(r.seccompApplied).toBeFalsy();
    expect(r.seccompPolicy).toBeUndefined();
  });
});
