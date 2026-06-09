# ADR-0003: Docker-first sandbox with explicit host fallback

**Status**: Accepted (proposed 2026-06-08)
**Phase**: Plan (lands in phase 3)

## Context

GMFT-AI runs real attack tools. The pentagi reference repo solves the safety problem
by running *all* tool execution inside a long-lived Docker container per session,
managed by the Go backend. We must decide how GMFT-AI sandboxes tool execution.

## Decision

**Docker-first** with a **loud, explicit host-fallback**. A tool's metadata
declares its preferred image; the runner prefers Docker and falls back to host
only when the user has set `GMFT_SANDBOX=host` (or when Docker is unavailable
and the tool's `allowHostFallback: true` is set).

When host fallback is active, the StatusRail shows a persistent ⚠ banner that
the user must acknowledge with `/ack-host` to dismiss for the session.

## Rationale

1. **Mirrors pentagi's mental model** — operators expect tool execution to be
   isolated. Failing closed (deny) when Docker is missing is the right default.
2. **Permits dev on systems without Docker** — laptops, CI runners, and many
   containers don't have nested Docker. The fallback is a feature, not a bug,
   *as long as it's loud*.
3. **Per-tool images** (e.g. `gmft/nmap:0.1`, `gmft/nuclei:0.1`) keep the
   blast radius tight: a sqlmap RCE doesn't grant access to nmap's
   privileged-syscall helpers.
4. **Reproducibility** — pinned images = pinned tool versions. A scan from
   January 2027 is reproducible from January 2027's image.

## Trade-offs accepted

- **Docker is a hard dependency for the "safe" path.** That's a real cost. We
  mitigate with the host fallback + the loud banner.
- **Images must be built and published.** We commit `docker/Dockerfile.*` and
  publish to GHCR (lands in phase 6). The release tarball includes a `pull-images.sh`.
- **Some tools cannot be containerised easily** (fluxion needs raw WiFi + monitor
  mode + aircrack-ng with the right drivers). The `wifi_evil_twin` tool is
  host-only by design. Its chokepoint is correspondingly tighter
  (`requiresElevation: true` + typed confirm).

## Consequences

- `packages/tools/src/shared/runner.ts` is the only file that knows about Docker.
  Tools call `runInSandbox({ cmd, argv, ... })` and get a uniform result.
- A new build artifact per release: the tool images, published to GHCR.
- v0.2 may add **landlock** or **AppArmor** profiles on the host-fallback path
  (track in `docs/safety.md`).
