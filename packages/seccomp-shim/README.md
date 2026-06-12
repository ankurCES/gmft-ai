# @gmft/seccomp-shim

N-API binding to Linux's `seccomp(2)` syscall. Mirrors the
`@gmft/landlock-shim` surface: tiny, pure C++17, no `libseccomp.so`
runtime dep. The BPF program is built in pure JS (see
`packages/tools/src/shared/bpf.ts`) and passed in as a `Buffer`.

## Why this exists

Node 22+ has no built-in seccomp binding. The two real options were:

1. **`libseccomp` via FFI** — adds a `libseccomp.so.2` runtime dep, not
   present on macOS/Windows/Alpine, and the policy DSL in C is a
   second source of truth.
2. **Pure-JS BPF emitter + tiny syscall shim** (this package) — BPF
   is data, not code; the emitter is a typed array of
   `{code, jt, jf, k}` instructions; the shim is a 200-line N-API
   module that calls `prctl(PR_SET_NO_NEW_PRIVS)` and
   `seccomp(SECCOMP_SET_MODE_FILTER)`.

We chose (2). The shim has no opinions about what the filter does —
that's the emitter's job, and the emitter's job is unit-testable
without a kernel (the BPF program is a `Uint8Array` you can assert on
byte-for-byte).

## API

```js
const sc = require('@gmft/seccomp-shim');

sc.arch();                 // 'x86_64' | 'aarch64' | ...
sc.prctlSetNoNewPrivs();   // one-way trip; required before installBpf
sc.prctlGetSeccomp();      // 0=disabled, 1=strict, 2=filter

// Build the BPF in JS (see packages/tools/src/shared/bpf.ts), then:
const bpf = Buffer.from(bpfEmitter());   // 8 bytes per instruction
sc.installBpf(bpf, 0);                    // 0 flags = caller-only filter
```

## Build

```
pnpm -F @gmft/seccomp-shim build
```

The first build compiles `src/binding.cc` via `node-gyp` against
`node-addon-api@^8`. Subsequent builds are no-ops (cached `.node` file).

## Test

```
pnpm -F @gmft/seccomp-shim test
```

Smoke test in `test/install.test.js` exercises:

- all exports are present
- all constants are the right integer values
- `arch()` reports a sane string
- `prctlSetNoNewPrivs()` succeeds
- `prctlGetSeccomp()` returns 0 on a host with no filter installed
- `installBpf()` with a Buffer of wrong length throws TypeError

The smoke test does **not** install a real filter on a host that
doesn't support it (so it passes on a sandboxed CI runner too).

## See also

- `docs/superpowers/plans/2026-06-17-gmft-v0.2-D-host-sandbox.md`
  ADR-0011 — the rationale, threat model, and policy decisions.
- `packages/tools/src/shared/bpf.ts` — the JS BPF emitter.
- `packages/tools/src/shared/seccomp.ts` — the consumer-side wrapper.
