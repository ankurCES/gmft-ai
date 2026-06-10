# ADR-0007: Tools as a separate `@gmft/tools` package

**Status**: Accepted (2026-06-15)
**Phase**: 3 (lands in v0.1.0-phase3)

## Context

`@gmft/core` is the model-agnostic kernel: types, config, sessions,
secrets, the agent loop, the chokepoint. v0.1 lived entirely inside
`@gmft/core`. Phase 3 needs to ship a *catalog* of pentesting tools
(shell_exec, whois, dig, tshark_read, …) and the catalog has very
different concerns from the kernel:

- It needs `dockerode` for the Docker runner and a host fallback.
- It pulls heavy-ish dependencies (`scapy`-style packet crafting,
  `whois` client, `tshark` shell-out, `node-fetch` for HTTP).
- The catalog will grow over time; the kernel should not.
- Some deployments (CI, embedded boxes, restricted networks) may
  want to use the kernel without *any* of the tools.

Bundling the catalog into `@gmft/core` would mean every consumer
of the kernel pays the catalog's runtime cost and ships a longer
attestation surface. It would also make the kernel a dependency
of every tool, which is fine today but reverses in the wrong
direction.

## Decision

**Move the tool catalog into a new package, `@gmft/tools`.** It
sits alongside `@gmft/core` in the workspace and depends on it.
The kernel has zero tool knowledge; the catalog has zero loop or
policy knowledge. They meet at the `Tool<I, O>` interface from
`@gmft/core/tools`.

Layout:
```
packages/tools/
  src/
    index.ts          # public API: catalog(), defaultRunner
    catalog.ts        # the 5 default tools (whois, dig, ...)
    shared/
      prereq.ts       # docker / tshark / scapy detection
      runner.ts       # runInSandbox() — Docker-first + host fallback
    shell/
      shell-exec.ts   # the one tool that runs arbitrary argv
```

The runner is the only file that knows about Docker. Tools call
`runInSandbox({ tool, argv, cwd? })` and get a uniform
`SandboxResult`. `runInSandbox` is exported so a host program can
shell a custom tool through the same sandbox without registering
it in the catalog.

## Rationale

1. **Two failure modes instead of one.** If the kernel has a bug,
   you can disable the tools package and still drive the agent with
   a hand-rolled `runTurn` (useful for SDK consumers). If a tool
   has a bug, you can pin to an older `@gmft/tools` without
   rolling back the kernel.
2. **Smaller kernel → smaller blast radius.** A consumer who
   only wants the chokepoint + the loop can `import { Chokepoint,
   runTurn }` from `@gmft/core` and never touch `@gmft/tools`.
   Today this is the "library" use case; v0.2's SDK packaging
   assumes it.
3. **The Docker dep lives where it's used.** `dockerode` and its
   transitive `tar-fs` are heavy. They belong in `@gmft/tools`, not
   in the kernel that ships in every npm install of `@gmft/core`.
4. **Independent versioning.** v0.1.0 of `@gmft/core` is a stable
   API; `@gmft/tools` can move fast and ship 0.1.0, 0.1.1, 0.2.0
   without forcing a core bump.
5. **Test isolation is cleaner.** `@gmft/tools`'s vitest config
   sets `GMFT_SKIP_PREREQ=1` so the test suite runs in host mode
   without touching the host's Docker daemon. The runner's "is
   Docker available" code path is exercised by a single dedicated
   test that sets the env to a fake binary.

## Trade-offs accepted

- **Workspace dep on `dist`.** Because `@gmft/core` ships
  `composite: true` with `tsc -b`, `@gmft/tools`'s `tsc --noEmit`
  step requires `@gmft/core` to be built first. We wire this with
  a `predev` / `prebuild` script. The cost is a one-time
  cold-start delay of ~1s; the benefit is real ESM module
  resolution instead of `paths` hacks.
- **Two package versions to bump on a breaking change.** For v0.1
  we accept this; v0.2 may collapse to a single package if the
  split proves unnecessary.
- **The catalog is not pluggable yet.** v0.1 ships a hard-coded
  list of 5 tools. v0.2 adds a `loadToolsFrom(dir)` API so users
  can drop in their own tool modules.

## Consequences

- `pnpm-workspace.yaml` already lists `packages/*` so adding
  `@gmft/tools` is one `package.json` + `tsconfig.json` + the
  source tree.
- `@gmft/tools` re-exports `Tool`, `ToolRegistry`, `executeTools`
  from `@gmft/core` for convenience. The `chokepoint` and `runTurn`
  stay kernel-only.
- The TUI's "tools" rail in the StatusRail enumerates the catalog
  via `catalog()` — when `@gmft/tools` is missing, the rail shows
  "(no tools installed)".
