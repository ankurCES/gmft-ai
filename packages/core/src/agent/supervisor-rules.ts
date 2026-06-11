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
import type { SupervisorState, LoopDetectedFire } from './supervisor-types.js';

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
