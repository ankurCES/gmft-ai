# ADR-0008: Sandbox via Docker with explicit host fallback (implementation)

**Status**: Accepted (2026-06-15)
**Phase**: 3 (lands in v0.1.0-phase3)
**Supersedes scope**: Implementation details only. ADR-0003 is the
high-level policy; this ADR is the concrete `runInSandbox` contract
and the host-fallback design.

## Context

ADR-0003 chose "Docker-first with loud, explicit host fallback" as
the high-level policy. Phase 3 has to *implement* that policy.
The implementation needs an answer to: "what does a tool call
look like, what does a sandboxed result look like, and what
exactly happens when we fall back to host mode?"

The candidate surfaces were:

1. **A `dockerode` call at every tool site.** Each tool spawns its
   own container, awaits the result, tears it down. Pro: zero
   abstraction. Con: every tool reinvents stream multiplexing,
   error handling, env forwarding, and the "is Docker available"
   check.
2. **A single long-lived container per session** (the pentagi
   model). Pro: state persists between tool calls. Con: blast
   radius is the whole session; one RCE in `sqlmap` and the
   attacker has access to *all* the tools' scratch dirs.
3. **A `runInSandbox` helper** that spawns a fresh container per
   call, streams stdout/stderr, and returns a structured
   `SandboxResult`. Pro: small blast radius (one tool, one
   container, one process). Con: cold-start cost per call.

## Decision

**Adopt option 3: a `runInSandbox` helper in
`@gmft/tools/src/shared/runner.ts`.** Each call spawns a fresh
container (or host process, in fallback mode) for a single tool
invocation, streams output, and returns a `SandboxResult` with
`exitCode`, `stdout`, `stderr`, `durationMs`, and a `mode` field
that records whether the run was `docker` or `host`. The helper
is the only file that imports `dockerode`.

The host fallback has three triggers, in this order:

1. The user has set `GMFT_SANDBOX=host` in their env.
2. Docker is unavailable (no socket, no daemon, no `dockerode`
   connect) **and** the tool's metadata sets
   `allowHostFallback: true`.
3. Neither — the run fails with a typed `SandboxUnavailable`
   error and the chokepoint denies the action.

When host fallback is active, every `runInSandbox` result
includes `mode: 'host'`. The TUI's StatusRail subscribes to the
mode and shows a persistent ⚠ banner; the user must type
`/ack-host` to dismiss it for the session.

## Rationale

1. **One tool, one container, one process.** A sqlmap RCE gives
   the attacker `sqlmap`'s image, not the union of all five
   tools' privileges. This is the smallest blast radius we can
   ship in v0.1.
2. **The runner is unit-testable.** `runInSandbox` accepts a
   `RunnerBackend` interface; tests pass a `FakeBackend` that
   records calls and returns canned results. The
   `runner.test.ts` suite (9 tests) covers Docker success, host
   success, missing binary, non-zero exit, and timeout without
   touching a real Docker daemon. `GMFT_SKIP_PREREQ=1` is set in
   the vitest config so the prereq check doesn't shell out.
3. **The `mode` field is auditable.** Every audit event records
   whether the run used Docker or the host. A pentester who
   insists on the host-fallback path for `tshark` (because
   monitor-mode WiFi adapters can't be passed into a container
   cleanly) leaves a permanent record of the decision.
4. **The fallback is explicit, not silent.** Setting
   `GMFT_SANDBOX=host` is a deliberate, visible env var. The
   ⚠ banner is impossible to miss. The `/ack-host` command
   creates an audit event. None of these are bypassable by
   configuration alone — they require operator intent.

## Trade-offs accepted

- **Cold start per call.** Spawning a container is ~200ms on
  Linux. A `whois` lookup that would take 50ms on the host
  takes 250ms in the sandbox. We accept this for v0.1; v0.2
  can add a warm-pool for read-only tools if profiling shows
  the cost matters.
- **`dockerode` is a heavy dep.** It's listed in
  `@gmft/tools/package.json`, not in `@gmft/core/package.json`.
  A consumer who doesn't use `@gmft/tools` doesn't pay the cost.
- **Some tools cannot be containerised.** `wifi_evil_twin`
  (phase 6) needs raw WiFi + monitor mode + `aircrack-ng`'s
  driver hooks. That tool is host-only by design; its chokepoint
  is correspondingly tighter (`requiresElevation: true` + typed
  confirm). ADR-0003's footnote on this is restated here for
  traceability.
- **Output buffering is per-call.** A 1 GB tshark capture is
  buffered entirely in memory before returning. We cap
  `stdout` at 10 MB and `stderr` at 1 MB; overflow becomes a
  `SandboxOutputTruncated` error. v0.2 streams large outputs
  to a file in `~/.gmft/sessions/<id>/blobs/`.

## Consequences

- `runInSandbox({ tool, argv, cwd?, env?, timeoutMs? })` is the
  only API a tool needs to learn. It returns
  `Promise<SandboxResult>`.
- `SandboxResult.mode: 'docker' | 'host'` is part of the audit
  event. The TUI's StatusRail uses it to show / hide the
  fallback banner.
- `@gmft/tools`'s `vitest.config.ts` sets
  `GMFT_SKIP_PREREQ=1` so tests don't shell out to `docker` or
  `tshark` — the prereq check is exercised by a single
  dedicated test in `prereq.test.ts` that toggles the env
  per-case.
