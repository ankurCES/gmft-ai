# ADR-0011 — Host-sandbox enforcement policy (landlock + seccomp + chokepoint deny)

**Status:** Accepted (v0.2.0-D.2)
**Date:** 2026-06-17
**Deciders:** Ankur
**Supersedes scope:** Implementation details only. ADR-0003 is the
high-level "Docker-first with explicit host fallback" policy;
ADR-0008 is the concrete `runInSandbox` contract. This ADR
documents the v0.2.D delta: **how the host-fallback path is
hardened** when Docker is unavailable.
**Related:**
- [ADR-0003](./0003-docker-first-sandbox.md) — high-level policy
- [ADR-0008](./0008-sandbox-via-docker-with-host-fallback.md) — `runInSandbox` contract

## Context

ADR-0003 set the high-level policy: Docker-first, with a loud,
explicit host fallback. ADR-0008 implemented the `runInSandbox`
contract. Both ADRs acknowledged that **host-fallback with no
isolation is dangerous** — a destructive tool run on the bare
host can touch `$HOME`, `~/.ssh`, `/etc/shadow`, the user's
`git` history, etc. The v0.1 implementation accepted this risk
because the alternative was "no tools on hosts without Docker."

By v0.2.A, two things had changed:

1. **Kernel landlock is now widely available** (5.13+, June 2021;
   Ubuntu 22.04 ships it, Fedora 35+ ships it, macOS hosts can
   use Docker Desktop's VM where landlock is available). It
   provides a kernel-enforced filesystem ACL with no daemon, no
   container, no namespace — just a `prctl(PR_SET_NO_NEW_PRIVS)`
   + a `landlock_create_ruleset()` + a `landlock_restrict_self()`
   call sequence that takes ~1ms.
2. **A pure-JS BPF emitter + a small N-API seccomp shim is
   cheap** (~200 lines of TS + ~200 lines of C++). It provides
   a default-deny syscall filter with the same "no daemon"
   property. Combined with landlock, the host-fallback path can
   run with **both a filesystem LSM and a syscall filter** with
   zero new user-space daemons.

The remaining gap: **the chokepoint should refuse destructive
or elevated tools when host-fallback is the only option and
neither Docker nor landlock is available.** v0.2.A silently
degraded to "host, no protection" in that case. The new
`requiresSandbox` rule closes that gap.

## Decisions

### 1. Landlock and seccomp are auto-applied on the host-fallback path

When the runner decides host mode (because Docker is unavailable
or `--sandbox=host` was passed), `preExec` (the same Node
`child_process.spawn` hook the runner already used) installs:

1. **Landlock** (filesystem ACL) — `applyLandlock(opts)` builds
   a ruleset that grants read+write to the workdir and read to
   `$HOME` + `/usr` + `/etc` (so the child can `execve` tools
   and read libs), then calls `landlock_restrict_self()` to
   make it the kernel-enforced policy for the new process.
   The shim is `@gmft/landlock-shim`, a small N-API binding
   (~200 lines of C++17, no runtime deps beyond libc).
2. **Seccomp BPF** (syscall filter) — `applySeccomp(opts)` calls
   `prctl(PR_SET_NO_NEW_PRIVS)` then `seccomp(SECCOMP_SET_MODE_FILTER, ...)`
   with a BPF program built by `buildBpfAllowlist({arch,
   allowedSyscalls})`. The shim is `@gmft/seccomp-shim`, also
   ~200 lines of C++17. The BPF program is built in pure JS
   (the `BpfProgram` typed array in `packages/tools/src/shared/bpf.ts`)
   and passed in as a `Buffer`. The default-allowlist policy
   for the host-fallback path is the 21-syscall
   `ALLOWLIST_DIAGNOSTIC_SYSCALLS_X86_64` (read, write, openat,
   close, stat, fstat, mmap, mprotect, munmap, brk, rt_sigaction,
   rt_sigprocmask, ioctl, exit_group, clock_gettime, getuid,
   getgid, geteuid, getegid, prlimit64, arch_prctl). The
   default-denylist policy (the alternative, opt-in per-tool)
   blocks ptrace, kexec_load, mount, bpf, perf_event_open,
   userfaultfd, and ~30 other "dangerous" syscalls.

Landlock is applied **first**, seccomp **second**. Rationale:
landlock touches the FS (`fsopen`, `fsmount`, `move_mount`,
`open_tree`, `landlock_create_ruleset`,
`landlock_add_rule`, `landlock_restrict_self`); seccomp
filters syscalls. If seccomp is applied first, the BPF
filter would block the landlock FS syscalls. Applied in the
other order, landlock succeeds and seccomp is layered on top.

`RunResult.mode` is the union of the two layers:
`'host+landlock' | 'host+seccomp' | 'host+landlock+seccomp' | 'host'`.
The audit log records the actual mode each tool call ran in
(`RunResult.runnerMode`).

### 2. Landlock and seccomp are opt-out, not opt-in

The runner applies both by default on the host-fallback path.
A tool can opt out of seccomp by NOT setting
`seccompPolicy: 'allowlist' | 'denylist'` in its `RunOptions`
(seccomp stays off). A tool cannot opt out of landlock — if
landlock is available, it runs (the tool gets a constrained
view of the FS; if that's not what the tool wants, the tool
should not be using host-fallback in the first place).

`runnerCapabilities` exposes a live probe of the host's
capabilities: `resolvedAuto: 'docker' | 'host+landlock' |
'host+seccomp' | 'host+landlock+seccomp' | 'host'`. The probe
runs once at startup and is cached.

### 3. The chokepoint denies destructive/elevated tools when only bare host is available

The new `checkRequiresSandbox` rule fires when:
- `runnerCapabilities().resolvedAuto === 'host'` (no Docker,
  no landlock, no seccomp — bare host), AND
- the call carries `destructive` or `requiresElevation`.

It returns `deny` with the canonical reason:
`"host fallback for destructive/elevated tools requires Docker
or kernel landlock (set GMFT_ALLOW_UNSANDBOXED_DESTRUCTIVE=true
to override; not recommended)"`.

The opt-out env flag `GMFT_ALLOW_UNSANDBOXED_DESTRUCTIVE` lets
the user restore the old "warn + proceed" behavior. The
default is `false` (the secure default). The flag is
documented but not recommended.

The rule is the **last** in the aggregator's order:
`elevation → typeToConfirm → destructive → target →
requiresSandbox → allow`. Rationale: a destructive tool that
needs sandboxing is still a destructive tool; the existing
`checkDestructive` flow should fire first so the user is
*asked* (this preserves the v0.1 confirm UX), and only when
they say "yes" does the runner then refuse because there's
no sandbox.

### 4. StatusRail surfaces the resolved mode + the deny glyph

Four states, color-coded:
- `docker` — green, no glyph.
- `host+landlock` / `host+seccomp` / `host+landlock+seccomp` —
  green (kernel-enforced), no glyph.
- `host` — yellow, `⚠` glyph.
- `unsandboxed` — red, `✗` glyph (chokepoint denied).

The rail starts at the auto-resolved mode and updates from
`RunResult.mode` on every tool-result. A denied call (ok=false,
non-empty reason) sets `sandbox = 'unsandboxed'`. The
`--sandbox=docker|host|auto` CLI flag lets the user override
the auto-resolution.

### 5. The kernel-host test seam makes tests portable

The `capabilities.test.ts` and `landlock.test.ts` tests in
`packages/tools/test/shared/` were originally host-dependent
(assumed the dev host's "no landlock" kernel, failed on CI
runner kernels which have landlock). Both now use the test
seam `_setLandlockAvailableForTest(status)` (added to
`packages/tools/src/shared/landlock.ts`) to deterministically
simulate a "landlock not available" host. The production call
path is exercised by `runner-host-sandbox.test.ts` (which
uses `setCapabilitiesForTest`) and the D.1.1 manual smoke (a
kernel with real landlock).

## Alternatives considered

**A. Always require Docker, fail closed on no-Docker hosts.**
Rejected — too restrictive. The user has a laptop with
Ubuntu 22.04 (landlock available) and no Docker installed.
Forcing them to install Docker for a diagnostic tool is a
bad UX. Landlock closes 90% of the gap for 1ms of work.

**B. Run everything in a chroot + namespace from Node.**
Rejected — reinventing Docker, badly. Landlock + seccomp
gives us 90% of the isolation for 1ms of work and zero
daemon management.

**C. Make seccomp opt-in (per-tool) instead of opt-out.**
Accepted for seccomp — seccomp is genuinely situational (a
21-syscall allowlist breaks `npm install`, a denylist breaks
package builds). But landlock stays opt-out because the
landlock ruleset is the *same* for every tool (workdir rw,
system ro).

**D. Apply landlock + seccomp *only* when the user explicitly
requests `--sandbox=host`.** Rejected — defeats the purpose.
The whole point of the v0.2.D slice is to make
host-fallback safe by default. If the user has to opt into
safety, they won't.

**E. Use the `landlock` crate (Rust) instead of an N-API shim.**
N/A — gmft-ai is TypeScript, not Rust. The N-API shim is the
TypeScript equivalent. The shim is ~200 lines of C++ and
exposes only 3 functions (`arch`, `prctlSetNoNewPrivs`,
`restrictSelf`); there's no surface for misuse.

**F. Use `libseccomp` (the standard seccomp C library)
instead of a hand-rolled BPF emitter.** Rejected — adds a
runtime dep on `libseccomp.so`, which isn't always present.
The BPF emitter is ~200 lines of pure data, encodes the
filter as a typed array of `{code, jt, jf, k}` instructions,
and the shim takes a `Buffer` and passes it to the kernel
directly. No `libseccomp.so` needed.

## Consequences

- v0.2.0-D ships with 497 tests (1 testkit + 211 core + 136
  tools + 149 gmft). The host-sandbox slice added 81 new
  tests across D.0 + D.1.1 + D.1.3 + D.2.
- The runner can now run any tool (including destructive) on
  a host with kernel landlock (Ubuntu 22.04+ default kernel,
  Fedora 35+ default kernel) without exposing the user's
  home directory, ssh keys, or browser cookies to the child
  process.
- The runner can also filter syscalls with seccomp (opt-in
  per-tool). The 21-syscall diagnostic allowlist is the
  default for read-only diagnostic tools; the denylist is
  for tools that need most of the syscall surface but should
  not be able to ptrace, kexec, mount, etc.
- The chokepoint refuses to run destructive/elevated tools
  on a bare host with no kernel layer. The user can override
  with `GMFT_ALLOW_UNSANDBOXED_DESTRUCTIVE=true` (documented
  but not recommended).
- The audit log records the actual `runnerMode` for each
  tool call, so an operator can post-hoc verify what
  isolation each call had.
- The StatusRail is now a real-time view of the current
  sandbox state, not just a static mode indicator. The red
  `✗ unsandboxed` glyph is a clear UX signal that a call was
  denied.

## References

- [ADR-0003 — Docker-first sandbox](./0003-docker-first-sandbox.md)
- [ADR-0008 — `runInSandbox` contract](./0008-sandbox-via-docker-with-host-fallback.md)
- [v0.2.D implementation plan](../../superpowers/plans/2026-06-17-gmft-v0.2-D-host-sandbox.md)
- [v0.2.D CHANGELOG entry](../../../CHANGELOG.md#020-d2--2026-06-17)
- [Landlock man page](https://www.man7.org/linux/man-pages/man7/landlock.7.html)
- [seccomp(2) man page](https://www.man7.org/linux/man-pages/man2/seccomp.2.html)
- [BPF instruction encoding](https://www.kernel.org/doc/Documentation/networking/filter.txt)
