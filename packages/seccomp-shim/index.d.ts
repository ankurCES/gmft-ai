// Type definitions for @gmft/seccomp-shim.
// Hand-written — there is no upstream @types for a "seccomp(2) N-API
// shim" because we built this one in-house (the surface is small
// enough to be self-describing).
//
// The shim has three runtime functions and one constants table. It
// does NOT build or interpret BPF programs — that is the JS emitter's
// job. The shim is the syscall boundary; the JS emitter is the
// policy boundary.

export interface SeccompConstants {
  // prctl(2) constants
  PR_SET_NO_NEW_PRIVS: number;     // 38
  PR_SET_SECCOMP: number;          // 22
  PR_GET_SECCOMP: number;          // 21

  // seccomp(2) return values (also returned by prctl(PR_GET_SECCOMP))
  SECCOMP_MODE_DISABLED: number;   // 0
  SECCOMP_MODE_STRICT: number;     // 1
  SECCOMP_MODE_FILTER: number;     // 2

  // seccomp(2) op codes
  SECCOMP_SET_MODE_STRICT: number; // 0
  SECCOMP_SET_MODE_FILTER: number; // 1

  // installBpf() flags
  SECCOMP_FILTER_FLAG_TSYNC: number;        // 1 << 0
  SECCOMP_FILTER_FLAG_LOG: number;          // 1 << 1
  SECCOMP_FILTER_FLAG_SPEC_ALLOW: number;   // 1 << 2
  SECCOMP_FILTER_FLAG_NEW_LISTENER: number; // 1 << 3
  SECCOMP_FILTER_FLAG_TSYNC_ESRCH: number;  // 1 << 4
}

/**
 * The seccomp binding. Throws on every method if the kernel does not
 * support seccomp; call `prctlGetSeccomp()` first and treat a return
 * of 0 (DISABLED) as "kernel has seccomp available, no filter yet".
 */
export interface Seccomp {
  readonly constants: SeccompConstants;

  /**
   * Reports the architecture the kernel sees this process as. The
   * BPF emitter in bpf.ts uses this to pick the right
   * SECCOMP_AUDIT_ARCH_NATIVE constant for x86_64 vs aarch64 vs etc.
   */
  arch(): 'x86_64' | 'i386' | 'aarch64' | 'arm' | 's390x' | 's390' | 'powerpc64' | 'powerpc' | 'riscv64' | 'mips64' | 'mips' | 'unknown';

  /**
   * Set PR_SET_NO_NEW_PRIVS. MUST be called before installBpf()
   * (seccomp(2) returns EACCES otherwise). This is a one-way trip
   * for the calling process: subsequent execve()s can no longer
   * gain new privileges.
   */
  prctlSetNoNewPrivs(): void;

  /**
   * Return the current seccomp mode of the calling thread:
   * 0=disabled, 1=strict, 2=filter. Throws on a kernel without
   * seccomp (ENOSYS).
   */
  prctlGetSeccomp(): number;

  /**
   * Install a BPF program. `bpfBytes` is a Buffer of length
   * `instructionCount * 8` (each sock_filter is 8 bytes:
   * {u16 code, u8 jt, u8 jf, u32 k} in little-endian). The shim
   * does NOT validate the BPF semantics — the JS emitter is the
   * single source of truth. Throws with `.code = 'ESECCOMP'` on
   * EACCES (no_new_privs not set) or EFAULT (bad buffer) or EINVAL
   * (bad BPF).
   */
  installBpf(bpfBytes: Buffer, flags?: number): void;
}
