/**
 * Read the chokepoint's environment from config + process env. The
 * caller injects `env` (defaults to `process.env`) so tests can
 * pass a fake without monkey-patching globals.
 *
 * v0.1 elevation opt-in is env-var only; the config flag
 * `chokepoint.allowPrivateNetworks` is the parallel for the network
 * denylist. A future ADR may unify these into a single
 * `chokepoint.permits` field — deferred.
 */

import type { ChokepointEnv } from './decision.js';

export function readChokepointEnv(opts: {
  cfg: { chokepoint: { allowPrivateNetworks: boolean; denylist: readonly string[] } };
  env?: NodeJS.ProcessEnv;
}): ChokepointEnv {
  const env = opts.env ?? process.env;
  return {
    allowPrivateNetworks: opts.cfg.chokepoint.allowPrivateNetworks,
    allowElevation: env.GMFT_ALLOW_ELEVATION === 'true',
    denylist: opts.cfg.chokepoint.denylist,
  };
}
