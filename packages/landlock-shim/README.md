# @gmft/landlock-shim

N-API binding to Linux's landlock LSM. **Forked from
[`mscdex/landlock@0.0.1`](https://github.com/mscdex/landlock) (MIT)** —
reimplemented against `node-addon-api` so the binding loads cleanly on
Node 18+ through Node 26+ (upstream uses Nan, which Node 22+ cannot
`dlopen`; this is a known Node behavior change).

The C ABI is **identical** to upstream (syscall numbers 444/445/446, the
same struct layouts, the same BigInt constants). The fork is a drop-in
shim from a TypeScript perspective: the JS surface (`getABI`, `getErrata`,
`createRuleset`, `addRule`, `restrictSelf`, `setNoNewPrivs`, `close`,
`constants`) is byte-for-byte the same as upstream.

## Why this fork exists

ADR-0011 (in v0.2.D) lists this fork as the documented exit clause if
the upstream `landlock` package goes unmaintained or breaks. We hit the
breakage sooner than expected: Node 22+ dropped support for `process.dlopen`
of Nan-based modules, and Node 26.0.0 segfaults when loading
`landlock@0.0.1`. The fork ships a real fix without waiting on the
upstream maintainer.

If `landlock` is later updated to use N-API, we can drop this shim and
switch back to the npm dep. The plan's exit clause is "if unmaintained
for 6+ months, fork" — we hit the fork path after ~6 days.

## Build

```sh
pnpm install
pnpm -F @gmft/landlock-shim build
```

The build requires:
- A C++17 compiler
- Python 3.x with `gyp` (Node's `node-gyp` build script)
- On Debian/Ubuntu: `apt install build-essential python3`
- On macOS: `xcode-select --install`

## API

```typescript
import { getABI, createRuleset, addRule, restrictSelf, setNoNewPrivs, close } from '@gmft/landlock-shim';
import { constants } from '@gmft/landlock-shim';

const abi = getABI(); // 1..7 on a landlock kernel; throws otherwise
const fd = createRuleset(constants.LANDLOCK_ACCESS_FS_READ_FILE | constants.LANDLOCK_ACCESS_FS_READ_DIR);
addRule(fd, constants.LANDLOCK_RULE_PATH_BENEATH, constants.LANDLOCK_ACCESS_FS_READ_FILE, '/usr');
addRule(fd, constants.LANDLOCK_RULE_PATH_BENEATH, constants.LANDLOCK_ACCESS_FS_READ_FILE, '/etc');
setNoNewPrivs();
restrictSelf(fd); // irreversible
close(fd);
```

See `index.d.ts` for the full type surface.

## Validation gotcha

On a kernel **without** landlock (e.g. this dev host, 7.0.0-22-generic,
where `/proc/sys/kernel/landlock_abi_version` is absent), `getABI()`
returns **`8`** — not a throw, not 1..7. The kernel has reused syscall
444 for something else and the call returns 8 with `errno=0`. Callers
**must** validate that the return value is in `[1, 7]` before claiming
landlock is available. The `packages/tools/src/shared/landlock.ts`
module does this check.

## Testing

```sh
pnpm -F @gmft/landlock-shim test
```

The smoke test loads the binding, validates the exported surface, checks
constant values, and probes the kernel. It passes on landlock and
non-landlock hosts (the latter by accepting the throw or the spurious-8).
