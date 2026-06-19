/**
 * Supervisor type definitions for the v0.2.A multi-agent supervisor.
 *
 * This file is the foundation of the supervisor feature. It is intentionally
 * pure types + Zod schemas + one factory helper — no logic, no side effects,
 * no tests. Downstream files (rule engine, event-rewriter, postmortem
 * generator, session-log writer) all consume these shapes.
 *
 * Three families of types live here, in order:
 *
 *   1. `SupervisorFire`         — the in-memory runtime union the rule
 *      engine emits and the wrapper observes. Has whatever shape is
 *      convenient for the rule (e.g. `recent: string[]` of tool names,
 *      `count: number`).
 *
 *   2. `SupervisorState`        — the in-memory per-turn state held by
 *      the wrapper. Reset on each `done` event. Drives all three rules
 *      (A: loop detection, B: overclaim detection, C: turn-level
 *      chokepoint + counters).
 *
 *   3. `SupervisorFireRecord` / `SupervisorTurnRecord` — the
 *      JSON-serializable Zod-validated wire format written to the
 *      session log (Phase A.3). These are *narrower* than the runtime
 *      fires (e.g. `recent: z.array(z.string()).max(16)`) so the on-disk
 *      format is bounded even if the runtime type loosens up later.
 *
 * Two `AgentEvent` additions (`supervisor-fire`, `supervisor-postmortem`)
 * are defined here for now. Phase A.2 Task 2.4 adds them to the
 * `AgentEvent` union in `loop.ts` (lines 81-106 of the v0.1 union). They
 * live in this file first to keep all supervisor shapes colocated; the
 * loop re-exports them once Task 2.4 lands.
 */

import { z } from 'zod';

// -- SupervisorFire (in-memory, used at runtime) --

export type LoopDetectedFire = {
  kind: 'loop-detected';
  tool: string;
  count: number;
  recent: string[]; // up to 8 tool name strings
  advice: string;
  targetEventId: string;
};

export type OverclaimFire = {
  kind: 'overclaim';
  quote: string;
  evidence: string;
  advice: string;
  targetEventId: string;
};

export type PlanIssueFire = {
  kind: 'plan-issue';
  severity: 'info' | 'warn';
  text: string;
  advice: string;
  targetEventId: string;
};

// v0.4-A — risk-escalation fire. See ADR-0014.
// Fires when a destructive tool is the FIRST tool of the turn.
// This is a stricter gate than Rule C.1, which deliberately skips
// the first tool of the turn (see supervisor-rules.ts:339).
// `firstToolOfTurn` is a literal `true` flag — the schema uses a
// z.literal(true) so the field is self-documenting in the wire format.
export type RiskEscalationFire = {
  kind: 'risk-escalation';
  tool: string;
  firstToolOfTurn: true;
  advice: string;
  targetEventId: string;
};

export type SupervisorFire =
  | LoopDetectedFire
  | OverclaimFire
  | PlanIssueFire
  | RiskEscalationFire;

// -- SupervisorState (in-memory, held by the wrapper) --

export type SupervisorState = {
  // Per-turn counters (reset on each `done` event)
  firesThisTurn: SupervisorFire[];

  // Rule A: ring buffer of recent (toolName, argsHash) pairs
  ruleA: {
    recent: Array<{ name: string; argsHash: string; ts: number }>;
  };

  // Rule B: sliding window of recent text + tool-call counter
  ruleB: {
    recentText: string; // concatenated from last 20 text-delta chunks
    toolCallsSinceLastClaim: number;
    lastScannedPorts?: number[]; // populated from nmap_* tool results, used by B.3
    lastToolResult?: { ok: boolean; output: unknown }; // most recent tool-result, used by B.1 suppression + B.2
  };

  // Rule C: turn-level counters
  ruleC: {
    toolsCalledThisTurn: number;
    destructiveCallsThisTurn: number;
    reconCallsThisTurn: number;
    familyCallCounts: Map<string, number>;
    chokepointSessionTarget?: string;
  };

  // v0.4-A.2 — LLM judge for plan quality.
  // Optional so existing createInitialState() call sites compile
  // without change. When undefined, treated as false. resetForNewTurn
  // sets it to false explicitly so per-turn resets are obvious to
  // future maintainers. See ADR-0015.
  judgeRanThisTurn?: boolean;
};

export function createInitialState(chokepointSessionTarget?: string): SupervisorState {
  return {
    firesThisTurn: [],
    ruleA: { recent: [] },
    ruleB: { recentText: '', toolCallsSinceLastClaim: 0 },
    ruleC: {
      toolsCalledThisTurn: 0,
      destructiveCallsThisTurn: 0,
      reconCallsThisTurn: 0,
      familyCallCounts: new Map(),
      chokepointSessionTarget,
    },
  };
}

// -- SupervisorFireRecord (JSON-serializable, written to session log) --

export const SupervisorFireRecordSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('loop-detected'),
    tool: z.string(),
    count: z.number().int().positive(),
    recent: z.array(z.string()).max(16),
    advice: z.string(),
    targetEventId: z.string(),
  }),
  z.object({
    kind: z.literal('overclaim'),
    quote: z.string(),
    evidence: z.string(),
    advice: z.string(),
    targetEventId: z.string(),
  }),
  z.object({
    kind: z.literal('plan-issue'),
    severity: z.enum(['info', 'warn']),
    text: z.string(),
    advice: z.string(),
    targetEventId: z.string(),
  }),
  // v0.4-A — risk-escalation fire. See ADR-0014.
  z.object({
    kind: z.literal('risk-escalation'),
    tool: z.string(),
    firstToolOfTurn: z.literal(true),
    advice: z.string(),
    targetEventId: z.string(),
  }),
]);

export type SupervisorFireRecord = z.infer<typeof SupervisorFireRecordSchema>;

export const SupervisorTurnRecordSchema = z.object({
  fires: z.array(SupervisorFireRecordSchema),
  postmortem: z.string().optional(),
  postmortemError: z.string().optional(),
  modelUsed: z.string().optional(),
});

export type SupervisorTurnRecord = z.infer<typeof SupervisorTurnRecordSchema>;

// -- AgentEvent additions (additive to v0.1's union) --

export type SupervisorFireEvent = {
  type: 'supervisor-fire';
  fire: SupervisorFire;
  targetEventId: string;
};

export type SupervisorPostmortemEvent = {
  type: 'supervisor-postmortem';
  body: string;
  turnId: string;
  fireCount: number;
};
