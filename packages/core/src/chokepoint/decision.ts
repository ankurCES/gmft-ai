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

export interface Chokepoint {
  decide(call: ChokepointCall): Decision;
}
