/**
 * Public surface of the chokepoint module. `createChokepoint(env)`
 * returns the gate; `readChokepointEnv({ cfg, env? })` builds the
 * env from config + process env (or a test-supplied env object).
 *
 * The aggregator's rule order is documented on `./rules.ts` and
 * covered by `chokepoint.test.ts`. Changing it requires an ADR.
 *
 * v0.4-B — the chain is now async because `checkDomainController`
 * may need to shell out to `realm list` (cached per-session, so
 * the cost is paid at most once per session). All other rules
 * are sync and resolve to their synchronous result wrapped in
 * `Promise.resolve()`. Callers that previously did
 *   `chokepoint.decide(call)` synchronously must now `await`.
 */

import type { Chokepoint, ChokepointCall, Decision, ChokepointEnv } from './decision.js';
import {
  checkAdScope,
  checkDestructive,
  checkDomainController,
  checkElevation,
  checkTarget,
  checkTypeToConfirm,
} from './rules.js';
import { checkRequiresSandbox } from './requires-sandbox.js';

/**
 * Rule chain order (v0.4-B, post-ADR-0018 §D.4 reorder):
 *
 *   1. `checkAdScope`            — `category: 'ad'` + `--scope` ⇒ reject
 *   2. `checkDomainController`   — `GMFT_REALM_LOOKUP=true` + PDC match ⇒ reject
 *   3. `checkElevation`          — `GMFT_ALLOW_ELEVATION` ⇒ reject/allow
 *   4. `checkTypeToConfirm`      — `typeToConfirm` literal ⇒ type-then-confirm
 *   5. `checkDestructive`        — `destructive` ⇒ confirm
 *   6. `checkTarget`             — target format + RFC1918 + allowlist + session target
 *   7. `checkRequiresSandbox`    — v0.2.D host-without-sandbox block
 *   8. Allow (default)
 *
 * v0.4-B reorder rationale (from ADR-0018 §D.4):
 *   - `checkAdScope` runs first (no dependencies) so the operator
 *     sees the category-level constraint (`--scope` is not
 *     supported for AD tools) before any other check.
 *   - `checkDomainController` runs second because the realm lookup
 *     is more expensive than an env-var read; we want it to fire
 *     early but AFTER `checkAdScope` (so we don't pay the realm
 *     cost on a call that would have been rejected for `--scope`)
 *     and BEFORE `checkElevation` (so the DC check fires before
 *     the elevation prompt — the realm check is more informative
 *     when the operator's own DC is the issue).
 *   - The 4 baseline rules (`elevation` → `typeToConfirm` →
 *     `destructive` → `target`) match the canonical order documented
 *     on `./rules.ts` and tested in `chokepoint.test.ts`. The
 *     contract is: most-restrictive-first, with `target` last so a
 *     `destructive+targetRequired` call asks for confirmation
 *     before the target denylist kicks in (the operator may want to
 *     confirm a destructive call against a *known-bad* target to
 *     test detection; the target denial would skip the prompt).
 *   - `checkRequiresSandbox` runs after the destructive prompt so
 *     the user sees the confirm dialog before the v0.2.D host-
 *     without-sandbox block rejects the call.
 */
export function createChokepoint(env: ChokepointEnv): Chokepoint {
  return {
    async decide(call: ChokepointCall): Promise<Decision> {
      // Each rule returns Decision | null (sync) or Promise<Decision | null>
      // (async). Awaits compose naturally; the explicit `if (d) return d`
      // short-circuit avoids the `??` operator fighting with mixed sync/async.
      const adScope = checkAdScope(call);
      if (adScope) return adScope;
      const dc = await checkDomainController(call, env);
      if (dc) return dc;
      const elevation = checkElevation(call, env);
      if (elevation) return elevation;
      const typeToConfirm = checkTypeToConfirm(call);
      if (typeToConfirm) return typeToConfirm;
      const destructive = checkDestructive(call);
      if (destructive) return destructive;
      const target = checkTarget(call, env);
      if (target) return target;
      const sandbox = checkRequiresSandbox(call, env);
      if (sandbox) return sandbox;
      return { kind: 'allow' };
    },
  };
}

export type { Decision, Chokepoint, ChokepointCall, ChokepointEnv } from './decision.js';
export { readChokepointEnv } from './policy.js';
