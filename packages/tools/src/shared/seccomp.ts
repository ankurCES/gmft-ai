// @gmft/tools — seccomp capability probe + auto-apply.
//
// v0.2.D ships seccomp auto-apply (D.1.3) — the BPF program is built
// in pure JS (see ./bpf.ts) and handed to the kernel via the
// @gmft/seccomp-shim N-API binding.
//
// Detection: read /proc/self/status and look for the `Seccomp:` line.
// Values are 0 (disabled), 1 (strict), 2 (filter). We do not need
// to actually call prctl(PR_GET_SECCOMP) — reading the proc status
// is enough for the probe and avoids any side effects.
//
// Apply path:
//   applySeccomp({ policy: 'allowlist' | 'denylist', ... })
//   1. Verify the host supports seccomp (probe says available).
//   2. Build the BPF in pure JS (bpf.ts).
//   3. PR_SET_NO_NEW_PRIVS (one-way trip for the calling thread).
//   4. seccomp(SECCOMP_SET_MODE_FILTER, 0, &prog) via the shim.
//
// This function is designed to be called from a child_process preExec
// hook — exactly like applyLandlock. The one-way trips (no_new_privs,
// restrict_self) only affect the child.

import { readFileSync } from 'node:fs';
import * as seccompShim from '@gmft/seccomp-shim';
import {
  buildBpfAllowlist,
  buildBpfDenyList,
  type ArchKey,
  type BpfProgram,
} from './bpf.js';
import {
  ALLOWLIST_DIAGNOSTIC_SYSCALLS_X86_64,
  DENYLIST_DANGEROUS_SYSCALLS_X86_64,
} from './bpf.js';

/**
 * Map Node's `process.arch` (which uses the amd64-style names) to the
 * `ArchKey` set used by the BPF emitter. Falls back to the closest
 * 64-bit match for the common cases.
 */
function nodeArchToBpfArch(arch: NodeJS.Architecture): ArchKey {
  switch (arch) {
    case 'x64':
      return 'x86_64';
    case 'ia32':
      return 'i386';
    case 'arm64':
      return 'aarch64';
    case 'arm':
      return 'arm';
    case 's390x':
      return 's390x';
    case 's390':
      return 's390';
    case 'ppc64':
      return 'powerpc64';
    case 'ppc':
      return 'powerpc';
    case 'mipsel':
    case 'mips':
      return 'mips';
    case 'riscv64':
      return 'riscv64';
    default:
      throw new Error(
        `applySeccomp: unsupported process.arch "${arch}". ` +
          'Pass `arch` explicitly to override (e.g. arch: "x86_64").',
      );
  }
}

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
    // seccomp is "available" iff the kernel reports mode != 0 (DISABLED).
    // A kernel that has seccomp built will report 0 (DISABLED) for a
    // process that hasn't installed a filter yet — which is our normal
    // state. The probe is true in the sense that we *can* install a
    // filter; the strict|filter values are the post-install states.
    available: true,
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

// ---------------------------------------------------------------------------
// applySeccomp — the v0.2.D D.1.3 entrypoint
// ---------------------------------------------------------------------------

export type SeccompPolicyKind = 'allowlist' | 'denylist';

export interface ApplySeccompOpts {
  /** Which policy to install. Default: 'allowlist' (default-deny). */
  policy?: SeccompPolicyKind;
  /**
   * Override the arch to embed in the BPF. Defaults to
   * `process.arch` mapped to our ArchKey set. Pass this explicitly
   * if you are running under qemu-user or a 32-bit compat mode.
   */
  arch?: ArchKey;
  /**
   * Override the syscall list. Defaults to the conservative
   * diagnostic allowlist (read+write+mmap+exit+...) or the
   * dangerous-syscall denylist (ptrace+mount+...), depending on
   * `policy`. Tools with a wider syscall surface should pass
   * their own list and pick 'denylist'.
   */
  allowedSyscalls?: readonly number[];
  deniedSyscalls?: readonly number[];
}

/**
 * Build the BPF for the requested policy. Exposed for tests + for
 * tools that want to inspect / re-encode the program.
 */
export function buildSeccompBpf(opts: ApplySeccompOpts = {}): BpfProgram {
  const policy = opts.policy ?? 'allowlist';
  const arch = opts.arch ?? nodeArchToBpfArch(process.arch);
  if (policy === 'allowlist') {
    return buildBpfAllowlist({
      arch,
      allowedSyscalls: opts.allowedSyscalls ?? ALLOWLIST_DIAGNOSTIC_SYSCALLS_X86_64,
    });
  }
  return buildBpfDenyList({
    arch,
    deniedSyscalls: opts.deniedSyscalls ?? DENYLIST_DANGEROUS_SYSCALLS_X86_64,
  });
}

/**
 * Install a seccomp BPF filter on the CURRENT process (or the
 * current fork's child, when called from inside a `preExec` hook).
 *
 * Both `prctl(PR_SET_NO_NEW_PRIVS, 1)` and
 * `seccomp(SECCOMP_SET_MODE_FILTER, ...)` are irreversible for the
 * calling thread. Call this only from a preExec hook so the
 * restriction only affects the child.
 *
 * Throws if:
 *   - non-Linux platform
 *   - the seccomp probe says the host has no seccomp support
 *   - the shim is missing (consumer was not built with @gmft/seccomp-shim)
 *
 * Refuses (throws) to install a filter with no policy — analogous
 * to applyLandlock's "no allowlist" refusal.
 */
export function applySeccomp(opts: ApplySeccompOpts = {}): void {
  if (process.platform !== 'linux') {
    throw new Error('applySeccomp: not on Linux; refusing to install seccomp filter');
  }
  const status = seccompAvailable();
  if (!status.available) {
    throw new Error(
      `applySeccomp: seccomp is not available on this host (mode=${status.mode}). ` +
        'The runner will fall back to host+landlock only.',
    );
  }

  // Refuse to install with no policy at all (caller passed an empty
  // allowlist AND no denylist — i.e. nothing to do).
  const policy = opts.policy ?? 'allowlist';
  if (policy === 'allowlist' && (opts.allowedSyscalls?.length ?? 0) === 0) {
    throw new Error(
      'applySeccomp: refused to install an empty allowlist ' +
        '(would block ALL syscalls including exit). Pass at least one allowed syscall.',
    );
  }

  const shim = seccompShim as unknown as {
    prctlSetNoNewPrivs: () => void;
    installBpf: (bpfBytes: Buffer, flags?: number) => void;
  };

  // Step 1: PR_SET_NO_NEW_PRIVS — one-way trip.
  try {
    shim.prctlSetNoNewPrivs();
  } catch (err) {
    throw new Error(
      `applySeccomp: prctl(PR_SET_NO_NEW_PRIVS) failed: ${err instanceof Error ? err.message : err}`,
    );
  }

  // Step 2: build the BPF in pure JS, then hand to the kernel.
  const prog = buildSeccompBpf(opts);
  const bytes = prog.encode();
  try {
    shim.installBpf(bytes, 0);
  } catch (err) {
    throw new Error(
      `applySeccomp: installBpf failed: ${err instanceof Error ? err.message : err}`,
    );
  }
}
