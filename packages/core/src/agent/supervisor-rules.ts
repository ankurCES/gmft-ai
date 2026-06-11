/**
 * v0.2.A — supervisor rule engine, Rule A only.
 *
 * Rule A detects stuck / loop behavior: the same (toolName, args) pair
 * appearing >= RULE_A_THRESHOLD times within the last RULE_A_WINDOW
 * tool-call-request events. A `loop-detected` fire is emitted on the
 * threshold-crossing call, with advice text keyed on the tool-family
 * prefix (nmap_*, whois/dig, etc.) so the suggestion is actionable.
 *
 * The function is a pure state reducer: given a `SupervisorState` and
 * an `AgentEvent`, it returns the next state and (optionally) a fire.
 * Side effects (event emission, session logging) are the caller's job —
 * see `applyFire` and the wrapper in Task 1.5.
 *
 * Future tasks in this file:
 *   - Rule B (overclaim detection) — Task 1.3
 *   - Rule C (turn-level chokepoint + counters) — Task 1.4
 *   - `applyFire` + `resetForNewTurn` — Task 1.5
 */

// =============================================================================
// Rule A — Stuck/loop detection
// =============================================================================
//
// Fires when the same (toolName, args) pair appears >= 4 times in the last 8
// tool-call-request events. Tracks a ring buffer of recent calls; advice text
// is keyed on the tool-family prefix (nmap_*, whois/dig, etc.).

import type { AgentEvent } from './loop.js';
import type { SupervisorState, LoopDetectedFire, OverclaimFire } from './supervisor-types.js';

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
const EMPTY_OUTPUT_REGEX = /^(\[\s*\]|null|''|"")?$/; // [], '', null, "", etc.

function isEmptyOutput(output: unknown): boolean {
  if (output == null) return true; // null, undefined
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
    // Suppressed if the most recent tool call produced a non-empty result
    // (the agent has evidence; the "no findings" conclusion is premature
    // only when the agent has *nothing* to point at).
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
