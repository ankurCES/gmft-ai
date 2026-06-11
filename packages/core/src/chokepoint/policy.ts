/**
 * Read the chokepoint's environment from config + process env. The
 * caller injects `env` (defaults to `process.env`) so tests can
 * pass a fake without monkey-patching globals.
 *
 * v0.1 elevation opt-in is env-var only; the config flag
 * `chokepoint.allowPrivateNetworks` is the parallel for the network
 * denylist. A future ADR may unify these into a single
 * `chokepoint.permits` field — deferred.
 *
 * v0.2.D adds two more fields:
 *   - `runnerCapabilities` — a snapshot of the host's landlock /
 *     seccomp / docker availability. The caller passes the live
 *     snapshot from `@gmft/tools`' `runnerCapabilities()` to keep
 *     `@gmft/core` free of any `@gmft/tools` import (which would
 *     create a workspace cycle). Default: a synthetic "all
 *     unavailable, resolvedAuto=host" snapshot so the chokepoint
 *     fails safe.
 *   - `allowUnsandboxedDestructive` — opt-in override that lets a
 *     user with Docker/landlock disabled run destructive tools on
 *     the host. The user is responsible for the consequences.
 */

import type { ChokepointEnv } from './decision.js';
import type { RunnerCapabilitiesShape } from './requires-sandbox.js';

/** Default snapshot: nothing is available, runner resolves to `host`. */
const DEFAULT_CAPS: RunnerCapabilitiesShape = {
  resolvedAuto: 'host',
};

export function readChokepointEnv(opts: {
  cfg: { chokepoint: { allowPrivateNetworks: boolean; denylist: readonly string[] } };
  env?: NodeJS.ProcessEnv;
  /** Session-level target. Omitted for short-lived CLI invocations. */
  sessionTarget?: string;
  /** v0.2.D: live capability snapshot from `@gmft/tools`. Defaults to "host". */
  runnerCapabilities?: RunnerCapabilitiesShape;
}): ChokepointEnv {
  const env = opts.env ?? process.env;
  return {
    allowPrivateNetworks: opts.cfg.chokepoint.allowPrivateNetworks,
    allowElevation: env.GMFT_ALLOW_ELEVATION === 'true',
    denylist: opts.cfg.chokepoint.denylist,
    sessionTarget: opts.sessionTarget,
    runnerCapabilities: opts.runnerCapabilities ?? DEFAULT_CAPS,
    allowUnsandboxedDestructive: env.GMFT_ALLOW_UNSANDBOXED_DESTRUCTIVE === 'true',
  };
}
