// @gmft/tools — seccomp capability probe.
//
// v0.2.D does NOT auto-apply seccomp. The probe exists so the
// chokepoint, the audit log, and the TUI can all read the same
// capability snapshot. (The BPF filter + preExec apply is v0.3
// stretch — see ADR-0011.)
//
// Detection approach: read /proc/self/status and look for
// `Seccomp:` line. Values are 0 (disabled), 1 (strict), 2 (filter).
// We do not need to actually call prctl(PR_GET_SECCOMP) — reading
// the proc status is enough for the probe and avoids any side effects.

import { readFileSync } from 'node:fs';

export interface SeccompStatus {
  available: boolean;
  mode: 'disabled' | 'strict' | 'filter' | 'unknown';
}

let cached: SeccompStatus | null = null;

/**
 * Probe seccomp support on the current host. Returns a SeccompStatus
 * snapshot. Non-Linux is always `available: false, mode: 'disabled'`.
 */
export function seccompAvailable(): SeccompStatus {
  if (cached) return cached;
  if (process.platform !== 'linux') {
    cached = { available: false, mode: 'disabled' };
    return cached;
  }
  const mode = readSeccompMode();
  cached = {
    available: mode === 'strict' || mode === 'filter',
    mode,
  };
  return cached;
}

function readSeccompMode(): SeccompStatus['mode'] {
  try {
    const text = readFileSync('/proc/self/status', 'utf-8');
    const match = text.match(/^Seccomp:\s+(\d+)/m);
    if (!match) return 'unknown';
    const n = Number.parseInt(match[1] ?? '', 10);
    if (n === 0) return 'disabled';
    if (n === 1) return 'strict';
    if (n === 2) return 'filter';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Test-only: bust the probe cache. */
export function _resetSeccompForTest(): void {
  cached = null;
}
