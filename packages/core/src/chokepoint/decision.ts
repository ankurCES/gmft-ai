/**
 * The chokepoint's decision type + the interface every gate implements.
 *
 * v0.1's chokepoint is intentionally narrow: three outcomes, all carry
 * a human-readable `reason` (so the TUI can show the user *why* a tool
 * call was denied or why it needs confirmation). The reason is the
 * audit trail; a denied tool with no reason is a bug.
 *
 * Three rules (lives in ./rules.ts) compose into these decisions:
 *   1. `targetRequired` — the tool's `args.target` must be present,
 *      well-formed, and not in a private network range.
 *   2. `destructive`    — always Confirm, never Allow.
 *   3. `requiresElevation` — denies unless the env opts in
 *      (`GMFT_ALLOW_ELEVATION=true`).
 *
 * v0.2.D adds a fourth rule (`checkRequiresSandbox`, lives in
 * ./requires-sandbox.ts) that denies destructive/elevated calls
 * when the resolved runner is `host` and no override env-var is set.
 *
 * `Chokepoint` is an interface, not a class, so tests can swap in a
 * fake that always returns `Allow` (happy path) or always `Deny`
 * (blocked path) without dragging in env-var machinery.
 */

import type { RunnerCapabilitiesShape } from './requires-sandbox.js';

export type Decision =
  | { kind: 'allow' }
  | { kind: 'confirm'; reason: string }
  | {
      /** High-friction: user must type the literal `prompt` to confirm. */
      kind: 'type-then-confirm';
      reason: string;
      prompt: string;
    }
  | { kind: 'deny'; reason: string };

export interface ChokepointCall {
  /** Tool name (e.g. `'shell_exec'`). */
  tool: string;
  /** Tool category (e.g. `'shell'`). For audit + future category-level rules. */
  category: string;
  /**
   * Tool flags declared on the `Tool<I,O>`. Recognized values:
   *   - `'destructive'`     — always Confirm
   *   - `'targetRequired'`  — args.target must pass format + denylist
   *   - `'requiresElevation'` — env-var opt-in
   * Unknown flags are ignored.
   */
  flags: readonly string[];
  /** Parsed (Zod-validated) tool input. */
  args: Record<string, unknown>;
  /**
   * Optional literal the user must type to confirm. Set by the executor
   * from the `Tool.typeToConfirm` field. When present, the chokepoint
   * returns `type-then-confirm` instead of `confirm`.
   */
  typeToConfirm?: string;
  /**
   * v0.4-B — true iff the CLI was invoked with `--scope`. The
   * chokepoint's `checkAdScope` rule denies AD tool calls when
   * this is set. CLI-level flag (not a per-tool `args` field)
   * because the operator typed it on the command line, not in
   * the tool-call input.
   */
  cliScope?: boolean;
}

export interface ChokepointEnv {
  /** Mirrors `cfg.chokepoint.allowPrivateNetworks`. */
  allowPrivateNetworks: boolean;
  /** True iff `process.env.GMFT_ALLOW_ELEVATION === 'true'`. */
  allowElevation: boolean;
  /** Mirrors `cfg.chokepoint.denylist`. */
  denylist: readonly string[];
  /**
   * v0.3.B — optional session allowlist. When non-empty, any
   * `targetRequired` call whose `args.target` is NOT in the list
   * is denied with a clear reason. The list is checked AFTER the
   * existing private-network and `denylist` checks, so a host can
   * be both allowlisted and denylisted (deny wins — see rules.ts).
   *
   * Empty/undefined = no allowlist enforced; the chokepoint
   * behaves exactly as it did pre-v0.3.B (back-compat preserved
   * for every existing operator).
   *
   * Loaded per-invocation from `--scope <path>` on the CLI; not
   * persisted to config.toml. The CLI flag is the only entry
   * point in v0.3.B; a future ADR may add a config field.
   */
  allowlist: readonly string[];
  /**
   * v0.4-B — per-session PDC (Primary Domain Controller) cache for
   * the realm-aware DC check (`checkDomainController`). The cache
   * is populated lazily on the first AD tool call when
   * `realmLookup === true`; subsequent calls hit the cache.
   *
   * `getPdc()` returns:
   *   - the PDC FQDN (e.g. `'dc01.corp.example.com'`) — match
   *   - `''` (empty string) — `realm list` ran but found no
   *     realm / no PDC. All AD tool calls are denied.
   *   - `null` — `realm list` not yet run (lazy) OR
   *     `realmLookup === false` (cache disabled).
   *
   * The cache is per-session because `realm list` shells out
   * to `realm` which reads `/etc/krb5.conf` and may talk to AD
   * LDAP. Calling it on every tool call is too expensive; once
   * per session is the right granularity.
   *
   * See ADR-0018 §D.3.
   */
  pdcCache: PdcCache;
  /**
   * v0.4-B — true iff `process.env.GMFT_REALM_LOOKUP === 'true'`.
   * When false, `checkDomainController` short-circuits and the
   * DC check is skipped entirely. Default is false to preserve
   * the "fail safe" property: tools work, but with no DC
   * protection. Opt in deliberately.
   */
  realmLookup: boolean;
  /**
   * The session-level target (from `--target <host>` on the CLI, or
   * set later by the operator). When present, any `targetRequired`
   * call whose `args.target` does not match is denied with a
   * "scope mismatch" reason — this is what stops a single chat from
   * drifting to an unauthorized host mid-run.
   *
   * Undefined = no session target set. The chokepoint does not
   * enforce scope in that case (the per-call `args.target` is
   * still format-checked and denylist-checked as before).
   */
  sessionTarget?: string;
  /** Snapshot of runner capabilities; see `@gmft/tools`. v0.2.D. */
  runnerCapabilities: RunnerCapabilitiesShape;
  /** True iff `process.env.GMFT_ALLOW_UNSANDBOXED_DESTRUCTIVE === 'true'`. v0.2.D. */
  allowUnsandboxedDestructive: boolean;
}

/**
 * v0.4-B — per-session PDC cache. Implemented as a thin interface
 * so the chokepoint rule can be tested with an in-memory fake
 * (no shelling out to `realm` in unit tests).
 */
export interface PdcCache {
  /**
   * Returns the cached PDC FQDN, populating it on first call.
   * Concurrent calls must coalesce: only one `realm list` may run
   * at a time. The simplest correct implementation uses a
   * per-cache `Promise` cached in a closure.
   *
   * Returns:
   *   - `string` (non-empty) — the PDC FQDN
   *   - `''` (empty string) — no PDC (realm empty / not joined)
   *   - `null` — cache disabled (realmLookup === false)
   */
  getPdc(): Promise<string | null>;
}

export interface Chokepoint {
  /**
   * v0.4-B — `decide()` is now `async` because
   * `checkDomainController` may need to shell out to `realm list`
   * (cached per-session, so the cost is paid at most once).
   * Pre-v0.4-B callers that did `chokepoint.decide(call)` must
   * now `await chokepoint.decide(call)`.
   */
  decide(call: ChokepointCall): Promise<Decision>;
}
