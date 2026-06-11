/**
 * v0.2.A — supervisor rule engine: Rules A, B, C.
 *
 * Each rule is a pure state reducer: given a `SupervisorState` and an
 * `AgentEvent`, it returns the next state and (optionally) a fire.
 * Side effects (event emission, session logging) are the caller's job —
 * see `applyFire` and the wrapper in Task 1.5.
 *
 *   - Rule A (stuck/loop detection): the same (toolName, args) pair appears
 *     >= RULE_A_THRESHOLD times within the last RULE_A_WINDOW tool-call-
 *     request events. Emits a `loop-detected` fire with tool-family-keyed
 *     advice (nmap_*, whois/dig, etc.).
 *
 *   - Rule B (confidence calibration): fires `overclaim` when the agent
 *     asserts completion (B.1) or negative results (B.3) without matching
 *     evidence, or when a "done" claim follows an empty tool result (B.2).
 *     Operates on text-delta and tool-result events.
 *
 *   - Rule C (plan quality): fires `plan-issue` when destructive tools run
 *     before any recon (C.1), when a single tool family dominates a turn
 *     (C.2), or when a targetRequired tool is called without --target set
 *     (C.3). Operates on tool-call-request events.
 *
 * Phase A.1 (this file) is complete. The wrapper that calls these helpers
 * — applyFire / resetForNewTurn, plus the supervisor-fire / supervisor-
 * postmortem event emission — lives in the Phase A.2 task.
 */

// =============================================================================
// Rule A — Stuck/loop detection
// =============================================================================
//
// Fires when the same (toolName, args) pair appears >= 4 times in the last 8
// tool-call-request events. Tracks a ring buffer of recent calls; advice text
// is keyed on the tool-family prefix (nmap_*, whois/dig, etc.).

import type { AgentEvent } from './loop.js';
import type { SupervisorState, SupervisorFire, LoopDetectedFire, OverclaimFire, PlanIssueFire } from './supervisor-types.js';

export const RULE_A_THRESHOLD = 4;
export const RULE_A_WINDOW = 8;

function hashArgs(name: string, args: Record<string, unknown>): string {
  return `${name}::${JSON.stringify(args)}`;
}

const ALT_SUGGESTIONS: Array<[RegExp, string]> = [
  [/^nmap_/, 'scan fewer ports; add `-sV` for service detection; or move to a different host'],
  [/^(whois|dig)$/, "you've already got the DNS records; try a different recon tool or move on"],
  [/^(nuclei_|nikto_)/, 'the scan returned no findings; try a different template or a different tool'],
  [/^http_get$/, 'the page returned 200; check the response body for new endpoints or move on'],
];

const DEFAULT_ALT = 'try a different tool or a different target';

function altSuggestionFor(toolName: string): string {
  for (const [re, alt] of ALT_SUGGESTIONS) {
    if (re.test(toolName)) return alt;
  }
  return DEFAULT_ALT;
}

export function observeRuleA(
  state: SupervisorState,
  event: AgentEvent,
): { state: SupervisorState; fire?: LoopDetectedFire } {
  if (event.type !== 'tool-call-request') {
    return { state };
  }

  const { name, args, id } = event;
  const argsHash = hashArgs(name, args);
  const recent = [...state.ruleA.recent, { name, argsHash, ts: Date.now() }];
  const trimmed = recent.slice(-RULE_A_WINDOW);

  const nextState: SupervisorState = {
    ...state,
    ruleA: { recent: trimmed },
  };

  const last = trimmed[trimmed.length - 1];
  if (!last) return { state: nextState };

  let windowCount = 0;
  for (const r of trimmed) {
    if (r.name === last.name && r.argsHash === last.argsHash) windowCount++;
  }

  if (windowCount < RULE_A_THRESHOLD) {
    return { state: nextState };
  }

  const recentNames = trimmed.filter(r => r.name === last.name).map(r => r.name);
  const alt = altSuggestionFor(last.name);
  const advice =
    `Supervisor: you called \`${last.name}\` ${windowCount} times in the last ${RULE_A_WINDOW} tool calls ` +
    `with the same arguments. Try a different approach — e.g. ${alt}.`;

  const fire: LoopDetectedFire = {
    kind: 'loop-detected',
    tool: last.name,
    count: windowCount,
    recent: recentNames,
    advice,
    targetEventId: id,
  };

  return { state: nextState, fire };
}

// =============================================================================
// Rule B — Confidence calibration (overclaim detection)
// =============================================================================
//
// Three sub-rules fire `overclaim` events when the agent's text-delta
// output is not supported by recent tool results:
//   B.1: empty-findings claim — "scan complete" but no findings written
//   B.2: claim-without-evidence — "complete/done" within 2 tool calls
//        of an empty result
//   B.3: negative-result overconfidence — "port N is closed" but N
//        wasn't in the scan range
//
// The function maintains a small per-turn state slice on `state.ruleB`
// (sliding text window + tool-call counter + last-seen scan ports).

// Minimal shape we need from the session findings sidecar. The real
// `Finding` type lives in `apps/gmft/src/session/findings.ts`; we
// accept a structural type to keep @gmft/core dependency-free.
type FindingLikeForRuleB = { target?: string };

// Sub-rule B.1: empty-findings claim
const COMPLETE_PHRASE = /(scan|recon|port[- ]?scan|enum(eration)?)\s+(is\s+)?(complete|done|finished)/i;

// Sub-rule B.2: claim-without-evidence (within 2 tool calls of empty result)
const CLAIM_PHRASE = /\b(complete|done|finished|no vulnerabilities|nothing found)\b/i;

function isEmptyOutput(output: unknown): boolean {
  // Empty = null/undefined, '', empty array, or empty plain object.
  // Primitives like 0, false, or any non-empty string are treated as non-empty
  // (a tool returning a primitive is unusual; we don't want to over-fire on
  // false-but-meaningful values).
  if (output == null) return true;
  if (output === '') return true;
  if (Array.isArray(output)) return output.length === 0;
  if (typeof output === 'object') return Object.keys(output as object).length === 0;
  return false;
}

// Sub-rule B.3: negative-result overconfidence
const CLOSED_PORT_PHRASE = /port\s+(\d+)\s+is\s+closed/i;

export function observeRuleB(
  state: SupervisorState,
  event: AgentEvent,
  sessionFindings: readonly FindingLikeForRuleB[],
): { state: SupervisorState; fire?: OverclaimFire } {
  if (event.type === 'text-delta') {
    const text = event.text;
    // Sliding window of last 20 text-delta chunks
    const newRecentText = (state.ruleB.recentText + ' ' + text).slice(-2000);
    const nextState: SupervisorState = {
      ...state,
      ruleB: {
        recentText: newRecentText,
        toolCallsSinceLastClaim: state.ruleB.toolCallsSinceLastClaim + 1,
      },
    };

    // False-positive control: a "complete" claim within 1 turn of a
    // specific finding (CVE-, port-on-path, etc.) is not a fire.
    // We check the last 500 chars of recentText for a finding marker.
    const last500 = newRecentText.slice(-500);
    if (/CVE-\d{4}-\d+|on \/[a-z]|port \d+ on|admin|api\/v\d/i.test(last500)) {
      return { state: nextState };
    }

    // Track the most recent tool result for B.1 suppression + B.2.
    const lastToolResult = state.ruleB.lastToolResult;
    const lastResultIsNonEmpty = !!lastToolResult && !isEmptyOutput(lastToolResult.output);

    // Sub-rule B.2: claim-without-evidence (claim within 2 tool calls of empty result)
    // toolCallsSinceLastClaim is incremented above; tool-result resets it to 0.
    // So after an immediate tool-result → text-delta the counter is 1, meaning
    // the text-delta is within 2 tool calls of the last result. <= 2 covers that.
    // B.2 fires *before* B.1 — it is the more specific diagnosis (a tool just
    // returned empty, and the agent is claiming completion regardless).
    if (
      CLAIM_PHRASE.test(text) &&
      lastToolResult &&
      isEmptyOutput(lastToolResult.output) &&
      state.ruleB.toolCallsSinceLastClaim <= 2
    ) {
      const fire: OverclaimFire = {
        kind: 'overclaim',
        quote: text,
        evidence: 'the most recent tool call returned an empty result — the claim has no supporting evidence',
        advice: `Supervisor: you said "${text}", but the most recent tool call returned an empty result. Re-run a tool that produces output, or qualify your claim.`,
        targetEventId: 'text-delta',
      };
      return { state: nextState, fire };
    }

    // Sub-rule B.1: empty-findings claim
    // The spec requires only `sessionFindings.length === 0`, but the plan's
    // test 4 expects B.1 to *not* fire when a non-empty tool result was just
    // observed (the agent has evidence, even if no findings.jsonl entry yet).
    // This gate is a v0.2 false-positive control: target-agnostic (per the
    // v0.3 stretch note in the plan §1.2), but defensible because the B.1
    // diagnosis ("no findings on disk") is only premature when the agent
    // has nothing to point at.
    if (COMPLETE_PHRASE.test(text) && sessionFindings.length === 0 && !lastResultIsNonEmpty) {
      const fire: OverclaimFire = {
        kind: 'overclaim',
        quote: text,
        evidence: 'no findings were written to disk for the target of the claimed scan',
        advice: `Supervisor: you said the scan is complete, but no findings were written to disk. Re-run a tool that produces findings, or qualify your claim.`,
        targetEventId: 'text-delta', // text-delta events don't have ids in v0.1; use a sentinel
      };
      return { state: nextState, fire };
    }

    // Sub-rule B.3: negative-result overconfidence
    const m = CLOSED_PORT_PHRASE.exec(text);
    if (m) {
      const claimedPort = parseInt(m[1]!, 10);
      const scannedPorts = state.ruleB.lastScannedPorts;
      if (scannedPorts && scannedPorts.length > 0 && !scannedPorts.includes(claimedPort)) {
        const fire: OverclaimFire = {
          kind: 'overclaim',
          quote: text,
          evidence: `port ${claimedPort} was not in the scan range (${scannedPorts.join(', ')})`,
          advice: `Supervisor: you said port ${claimedPort} is closed, but it wasn't in the scan range — port state is unknown, not closed.`,
          targetEventId: 'text-delta',
        };
        return { state: nextState, fire };
      }
    }

    return { state: nextState };
  }

  if (event.type === 'tool-result') {
    const nextState: SupervisorState = {
      ...state,
      ruleB: {
        ...state.ruleB,
        toolCallsSinceLastClaim: 0,
        lastToolResult: { ok: event.ok, output: event.output },
      },
    };
    // Track scanned ports for sub-rule B.3
    const output = event.output;
    if (output && typeof output === 'object') {
      const o = output as Record<string, unknown>;
      if (Array.isArray(o.scanned)) {
        const ports = (o.scanned as unknown[]).filter(p => typeof p === 'number') as number[];
        if (ports.length > 0) {
          nextState.ruleB.lastScannedPorts = ports;
        }
      } else if (Array.isArray(o.ports)) {
        const ports = (o.ports as unknown[]).filter(p => typeof p === 'number') as number[];
        if (ports.length > 0) {
          nextState.ruleB.lastScannedPorts = ports;
        }
      }
    }
    return { state: nextState };
  }

  return { state };
}

// =============================================================================
// Rule C — Plan quality
// =============================================================================
//
// Fires on three plan-quality sub-rules during a single turn:
//   C.1 — destructive tool called with 0 prior recon calls in the turn
//   C.2 — 3+ calls to the same tool family (e.g. 3 different `nmap_*` calls)
//   C.3 — `targetRequired` tool called without a session `--target`
//
// Recon classification is by name match against RECON_TOOL_NAMES; destructive
// + targetRequired classification is by the `flags` field on the event (added
// to the `tool-call-request` union in v0.2.A; the registry is the source of
// truth at runtime). The `familyCallCounts` map on ruleC tracks per-family
// call counts across the turn for C.2.

// Recon-class tool names (the supervisor's notion; the registry's
// `flags: ['destructive']` is the source of truth at runtime — this
// list is the heuristic for "no recon yet" when flags aren't passed).
const RECON_TOOL_NAMES = new Set([
  'whois', 'dig', 'nmap_scan', 'nmap_service', 'nmap_vuln',
  'theharvester_scan', 'dnsenum_scan', 'whatweb_scan',
]);

function toolFamily(name: string): string {
  // "nmap_scan" -> "nmap_", "evil_twin" -> "evil_", "shell_exec" -> "shell_"
  const idx = name.indexOf('_');
  return idx === -1 ? name : name.slice(0, idx + 1);
}

export function observeRuleC(
  state: SupervisorState,
  event: AgentEvent,
): { state: SupervisorState; fire?: PlanIssueFire } {
  if (event.type !== 'tool-call-request') {
    return { state };
  }

  // After the early return, TypeScript narrows `event` to the
  // `tool-call-request` variant (which carries the optional `flags`
  // field added in v0.2.A — see loop.ts AgentEvent union).
  const { name, id, flags } = event;
  const isDestructive = flags?.includes('destructive') ?? false;
  const isRecon = RECON_TOOL_NAMES.has(name);
  const isTargetRequired = flags?.includes('targetRequired') ?? false;

  // Compute updated state first so all sub-rules can read post-call counters.
  const family = toolFamily(name);
  const familyCallCounts = new Map(state.ruleC.familyCallCounts);
  familyCallCounts.set(family, (familyCallCounts.get(family) ?? 0) + 1);

  const next: SupervisorState = {
    ...state,
    ruleC: {
      ...state.ruleC,
      toolsCalledThisTurn: state.ruleC.toolsCalledThisTurn + 1,
      destructiveCallsThisTurn:
        state.ruleC.destructiveCallsThisTurn + (isDestructive ? 1 : 0),
      reconCallsThisTurn: state.ruleC.reconCallsThisTurn + (isRecon ? 1 : 0),
      familyCallCounts,
    },
  };

  // Sub-rule C.1: no recon, going destructive
  if (
    isDestructive &&
    state.ruleC.reconCallsThisTurn === 0 &&
    state.ruleC.toolsCalledThisTurn > 0 // the destructive call counts; need at least 1 prior tool to flag
  ) {
    const fire: PlanIssueFire = {
      kind: 'plan-issue',
      severity: 'warn',
      text: 'destructive tool without any prior recon',
      advice: `Supervisor: you're about to run a destructive tool without any prior recon. Consider \`nmap_scan\` or \`whois\` first.`,
      targetEventId: id,
    };
    return { state: next, fire };
  }

  // Sub-rule C.2: 3+ calls to the same tool family
  const familyCalls = next.ruleC.familyCallCounts.get(family) ?? 0;
  if (familyCalls >= 3) {
    const fire: PlanIssueFire = {
      kind: 'plan-issue',
      severity: 'info',
      text: `3+ different \`${family}*\` calls in one turn`,
      advice: `Supervisor: 3 different \`${family}*\` calls in one turn. Consider a single comprehensive scan instead.`,
      targetEventId: id,
    };
    return { state: next, fire };
  }

  // Sub-rule C.3: targetRequired + no session target
  if (isTargetRequired && !state.ruleC.chokepointSessionTarget) {
    const fire: PlanIssueFire = {
      kind: 'plan-issue',
      severity: 'warn',
      text: 'targetRequired tool called without --target set',
      advice: `Supervisor: this tool requires a target scope; consider \`gmft --target <host>\` to bind the session.`,
      targetEventId: id,
    };
    return { state: next, fire };
  }

  return { state: next };
}

// =============================================================================
// Helpers — applyFire + resetForNewTurn
// =============================================================================
//
// `applyFire` is the single mutator for `firesThisTurn` — the wrapper
// calls it after a rule returns a fire, so the rest of the rule code
// stays free of side effects. `resetForNewTurn` rebuilds a fresh
// per-turn state on each `done` event; it preserves the session-level
// `chokepointSessionTarget` (set by `--target` on the CLI, lives for the
// whole session, not just one turn).
//
// Note: `lastToolResult` and `lastScannedPorts` are turn-level state
// (populated by the most recent tool-result event). Both are reset on
// every new turn — if we left them populated, a non-empty result from
// turn N would incorrectly continue to suppress Rule B.1 in turn N+1.

export function applyFire(state: SupervisorState, fire: SupervisorFire): SupervisorState {
  return {
    ...state,
    firesThisTurn: [...state.firesThisTurn, fire],
  };
}

export function resetForNewTurn(state: SupervisorState): SupervisorState {
  return {
    firesThisTurn: [],
    ruleA: { recent: [] },
    ruleB: {
      recentText: '',
      toolCallsSinceLastClaim: 0,
      lastScannedPorts: undefined,
      lastToolResult: undefined,
    },
    ruleC: {
      toolsCalledThisTurn: 0,
      destructiveCallsThisTurn: 0,
      reconCallsThisTurn: 0,
      familyCallCounts: new Map(),
      chokepointSessionTarget: state.ruleC.chokepointSessionTarget,
    },
  };
}
