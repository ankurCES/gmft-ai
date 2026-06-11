/**
 * Pure rule functions for the chokepoint. Each returns either:
 *   - `null`         — the rule does not apply (or applies and is satisfied)
 *   - a `Decision`   — the rule denies or asks for confirmation
 *
 * The aggregator in `./index.ts` composes them in order:
 *   1. `checkElevation`     — most restrictive first; an unprivileged
 *      caller can't even *see* a destructive tool's confirmation prompt.
 *   2. `checkTypeToConfirm` — tools that require the user to type a
 *      literal get that stricter prompt (overrides plain `confirm`).
 *   3. `checkDestructive`   — `destructive` tools always Confirm.
 *   4. `checkTarget`        — target format + private-network denylist.
 *   5. `Allow`              — default.
 *
 * The order is tested in `chokepoint.test.ts`. Changing it is a breaking
 * change for any operator who has memorized the rule order from an audit
 * log, so document any reorder in an ADR.
 */

import type { Decision, ChokepointCall, ChokepointEnv } from './decision.js';

/** Tool target format: letters, digits, dot, underscore, dash. */
const TARGET_RE = /^[a-zA-Z0-9._-]+$/;

/** Hostnames that are always private regardless of resolution. */
const PRIVATE_HOSTS = new Set([
  'localhost',
  'ip6-localhost',
  'ip6-loopback',
  // RFC 6762 mDNS names are local by definition. Operators should
  // opt out via `chokepoint.allowPrivateNetworks: true` if they
  // intentionally target `.internal` TLDs.
]);

/** IPv4 CIDR ranges that are non-routable on the public internet. */
const PRIVATE_IPV4_PATTERNS: readonly RegExp[] = [
  /^10\./,                                // 10.0.0.0/8
  /^192\.168\./,                          // 192.168.0.0/16
  /^172\.(1[6-9]|2[0-9]|3[01])\./,        // 172.16.0.0/12
  /^127\./,                               // 127.0.0.0/8 (loopback)
  /^169\.254\./,                          // 169.254.0.0/16 (link-local)
  /^0\./,                                 // 0.0.0.0/8 (this network)
  /^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./, // 100.64.0.0/10 (CGNAT)
];

/** True iff the target is a hostname or IPv4 address in a private range. */
function isPrivateHost(target: string): boolean {
  if (PRIVATE_HOSTS.has(target.toLowerCase())) return true;
  for (const re of PRIVATE_IPV4_PATTERNS) {
    if (re.test(target)) return true;
  }
  return false;
}

/**
 * If the tool is `targetRequired`, the `target` arg must be:
 *   - present (non-empty string)
 *   - format `^[a-zA-Z0-9._-]+$`
 *   - not in a private network range (unless env.allowPrivateNetworks)
 *   - not in the operator-configured `denylist`
 *   - equal to the session-level `env.sessionTarget` (when set) —
 *     this binds the whole session to one host. `--target <host>`
 *     sets it; subsequent tool calls must match.
 *
 * Returns `null` when the rule does not apply or all checks pass.
 */
export function checkTarget(call: ChokepointCall, env: ChokepointEnv): Decision | null {
  if (!call.flags.includes('targetRequired')) return null;

  const target = call.args.target;
  if (typeof target !== 'string' || target.length === 0) {
    return { kind: 'deny', reason: 'target required (missing)' };
  }
  if (!TARGET_RE.test(target)) {
    return { kind: 'deny', reason: `target "${target}" contains illegal characters` };
  }
  if (!env.allowPrivateNetworks && isPrivateHost(target)) {
    return {
      kind: 'deny',
      reason: `target "${target}" is in a private network range (set chokepoint.allowPrivateNetworks=true to override)`,
    };
  }
  if (env.denylist.includes(target)) {
    return { kind: 'deny', reason: `target "${target}" is on the chokepoint denylist` };
  }
  if (env.sessionTarget && env.sessionTarget !== target) {
    return {
      kind: 'deny',
      reason:
        `target "${target}" does not match session target "${env.sessionTarget}" ` +
        `(start a new session with --target <host> to change scope)`,
    };
  }
  return null;
}

/**
 * Destructive tools always `Confirm`. There is no opt-out — the TUI
 * surfaces every confirmation prompt to the user, and audit logs
 * record the user's y/n response.
 */
export function checkDestructive(call: ChokepointCall): Decision | null {
  if (!call.flags.includes('destructive')) return null;
  return {
    kind: 'confirm',
    reason: `tool "${call.tool}" is destructive; confirm to proceed`,
  };
}

/**
 * Elevated tools require `GMFT_ALLOW_ELEVATION=true` in the env. The
 * check fires *before* `checkDestructive` so a destructive + elevated
 * tool never even prompts the user when the env is locked down.
 */
export function checkElevation(call: ChokepointCall, env: ChokepointEnv): Decision | null {
  if (!call.flags.includes('requiresElevation')) return null;
  if (!env.allowElevation) {
    return {
      kind: 'deny',
      reason: `tool "${call.tool}" requires GMFT_ALLOW_ELEVATION=true`,
    };
  }
  return null;
}

/**
 * If the call carries a `typeToConfirm` literal, the user must type it
 * to confirm. This is layered on top of `destructive` so it works
 * automatically for any tool that declares `typeToConfirm` — the
 * type-to-confirm prompt replaces (not supplements) the simple
 * confirm prompt.
 */
export function checkTypeToConfirm(call: ChokepointCall): Decision | null {
  if (!call.typeToConfirm) return null;
  return {
    kind: 'type-then-confirm',
    reason: `tool "${call.tool}" is high-friction; type "${call.typeToConfirm}" to confirm`,
    prompt: call.typeToConfirm,
  };
}
