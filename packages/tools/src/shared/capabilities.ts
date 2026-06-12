// @gmft/tools — unified capability snapshot.
//
// A single `runnerCapabilities()` returns the live capability
// snapshot for the current process. This is the source of truth
// for the chokepoint, the TUI, and the audit log.
//
// Test seam: setCapabilitiesForTest() overrides the snapshot so
// tests can claim landlock is "available" without a real kernel
// that supports it. resetCapabilitiesForTest() clears the override
// and falls back to the live probes.

import { landlockAvailable, type LandlockStatus } from './landlock';
import { seccompAvailable, type SeccompStatus } from './seccomp';

export type CapabilityLevel = 'available' | 'unavailable' | 'denied';

export interface RunnerCapabilities {
  landlock: CapabilityLevel;
  landlockAbi: number | null;
  seccomp: CapabilityLevel;
  docker: CapabilityLevel;
  /**
   * The runner mode the host would resolve to for a tool that
   * does not pass `forceHost`. `host+landlock` only when landlock
   * is `available` AND the call passes an fs allowlist; for the
   * bare auto-resolution (no allowlist) we report `host`. Tests
   * can override this via `setCapabilitiesForTest`.
   */
  resolvedAuto: 'host' | 'host+landlock' | 'docker';
}

let testOverride: RunnerCapabilities | null = null;
let cached: RunnerCapabilities | null = null;

/** Build a fresh snapshot by calling the live probes. */
function probe(): RunnerCapabilities {
  const ll: LandlockStatus = landlockAvailable();
  const sc: SeccompStatus = seccompAvailable();
  const docker: CapabilityLevel = probeDocker();
  const landlock: CapabilityLevel = ll.available ? 'available' : 'unavailable';
  const resolvedAuto: RunnerCapabilities['resolvedAuto'] = docker === 'available' ? 'docker' : 'host';
  return {
    landlock,
    landlockAbi: ll.abiVersion,
    seccomp: sc.available ? 'available' : 'unavailable',
    docker,
    resolvedAuto,
  };
}

function probeDocker(): CapabilityLevel {
  // Avoid the spawnSync overhead when the test seam is set.
  if (testOverride) return testOverride.docker;
  if (process.env.GMFT_SKIP_PREREQ === '1') return 'unavailable';
  // `which docker` — but cheap: spawnSync is fast on PATH-hit.
  // We import here to avoid a top-level import for a child-process
  // call in the common case.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { spawnSync } = require('node:child_process') as typeof import('node:child_process');
  const which = process.platform === 'win32' ? 'where' : 'which';
  const r = spawnSync(which, ['docker'], { encoding: 'utf-8' });
  return r.status === 0 ? 'available' : 'unavailable';
}

/**
 * Return the runner capability snapshot. Cached after the first
 * call (capabilities are stable for the life of the process). Tests
 * call `resetCapabilitiesForTest()` to bust the cache.
 */
export function runnerCapabilities(): RunnerCapabilities {
  if (testOverride) return testOverride;
  if (!cached) cached = probe();
  return cached;
}

/** Test-only: inject a capability snapshot without touching the host. */
export function setCapabilitiesForTest(snap: RunnerCapabilities): void {
  testOverride = snap;
  // No cache reset — the override takes precedence over the cache
  // on every call.
}

/** Test-only: drop the injected snapshot AND the probe cache. */
export function resetCapabilitiesForTest(): void {
  testOverride = null;
  cached = null;
}
