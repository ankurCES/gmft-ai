import { describe, it, expect } from 'vitest';
import {
  BpfProgram,
  auditArchFor,
  buildBpfAllowlist,
  buildBpfDenyList,
  ALLOWLIST_DIAGNOSTIC_SYSCALLS_X86_64,
  type BpfInsn,
} from '../../src/shared/bpf';
import { Buffer } from 'node:buffer';

// BPF opcodes mirrored from bpf.ts (kept in sync by hand — these are
// the only opcodes the emitter emits).
const BPF_LD_W_ABS = 0x20;
const BPF_JMP_JEQ_K = 0x15;
const BPF_RET_K = 0x06;

// SECCOMP_RET_* values mirrored from bpf.ts.
const SECCOMP_RET_KILL_PROCESS = 0x80000000;
const SECCOMP_RET_ALLOW = 0x7fff0000;

function codeOf(ins: BpfInsn): number {
  return ins.code;
}

describe('auditArchFor', () => {
  it('returns the correct value for x86_64', () => {
    expect(auditArchFor('x86_64')).toBe(0xc000003e);
  });
  it('returns the correct value for aarch64', () => {
    expect(auditArchFor('aarch64')).toBe(0xc00000b7);
  });
  it('throws on an unknown arch', () => {
    expect(() => auditArchFor('unicorn32')).toThrow(/unknown arch/);
  });
});

describe('BpfProgram.encode', () => {
  it('encodes each instruction as 8 bytes (LE: u16 code, u8 jt, u8 jf, u32 k)', () => {
    const prog = new BpfProgram([
      { code: 0x20, jt: 0, jf: 0, k: 0x12345678 },
      { code: 0x15, jt: 1, jf: 2, k: 42 },
    ]);
    const buf = prog.encode();
    expect(buf.length).toBe(16);
    // First insn: code=0x20, jt=0, jf=0, k=0x12345678
    expect(buf.readUInt16LE(0)).toBe(0x20);
    expect(buf.readUInt8(2)).toBe(0);
    expect(buf.readUInt8(3)).toBe(0);
    expect(buf.readUInt32LE(4)).toBe(0x12345678);
    // Second insn
    expect(buf.readUInt16LE(8)).toBe(0x15);
    expect(buf.readUInt8(10)).toBe(1);
    expect(buf.readUInt8(11)).toBe(2);
    expect(buf.readUInt32LE(12)).toBe(42);
  });
});

describe('buildBpfAllowlist', () => {
  it('produces the expected program shape (load arch, check arch, load nr, JEQ chain, KILL, ALLOW)', () => {
    const prog = buildBpfAllowlist({
      arch: 'x86_64',
      allowedSyscalls: [1, 2, 3],
    });
    // 1 (load arch) + 1 (arch check) + 1 (load nr) + 3 (chain) + 1 (KILL) + 1 (ALLOW) = 8
    expect(prog.length).toBe(8);

    expect(codeOf(prog.insns[0]!)).toBe(BPF_LD_W_ABS); // load arch
    expect(prog.insns[0]!.k).toBe(4);                 //   at offset 4

    expect(codeOf(prog.insns[1]!)).toBe(BPF_JMP_JEQ_K); // arch check
    expect(prog.insns[1]!.k).toBe(0xc000003e);         //   x86_64
    // jf must point at the KILL instruction (index 6, relative from 1 → +5)
    expect(prog.insns[1]!.jf).toBe(5);

    expect(codeOf(prog.insns[2]!)).toBe(BPF_LD_W_ABS); // load nr
    expect(prog.insns[2]!.k).toBe(0);                  //   at offset 0

    // JEQ chain (3 entries, each for nr=1, 2, 3)
    for (let i = 0; i < 3; i++) {
      expect(codeOf(prog.insns[3 + i]!)).toBe(BPF_JMP_JEQ_K);
      expect(prog.insns[3 + i]!.k).toBe(i + 1);
      // jt=+2 (skip KILL, land on ALLOW), jf=+1 (next JEQ)
      expect(prog.insns[3 + i]!.jt).toBe(2);
      expect(prog.insns[3 + i]!.jf).toBe(1);
    }

    // KILL (default action)
    expect(codeOf(prog.insns[6]!)).toBe(BPF_RET_K);
    expect(prog.insns[6]!.k).toBe(SECCOMP_RET_KILL_PROCESS);

    // ALLOW (matched)
    expect(codeOf(prog.insns[7]!)).toBe(BPF_RET_K);
    expect(prog.insns[7]!.k).toBe(SECCOMP_RET_ALLOW);
  });

  it('default action can be overridden (e.g. ERRNO+EPERM)', () => {
    const SECCOMP_RET_ERRNO = 0x00050000;
    const prog = buildBpfAllowlist({
      arch: 'x86_64',
      allowedSyscalls: [1],
      defaultAction: SECCOMP_RET_ERRNO | 1, // EPERM = 1
    });
    // The KILL slot is now the override
    expect(prog.insns[prog.length - 2]!.k).toBe(SECCOMP_RET_ERRNO | 1);
  });

  it('encodes to a Buffer whose length is 8 × insn count', () => {
    const prog = buildBpfAllowlist({
      arch: 'x86_64',
      allowedSyscalls: ALLOWLIST_DIAGNOSTIC_SYSCALLS_X86_64 as readonly number[],
    });
    const buf = prog.encode();
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.length).toBe(prog.length * 8);
    expect(buf.length % 8).toBe(0);
  });
});

describe('buildBpfDenyList', () => {
  it('produces the expected program shape (load arch, check arch, load nr, JEQ chain, ALLOW, KILL)', () => {
    const prog = buildBpfDenyList({
      arch: 'x86_64',
      deniedSyscalls: [101, 246, 165],
    });
    // 1 (load arch) + 1 (arch check) + 1 (load nr) + 3 (chain) + 1 (ALLOW) + 1 (KILL) = 8
    expect(prog.length).toBe(8);

    expect(codeOf(prog.insns[0]!)).toBe(BPF_LD_W_ABS);
    expect(prog.insns[0]!.k).toBe(4);

    // arch check: jf → KILL (last insn, index 7, relative from 1 → +6)
    expect(prog.insns[1]!.jf).toBe(6);

    // JEQ chain: jt → KILL (index 7, relative from each → 7-index)
    for (let i = 0; i < 3; i++) {
      const jeq = prog.insns[3 + i]!;
      expect(codeOf(jeq)).toBe(BPF_JMP_JEQ_K);
      expect(jeq.k).toBe([101, 246, 165][i]);
      expect(jeq.jt).toBe(7 - (3 + i));  // → KILL
      expect(jeq.jf).toBe(1);              // → next JEQ
    }

    // ALLOW (default, reached by chain fall-through)
    expect(prog.insns[6]!.k).toBe(SECCOMP_RET_ALLOW);
    // KILL (matched)
    expect(prog.insns[7]!.k).toBe(SECCOMP_RET_KILL_PROCESS);
  });

  it('emits an empty allowlist (everything allowed) for an empty denylist', () => {
    const prog = buildBpfDenyList({
      arch: 'x86_64',
      deniedSyscalls: [],
    });
    // 1 + 1 + 1 + 0 (empty chain) + 1 (ALLOW) + 1 (KILL) = 5
    expect(prog.length).toBe(5);
    expect(prog.insns[3]!.k).toBe(SECCOMP_RET_ALLOW);
    expect(prog.insns[4]!.k).toBe(SECCOMP_RET_KILL_PROCESS);
  });
});
