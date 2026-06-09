# ADR-0001: TypeScript over Python

**Status**: Accepted (proposed 2026-06-08)
**Deciders**: Project lead
**Phase**: Plan (lands in phase 1)

## Context

GMFT-AI is a TUI-first agentic runtime. Three of the four reference repos are
primarily Go (pentagi, xalgorix) or Python (hexstrike-ai); fluxion is Bash. We must
pick a language for the v0.1 implementation.

## Decision

**TypeScript on Node.js 20+**, pnpm workspaces, ESM.

## Rationale

1. **Ink v5 + React 18** is the cleanest path to a modern, composable, themable TUI.
   There is no credible Python equivalent (Textual is good; Ink's React model is
   *better* for this use case because chat is fundamentally a stateful stream
   of rendered components). We pin Ink v5 (not v6) because `ink-testing-library`
   v4 — the testing harness we depend on — is fully compatible with Ink v5 +
   React 18. Ink v6 + React 19 are still settling; revisit in v0.2.
2. **Vercel AI SDK** (`ai` package) gives us multi-provider LLM streaming + tool
   calling out of the box, and is TS-native. We can hand-roll a tight ~80-line
   ReAct loop around it without a LangChain-style framework.
3. **One language end-to-end**: TUI + agent + tools + tests. No cross-language
   bridge, no gRPC shim, no `child_process` to escape into a Python sidecar.
4. **Tooling**: `tsx` for fast dev, `vitest` for tests, `tsc` for builds, `eslint`
   + `prettier` for hygiene. Excellent.
5. **Distribution**: Node 20 is on every modern Linux. `pnpm pack` produces a
   tarball; a future `.deb` can carry the unpacked `node_modules`.

## Trade-offs accepted

- **Tool coverage is smaller than hexstrike-ai's.** Many CLI security tools have
  Python wrappers. We accept that we will call them as subprocesses (`spawn`)
  from Node. The trade is one extra process boundary per tool call in exchange
  for a unified runtime.
- **Docker is still needed** for sandboxing (same as hexstrike-ai's model). Node
  doesn't change that.
- **No native binary tools** in v0.1 (gdb, pwntools, binwalk). v0.2 can add a
  Python sidecar if needed; the chokepoint and tool registry are language-agnostic.

## Consequences

- All four `packages/*` and `apps/gmft` are TypeScript.
- The Python sidecar is **out of scope** for v0.1.
- Future ADRs (0002, 0003, 0004) depend on this choice.
