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
 *   5. `checkRequiresSandbox` — v0.2.D: deny destructive/elevated
 *      calls when the resolved runner is `host` and no override.
 *   6. `Allow`              — default.
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
 *   - in the per-invocation `allowlist` (only checked when non-empty;
 *     empty/undefined is a no-op for back-compat with pre-v0.3.B operators)
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
  // v0.3.B — per-invocation allowlist (loaded from --scope <path>).
  // Empty allowlist = no-op (back-compat). The check is exact-match:
  // --scope entries are hostnames/CIDRs but the in-memory allowlist
  // holds the literal string the operator typed, so this matches the
  // args.target verbatim. CIDR expansion is a future v0.4 item; in
  // v0.3.B the operator lists each host explicitly (or uses --target
  // for single-host sessions).
  if (env.allowlist.length > 0 && !env.allowlist.includes(target)) {
    return {
      kind: 'deny',
      reason:
        `target "${target}" is not in the session allowlist ` +
        `(loaded from --scope; ${env.allowlist.length} entr${env.allowlist.length === 1 ? 'y' : 'ies'} listed)`,
    };
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

/**
 * v0.4-B — Constraint B: AD tools must be called one target at a
 * time. `--scope` (v0.3.B) is fine for recon (nmap against 50
 * hosts is OK) but for AD attack tools, 50 hosts in parallel =
 * 50 simultaneous lateral-movement attempts = immediate
 * detection + containment.
 *
 * The check fires only when:
 *   - `call.category === 'ad'` (the catalog is the source of
 *     truth for the category; the chokepoint never has its own
 *     list of "AD tool names")
 *   - AND `call.args.scope` is set (per-call allowlist) OR the
 *     CLI passed `--scope` (carried in `call.cliScope`)
 *
 * The denial is a canonical-reason string so the TUI, CLI,
 * and audit log all show the same text. Runs BEFORE
 * `checkElevation` so the operator sees the category-level
 * constraint first (avoids burning a `checkElevation`
 * rejection on a call that would have been rejected here).
 *
 * See ADR-0018 §D.2 and `safety.md` §10.1 Constraint B.
 */
export function checkAdScope(call: ChokepointCall): Decision | null {
  if (call.category !== 'ad') return null;
  const hasArgScope = call.args.scope !== undefined && call.args.scope !== null;
  const hasCliScope = call.cliScope === true;
  if (!hasArgScope && !hasCliScope) return null;
  return {
    kind: 'deny',
    reason:
      'AD tools must be called one target at a time; --scope is not supported for this category.',
  };
}

/**
 * v0.4-B — Constraint C: the session host's own domain controller
 * is always blocked for AD tools (when realm lookup is enabled).
 *
 * The check fires only when:
 *   - `env.realmLookup === true` (operator opted in via
 *     `GMFT_REALM_LOOKUP=true`)
 *   - AND `call.category === 'ad'`
 *   - AND `call.args.target` is a non-empty string
 *
 * Resolution of "the PDC" is opt-in because `realm list`
 * requires a working Kerberos configuration on the host, which
 * most workstations do not have. When opted in, the chokepoint
 * shells out to `realm list --name-only` ONCE per session (the
 * result is cached on `env.pdcCache`) and compares it
 * case-insensitively to `args.target`.
 *
 * The cache returns one of three values (see `PdcCache`):
 *   - PDC FQDN (non-empty string) — match this against args.target
 *   - `''` — no realm / not joined. Deny ALL AD tool calls
 *     with a clear "verify realm" remediation hint.
 *   - `null` — cache disabled (realmLookup === false). Skip
 *     this rule (handled by the `env.realmLookup` check above).
 *
 * Runs AFTER `checkAdScope` (so we don't pay the realm lookup
 * cost on a call that would be rejected for `--scope`) and
 * BEFORE `checkElevation` (so the DC check fires before the
 * elevation prompt, since the realm check is more informative
 * when the operator's own DC is the issue).
 *
 * See ADR-0018 §D.3 and `safety.md` §10.1 Constraint C.
 */
export async function checkDomainController(
  call: ChokepointCall,
  env: ChokepointEnv,
): Promise<Decision | null> {
  if (!env.realmLookup) return null;
  if (call.category !== 'ad') return null;
  const target = call.args.target;
  if (typeof target !== 'string' || target.length === 0) {
    // No target to compare; the existing `checkTarget` rule will
    // reject `targetRequired` calls with a missing target. We do
    // not duplicate that error here.
    return null;
  }
  const pdc = await env.pdcCache.getPdc();
  if (pdc === null) {
    // Cache disabled. Should be unreachable because we already
    // checked `env.realmLookup === true`, but guards against a
    // misconfigured cache implementation.
    return null;
  }
  if (pdc === '') {
    return {
      kind: 'deny',
      reason:
        "realm lookup enabled but no realm found; run 'realm list' to verify the host is domain-joined and Kerberos is configured",
    };
  }
  if (target.toLowerCase() === pdc.toLowerCase()) {
    return {
      kind: 'deny',
      reason:
        "target matches the session's domain controller; this is blocked by default for AD tools",
    };
  }
  return null;
}
