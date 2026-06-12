// @gmft/tools — pure-JS seccomp BPF program emitter.
//
// seccomp(2) takes a `struct sock_fprog` — a length and a pointer to
// an array of `struct sock_filter`. Each filter is 8 bytes:
// {u16 code, u8 jt, u8 jf, u32 k}. The kernel evaluates the program
// like a tiny register machine; the register is `A` (a u32 accumulator).
//
// This file is the *only* place in the workspace that knows how to
// build a seccomp BPF program. The shim (@gmft/seccomp-shim) just
// hands the bytes to the kernel; the policy lives here, and the
// unit tests assert on the emitted byte sequence directly (no
// kernel call required).
//
// Two policies are exported:
//
//   buildBpfAllowlist({ arch, allowedSyscalls })
//     Default-deny. The child may call ONLY the syscalls in
//     `allowedSyscalls`. Anything else is killed with SIGSYS.
//
//   buildBpfDenyList({ arch, deniedSyscalls })
//     Default-allow. The child may call anything EXCEPT the
//     syscalls in `deniedSyscalls`. Used by tools that need a wide
//     syscall surface (nmap, sqlmap, etc.) — we still want to
//     block ptrace, kexec_load, mount, personality, etc.
//
// Both policies:
//   1. Verify seccomp_data.arch == expected (kill on mismatch —
//      guards against the 32-bit compat syscall table).
//   2. Load seccomp_data.nr.
//   3. Branch on nr.
//
// The arch constant is one of the SECCOMP_AUDIT_ARCH_* values in
// <linux/audit.h>. We pin the constants we need here so the emitter
// has no runtime deps.

import { Buffer } from 'node:buffer';

// ---------------------------------------------------------------------------
// BPF opcodes (subset — only what seccomp filters need).
// Source: <linux/filter.h>. Kept here as named constants so the
// emitted byte sequence is readable when traced through hexdump.
// ---------------------------------------------------------------------------

// Instruction classes
const BPF_LD = 0x00;
const BPF_LDX = 0x01;
const BPF_ST = 0x02;
const BPF_STX = 0x03;
const BPF_ALU = 0x04;
const BPF_JMP = 0x05;
const BPF_RET = 0x06;
const BPF_MISC = 0x07;

// LD size field
const BPF_W = 0x00;
const BPF_H = 0x08;
const BPF_B = 0x10;

// LD mode field
const BPF_IMM = 0x00;
const BPF_ABS = 0x20;
const BPF_IND = 0x40;
const BPF_MEM = 0x60;
const BPF_LEN = 0x80;
const BPF_MSH = 0xa0;

// JMP op
const BPF_JA = 0x00;
const BPF_JEQ = 0x10;
const BPF_JGT = 0x20;
const BPF_JGE = 0x30;
const BPF_JSET = 0x40;

// SRC field for JMP (unused for our purposes; we always K)
const BPF_K = 0x00;
const BPF_X = 0x08;

// SECCOMP_RET_* high half-words. SECCOMP_RET_ALLOW is the special
// "0x7fff0000" value that the kernel tests for explicitly — DO NOT
// change without checking <linux/seccomp.h>.
const SECCOMP_RET_KILL_THREAD = 0x00000000;
const SECCOMP_RET_KILL_PROCESS = 0x80000000;
const SECCOMP_RET_TRAP = 0x00030000;
const SECCOMP_RET_ERRNO = 0x00050000;
const SECCOMP_RET_ALLOW = 0x7fff0000;

// ---------------------------------------------------------------------------
// Audit arch constants. The values matter: the kernel compares
// `seccomp_data.arch` against the one the filter embeds. Mismatch
// → SECCOMP_RET_KILL (we want to fail-closed on 32-bit compat calls
// so a tool can't bypass the filter with `int 0x80`).
// ---------------------------------------------------------------------------
const AUDIT_ARCH = {
  x86_64: 0xc000003e,    // __AUDIT_ARCH_64BIT | __AUDIT_ARCH_LE | EM_X86_64
  i386: 0x40000003,      // __AUDIT_ARCH_LE | EM_386
  aarch64: 0xc00000b7,   // __AUDIT_ARCH_64BIT | __AUDIT_ARCH_LE | EM_AARCH64
  arm: 0x40000028,       // __AUDIT_ARCH_LE | EM_ARM
  s390x: 0xc0000016,     // __AUDIT_ARCH_64BIT | EM_S390
  riscv64: 0xc00000f3,   // __AUDIT_ARCH_64BIT | __AUDIT_ARCH_LE | EM_RISCV
  mips64: 0xc0000005,    // __AUDIT_ARCH_64BIT | __AUDIT_ARCH_LE | EM_MIPS
  powerpc64: 0xc000000f, // __AUDIT_ARCH_64BIT | EM_PPC64
  powerpc: 0x40000014,   // EM_PPC
  s390: 0x40000016,      // EM_S390
  mips: 0x40000008,      // __AUDIT_ARCH_LE | EM_MIPS
} as const;

export type ArchKey = keyof typeof AUDIT_ARCH;

export function auditArchFor(arch: string): number {
  const k = arch as ArchKey;
  const v = AUDIT_ARCH[k];
  if (v === undefined) {
    throw new Error(`auditArchFor: unknown arch ${arch}`);
  }
  return v;
}

// ---------------------------------------------------------------------------
// BPF program representation
// ---------------------------------------------------------------------------

/**
 * A single BPF instruction. We use a typed array of {code, jt, jf, k}
 * internally; the on-the-wire format is exactly the in-memory layout
 * (struct sock_filter is packed, no padding, little-endian).
 */
export interface BpfInsn {
  code: number;
  jt: number;
  jf: number;
  k: number;
}

/**
 * A complete BPF program. Use `encodeBpf()` to serialize to a Buffer
 * for the seccomp shim's installBpf().
 */
export class BpfProgram {
  readonly insns: BpfInsn[];
  constructor(insns: BpfInsn[]) {
    this.insns = insns;
  }
  /** Number of instructions. Must fit in uint16 (seccomp limit). */
  get length(): number {
    return this.insns.length;
  }
  /** Encode as a Buffer of insns.length * 8 bytes, little-endian. */
  encode(): Buffer {
    const buf = Buffer.alloc(this.insns.length * 8);
    for (let i = 0; i < this.insns.length; i++) {
      const ins = this.insns[i]!;
      const off = i * 8;
      buf.writeUInt16LE(ins.code, off);
      buf.writeUInt8(ins.jt, off + 2);
      buf.writeUInt8(ins.jf, off + 3);
      buf.writeUInt32LE(ins.k, off + 4);
    }
    return buf;
  }
}

// ---------------------------------------------------------------------------
// Instruction builders
// ---------------------------------------------------------------------------

/** LD A, [k]  (BPF_LD | BPF_W | BPF_ABS) — load 32-bit word at packet offset k. */
function ldAbs(k: number): BpfInsn {
  return { code: BPF_LD | BPF_W | BPF_ABS, jt: 0, jf: 0, k };
}

/** JEQ #k, jt, jf  (BPF_JMP | BPF_JEQ | BPF_K) — jump relative to A vs k. */
function jeqK(k: number, jt: number, jf: number): BpfInsn {
  return { code: BPF_JMP | BPF_JEQ | BPF_K, jt, jf, k };
}

/** JGE #k, jt, jf  (BPF_JMP | BPF_JGE | BPF_K) — jump if A >= k. */
function jgeK(k: number, jt: number, jf: number): BpfInsn {
  return { code: BPF_JMP | BPF_JGE | BPF_K, jt, jf, k };
}

/** RET #k  (BPF_RET | BPF_K) — return k. */
function retK(k: number): BpfInsn {
  return { code: BPF_RET | BPF_K, jt: 0, jf: 0, k };
}

// ---------------------------------------------------------------------------
// Seccomp data offsets (struct seccomp_data, <linux/seccomp.h>)
// ---------------------------------------------------------------------------
const SECCOMP_DATA_NR_OFFSET = 0;
const SECCOMP_DATA_ARCH_OFFSET = 4;

// ---------------------------------------------------------------------------
// Policy: allowlist
//
// Program layout:
//   [0] LD A, [4]                     // A = seccomp_data.arch
//   [1] JEQ #expected_arch, 0, M     // arch mismatch → M (=KILL)
//   [2] LD A, [0]                     // A = seccomp_data.nr
//   [3] JEQ #nr1, 0, 4               // nr1 → ALLOW
//   [4] JEQ #nr2, 0, 5               // nr2 → ALLOW
//   ...
//   [3 + N] JEQ #nrN, 0, M
//   [4 + N] RET ALLOW
//   [5 + N] RET KILL                  // label "M"
// ---------------------------------------------------------------------------

export interface AllowlistPolicyOpts {
  arch: ArchKey;
  /** Linux syscall numbers the child is allowed to invoke. */
  allowedSyscalls: readonly number[];
  /**
   * Action when an unlisted syscall is attempted. Defaults to
   * SECCOMP_RET_KILL_PROCESS (the child is killed immediately with
   * SIGSYS, no userspace handler). Can be set to SECCOMP_RET_ERRNO |
   * a low 16-bit errno to send EPERM back to the syscall caller
   * (the child sees -1 and errno=EPERM, can log and exit cleanly).
   */
  defaultAction?: number;
}

export function buildBpfAllowlist(opts: AllowlistPolicyOpts): BpfProgram {
  const { arch, allowedSyscalls, defaultAction = SECCOMP_RET_KILL_PROCESS } = opts;
  const archK = auditArchFor(arch);
  const insns: BpfInsn[] = [];

  // [0] load arch
  insns.push(ldAbs(SECCOMP_DATA_ARCH_OFFSET));
  // [1] arch check; mismatch → kill
  // (We will fix up the jf offset once we know the program length.)
  const archCheckIdx = insns.length;
  insns.push(jeqK(archK, 0, 0));
  // [2] load syscall nr
  insns.push(ldAbs(SECCOMP_DATA_NR_OFFSET));

  // chain: each JEQ, on match jump +2 (skip the KILL, land on the ALLOW
  // that follows it), on no match fall through +1 (next JEQ in chain).
  for (let i = 0; i < allowedSyscalls.length; i++) {
    const nr = allowedSyscalls[i]!;
    insns.push(jeqK(nr, 2, 1));
  }
  // After the last JEQ: KILL, then ALLOW.
  insns.push(retK(defaultAction));          // reached by chain falling off
  insns.push(retK(SECCOMP_RET_ALLOW));      // reached by chain match (jt=+2)

  // Fix up the arch check: jf should jump to the KILL (the second-to-last
  // insn, before ALLOW).
  const archCheck = insns[archCheckIdx]!;
  archCheck.jf = insns.length - 2 - archCheckIdx;

  return new BpfProgram(insns);
}

// ---------------------------------------------------------------------------
// Policy: denylist
//
// Same shape, but `deniedSyscalls` is checked; match → KILL, miss → ALLOW.
//
// Program layout:
//   [0] LD A, [4]                     // arch
//   [1] JEQ #expected_arch, 0, M
//   [2] LD A, [0]                     // nr
//   [3] JEQ #nr1, KILL, +1            // nr1 → KILL
//   [4] JEQ #nr2, KILL, +1
//   ...
//   [3 + N] ALLOW                     // reached by fall-through
// ---------------------------------------------------------------------------

export interface DenyListPolicyOpts {
  arch: ArchKey;
  /** Linux syscall numbers the child is FORBIDDEN from invoking. */
  deniedSyscalls: readonly number[];
  defaultAction?: number;
}

export function buildBpfDenyList(opts: DenyListPolicyOpts): BpfProgram {
  const { arch, deniedSyscalls, defaultAction = SECCOMP_RET_KILL_PROCESS } = opts;
  const archK = auditArchFor(arch);
  const insns: BpfInsn[] = [];

  // [0] load arch
  insns.push(ldAbs(SECCOMP_DATA_ARCH_OFFSET));
  // [1] arch check; mismatch → KILL (we want to fail-closed on 32-bit
  // compat calls; a 32-bit child isn't a use case for our tools).
  const archCheckIdx = insns.length;
  insns.push(jeqK(archK, 0, 0));
  // [2] load nr
  insns.push(ldAbs(SECCOMP_DATA_NR_OFFSET));

  // chain: each JEQ, on match jump +2 (skip past KILL+ALLOW to a fresh KILL? no...).
  // Easier: JEQ with jt=killOffset, jf=+1.
  // We'll compute killOffset after we know the program length.
  // For now, push with jt=0 jf=1 and fix jt after.
  const jeqIndices: number[] = [];
  for (let i = 0; i < deniedSyscalls.length; i++) {
    jeqIndices.push(insns.length);
    insns.push(jeqK(deniedSyscalls[i]!, 0, 1));
  }
  // After the chain: ALLOW (default).
  const allowIdx = insns.length;
  insns.push(retK(SECCOMP_RET_ALLOW));
  // KILL (reached by any chain match).
  const killIdx = insns.length;
  insns.push(retK(defaultAction));

  // Fix arch check: jf → killIdx (KILL on arch mismatch)
  const archCheck = insns[archCheckIdx]!;
  archCheck.jf = killIdx - archCheckIdx;

  // Fix each JEQ: jt → killIdx (KILL on match)
  for (const idx of jeqIndices) {
    const ins = insns[idx]!;
    ins.jt = killIdx - idx;
  }

  return new BpfProgram(insns);
}

// ---------------------------------------------------------------------------
// Convenience: build the BPF for a typical pentest tool (read-files-only).
// ---------------------------------------------------------------------------

/** A small, conservative allowlist for read-only diagnostics tools. */
export const ALLOWLIST_DIAGNOSTIC_SYSCALLS_X86_64: readonly number[] = Object.freeze([
  0,   // read
  1,   // write
  2,   // open
  3,   // close
  5,   // fstat
  8,   // lseek
  9,   // mmap
  10,  // mprotect
  11,  // munmap
  12,  // brk
  21,  // access
  35,  // nanosleep
  59,  // execve
  60,  // exit
  102, // getuid
  158, // arch_prctl
  218, // set_tid_address
  231, // exit_group
  257, // openat
  302, // prlimit64
  318, // getrandom
]);

/** A small denylist for tools that need a wide syscall surface. */
export const DENYLIST_DANGEROUS_SYSCALLS_X86_64: readonly number[] = Object.freeze([
  101, // ptrace
  246, // kexec_load
  165, // mount
  166, // umount2
  135, // personality
  250, // bpf           (don't let children install their own filters)
  316, // renameat2
  275, // splice
  41,  // socket        (we let raw network through via the audit log; the
  //  ...whole set is huge; this is just the headline-dangerous ones)
]);
