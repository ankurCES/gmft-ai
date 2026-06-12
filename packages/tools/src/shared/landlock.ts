// @gmft/tools — host-side landlock integration.
//
// This file is the consumer-side wrapper around @gmft/landlock-shim.
// The shim is a thin N-API binding to the Linux landlock LSM
// (sys_landlock_create_ruleset / sys_landlock_add_rule /
// sys_landlock_restrict_self). This file adds three things the shim
// does NOT do:
//
//   1. Platform gate (non-Linux → unavailable, no syscall attempted).
//   2. ABI version validation. Landlock ABI is 1-7. A kernel that does
//      NOT have landlock enabled will return 8 from syscall 444 (the
//      kernel has reused that syscall for something else). We must
//      reject any ABI outside [1, 7] and report the host as
//      `available: false, reason: 'kernel-too-old'`.
//   3. The `applyLandlock()` function — convenience wrapper that
//      builds the ruleset, calls the shim, and translates errors.
//
// See docs/superpowers/plans/2026-06-17-gmft-v0.2-D-host-sandbox.md
// Amendment 1 for the rationale on each of the above.

import { readFileSync } from 'node:fs';

/**
 * Landlock ABI version range. The shim can return up to 8 from a
 * kernel that reuses the syscall number; we treat anything outside
 * the canonical 1-7 range as "no landlock".
 */
export const LANDLOCK_ABI_MIN = 1;
export const LANDLOCK_ABI_MAX = 7;

/**
 * Snapshot of landlock support on the current host.
 *
 * - `available: true` means the kernel supports landlock AND the
 *   abiVersion is in [LANDLOCK_ABI_MIN, LANDLOCK_ABI_MAX].
 * - `available: false` means landlock is not usable here. The `reason`
 *   is one of:
 *   - `'unsupported-platform'`: process.platform !== 'linux'
 *   - `'kernel-too-old'`: kernel does not enable landlock (returns
 *      an out-of-range ABI, typically 8 from syscall 444 reuse)
 *   - `'probe-failed'`: the shim threw or returned a malformed value
 *   - `'sysctl-mismatch'`: getABI() reports an in-range ABI but the
 *      /proc/sys/kernel/landlock_abi_version sysctl disagrees
 */
export interface LandlockStatus {
  available: boolean;
  abiVersion: number | null;
  reason?: 'unsupported-platform' | 'kernel-too-old' | 'probe-failed' | 'sysctl-mismatch';
}

// Cache the probe — landlock support is a host-level constant for the
// life of the process. Tests can call _resetLandlockForTest() to bust
// the cache.
let cached: LandlockStatus | null = null;
// Test seam: see _setLandlockAvailableForTest(). When set, the probe
// returns this value instead of talking to the kernel.
let testOverride: LandlockStatus | null = null;

/**
 * Probe landlock availability. Returns a `LandlockStatus` snapshot.
 *
 * The probe is:
 *   1. Platform check: non-Linux → unavailable.
 *   2. Sysctl cross-check: read /proc/sys/kernel/landlock_abi_version.
 *      If it is present, parse it; if absent, the kernel was built
 *      without landlock. (We do not let the shim call be the sole
 *      ground truth — see Finding 2 in the plan.)
 *   3. Shim call: getABI(). If the shim returns a value outside
 *      [1, 7], we report `kernel-too-old` even if the sysctl was
 *      absent (the kernel reused the syscall number).
 *   4. Cross-validation: if the shim's ABI differs from the sysctl,
 *      we report `sysctl-mismatch` and prefer the shim's value
 *      (the sysctl can be stale; the shim does a fresh syscall).
 */
export function landlockAvailable(): LandlockStatus {
  if (testOverride) return testOverride;
  if (cached) return cached;

  if (process.platform !== 'linux') {
    cached = { available: false, abiVersion: null, reason: 'unsupported-platform' };
    return cached;
  }

  // 1. Sysctl cross-check (Finding 2).
  const sysctlAbi = readLandlockSysctl();

  // 2. Shim call.
  let shimAbi: number | null = null;
  let probeError: string | null = null;
  try {
    // Lazy-require so a missing/broken shim does not break the
    // consumer's import on non-Linux. On non-Linux we return early
    // above, so the require only runs on Linux.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const shim = require('@gmft/landlock-shim') as { getABI: () => number };
    const raw = shim.getABI();
    if (Number.isInteger(raw) && raw >= LANDLOCK_ABI_MIN && raw <= LANDLOCK_ABI_MAX) {
      shimAbi = raw;
    } else if (Number.isInteger(raw)) {
      // Out of range — kernel reuses syscall 444. Treat as unavailable.
      shimAbi = null;
    } else {
      probeError = 'shim returned non-integer';
    }
  } catch (err) {
    probeError = err instanceof Error ? err.message : String(err);
  }

  if (probeError) {
    cached = { available: false, abiVersion: null, reason: 'probe-failed' };
    return cached;
  }

  if (shimAbi === null) {
    cached = { available: false, abiVersion: null, reason: 'kernel-too-old' };
    return cached;
  }

  // 3. Sysctl cross-check.
  if (sysctlAbi !== null && sysctlAbi !== shimAbi) {
    // Prefer the shim (fresh syscall) but flag the mismatch so the
    // caller can show it in the audit log.
    cached = { available: true, abiVersion: shimAbi, reason: 'sysctl-mismatch' };
    return cached;
  }

  cached = { available: true, abiVersion: shimAbi };
  return cached;
}

function readLandlockSysctl(): number | null {
  try {
    const raw = readFileSync('/proc/sys/kernel/landlock_abi_version', 'utf-8').trim();
    const n = Number.parseInt(raw, 10);
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

/** Test-only: bust the probe cache. */
export function _resetLandlockForTest(): void {
  cached = null;
  testOverride = null;
}

/**
 * Test-only: inject a `LandlockStatus` to return from
 * `landlockAvailable()` regardless of the live probe. Used to
 * simulate "landlock not available" hosts (e.g. the CI runner's
 * kernel does support landlock, but the dev host that authored
 * the test does not). The override is cleared by
 * `_resetLandlockForTest()`.
 */
export function _setLandlockAvailableForTest(status: LandlockStatus | null): void {
  testOverride = status;
  cached = null;
}

/** Options for `applyLandlock()`. All fields are optional; pass at least one allowlist. */
export interface LandlockApplyOpts {
  fsAllowRead?: string[];
  fsAllowWrite?: string[];
  fsAllowMakeReg?: string[];
}

/**
 * Apply a landlock ruleset to the CURRENT process (or the current
 * fork's child, when called from inside a `preExec` hook).
 *
 * The shim's `restrictSelf` is irreversible — once it returns
 * successfully, the calling process can never gain new privileges.
 * This function is therefore designed to be called from a `preExec`
 * hook in `child_process.spawn()`, where the restriction only
 * applies to the child.
 *
 * Throws if no allowlist is supplied (refusing to lock down the
 * child entirely, which would block its own argv/libs).
 */
export function applyLandlock(opts: LandlockApplyOpts): void {
  const { fsAllowRead = [], fsAllowWrite = [], fsAllowMakeReg = [] } = opts;
  if (fsAllowRead.length + fsAllowWrite.length + fsAllowMakeReg.length === 0) {
    throw new Error(
      'applyLandlock: refused to apply with no allowlist (would lock ' +
        'down the child entirely, blocking its own argv/libs). Pass at ' +
        'least one of fsAllowRead/fsAllowWrite/fsAllowMakeReg.',
    );
  }

  const status = landlockAvailable();
  if (!status.available || status.abiVersion === null) {
    throw new Error(
      `applyLandlock: landlock is not available on this host (${status.reason ?? 'unknown'}). ` +
        'The runner will fall back to plain host mode.',
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const shim = require('@gmft/landlock-shim') as {
    createRuleset: (attr?: number | bigint) => number;
    addRule: (fd: number, ruleType: number, allowedAccess: number | bigint, parent: string | number) => number;
    restrictSelf: (fd: number, flags: number) => number;
    close: (fd: number) => number;
    constants: Record<string, number | bigint>;
  };
  const c = shim.constants;
  const ruleTypePathBeneath = Number(c.LANDLOCK_RULE_PATH_BENEATH ?? 1);

  // Landlock ruleset attributes (ABI v1..v7). Bitwise OR'd together
  // for the createRuleset attr. The shim's constants table includes
  // all 7 ABI versions' worth of *_SET and *_FS_* bits; we OR the
  // ones we plan to use.
  //
  // Note: even though the shim exports these as BigInt, the actual
  // values fit in a regular JS number (the full ABI-7 access mask
  // is <2^16, well under 2^53). We do a `Number()` conversion to
  // avoid forcing BigInt math on the call site.
  const rulesetAttr =
    Number(c.LANDLOCK_ACCESS_FS_READ_FILE ?? 0) |
    Number(c.LANDLOCK_ACCESS_FS_WRITE_FILE ?? 0) |
    Number(c.LANDLOCK_ACCESS_FS_MAKE_REG ?? 0);

  let fd: number;
  try {
    fd = shim.createRuleset(rulesetAttr);
  } catch (err) {
    throw new Error(`applyLandlock: createRuleset failed: ${err instanceof Error ? err.message : err}`);
  }
  if (fd < 0) {
    throw new Error(`applyLandlock: createRuleset returned ${fd}`);
  }

  try {
    for (const path of fsAllowRead) {
      const r = shim.addRule(fd, ruleTypePathBeneath, c.LANDLOCK_ACCESS_FS_READ_FILE ?? 0, path);
      if (r !== 0) throw new Error(`addRule(READ, ${path}) returned ${r}`);
    }
    for (const path of fsAllowWrite) {
      // ABI v2+ allows combining WRITE_FILE + WRITE/APPEND/TRUNCATE
      // via sub-access; the v1 fallback is just WRITE_FILE. The shim's
      // LANDLOCK_ACCESS_FS_WRITE_FILE is the right bit for v1; for v2+
      // the sub-bits (APPEND, TRUNCATE) live in the same constants table.
      const r = shim.addRule(fd, ruleTypePathBeneath, c.LANDLOCK_ACCESS_FS_WRITE_FILE ?? 0, path);
      if (r !== 0) throw new Error(`addRule(WRITE, ${path}) returned ${r}`);
    }
    for (const path of fsAllowMakeReg) {
      const r = shim.addRule(fd, ruleTypePathBeneath, c.LANDLOCK_ACCESS_FS_MAKE_REG ?? 0, path);
      if (r !== 0) throw new Error(`addRule(MAKE_REG, ${path}) returned ${r}`);
    }

    const rr = shim.restrictSelf(fd, 0);
    if (rr !== 0) {
      throw new Error(`restrictSelf returned ${rr}`);
    }
  } finally {
    shim.close(fd);
  }
}
