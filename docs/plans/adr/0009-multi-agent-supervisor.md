# ADR-0009 — Multi-agent supervisor (post-hoc consumer, rule-based)

**Status:** Accepted (v0.2.0-A.1)
**Date:** 2026-06-11
**Deciders:** Ankur

## Context

v0.1's chokepoint enforces hard policy (deny destructive calls outside
scope, require confirm for destructive, require typed confirm for
high-friction). It does not catch a *loop* (same call 4× in a row), an
*overclaim* (agent says "scan complete" with no findings), or a
*plan-quality* issue (agent goes destructive without recon). The v0.1
risk list §9 calls two of these out explicitly; v0.1 plan §7 defers a
"Mentor.interveneIfStuck()" hook to v0.2.

## Decision

Ship a strictly-silent supervisor as a **post-hoc consumer** wrapping
`runTurn`. The supervisor:
- for-await's the inner `AsyncIterable<AgentEvent>` unchanged
- runs 3 pure rules synchronously on every event
- injects advice into the agent's `history` array (mutated in place)
  as `role: 'user'` messages with a "Supervisor: " prefix
- emits 2 new `AgentEvent` variants (`supervisor-fire`,
  `supervisor-postmortem`)
- writes its state to a new optional `supervisor` field on each turn
  in the existing session log (`schemaVersion: 2`)

The supervisor **cannot** block tool calls, override the chokepoint,
or prompt the user. The chokepoint stays the only hard gate.

Triggers covered in v0.2.A: plan quality (1), stuck/loop (2),
confidence calibration (4), end-of-turn postmortem (6). Triggers
explicitly NOT in v0.2.A: overreach (3) and risk escalation (5) —
both are chokepoint's job.

## Alternatives considered

**A. Loop hook in `runTurn` (e.g. `supervisor.observe(event)` called
from inside the loop):** would require new public contracts on
`runTurn` for a benefit (real-time vs. post-hoc) that doesn't change
user-visible behavior. The async-iterable seam is already enough.

**B. LLM judge for trigger 1 (plan quality):** pure rule is
high-confidence for "no recon before destructive" and "3+ same
family". An LLM judge is a v0.3 stretch.

**C. LLM judge for ALL triggers:** would add 1 LLM call per
`tool-result` — 30+ LLM calls per session. v0.2 is the moment when
"v0.1 is great but expensive to use" starts to matter. Rules for
1/2/4, 1 LLM call for the postmortem (6).

**D. Block-on-violation (deny the tool call when the supervisor
disagrees):** would duplicate the chokepoint's job. Supervisor is
strictly silent — it advises and logs, never denies.

## Consequences

- `loop.ts` logic is byte-for-byte unchanged in v0.2.0-A.1. Only the
  type union grows (1 optional `flags` field on `tool-call-request`).
  The 2 new event variants (`supervisor-fire`, `supervisor-postmortem`)
  and the wrapper that yields them land in v0.2.0-A.2.
- The supervisor's state is observable from the TUI (StatusRail +
  inline ⚠ markers) and the audit log (the new `supervisor` field
  in `sessions.jsonl`).
- False positives are visible but non-blocking — the agent has
  already acted, the advice is benign ("try a different tool" or
  "the scan may be incomplete"), and the user can ignore the ⚠
  marker.
- v0.3 stretch: an `mode: 'llm'` opt-in for trigger 1, a
  `--supervisor-model` opt-out, cross-session memory, and a
  supervisor API for non-`runTurn` consumers (chains, batch tools).

## References

- v0.1 plan §0, §7, §9 (deferral + risk list)
- v0.2.A design spec: `docs/superpowers/specs/2026-06-11-gmft-v0.2-A-supervisor-design.md`
- v0.2.A implementation plan: `docs/superpowers/plans/2026-06-11-gmft-v0.2-A-supervisor.md`
- pentagi adviser/monitor pattern
