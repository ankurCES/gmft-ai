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
 *
 * v0.4-B adds two more fields:
 *   - `realmLookup` — opt-in flag (`GMFT_REALM_LOOKUP=true`).
 *     When false, `checkDomainController` short-circuits.
 *   - `pdcCache` — per-session cache for the PDC lookup. The
 *     factory is injected so the production code path can use
 *     a real `realm` subprocess, while tests pass an in-memory
 *     fake. The default factory reads from
 *     `GMFT_PDC_OVERRIDE` (test/CI escape hatch); if that env
 *     var is unset, it shells out to `realm list --name-only`
 *     and uses the first non-empty line as the PDC FQDN.
 */

import type { ChokepointEnv, PdcCache } from './decision.js';
import type { RunnerCapabilitiesShape } from './requires-sandbox.js';

/** Default snapshot: nothing is available, runner resolves to `host`. */
const DEFAULT_CAPS: RunnerCapabilitiesShape = {
  resolvedAuto: 'host',
};

/**
 * Factory that produces a `PdcCache`. The default implementation
 * is a real-shell-out-to-`realm` cache; tests can pass a fake.
 * Exported so `apps/gmft` can construct a real cache and pass
 * it into `readChokepointEnv({ pdcCacheFactory })`.
 */
export type PdcCacheFactory = (opts: {
  realmLookup: boolean;
  env: NodeJS.ProcessEnv;
}) => PdcCache;

/** A no-op cache used when `realmLookup === false`. */
function disabledPdcCache(): PdcCache {
  return {
    async getPdc(): Promise<null> {
      return null;
    },
  };
}

/**
 * Real `PdcCache` that shells out to `realm list --name-only` on
 * first call, then caches the result. Concurrent callers coalesce
 * on a single in-flight `Promise` (no two `realm list` calls run
 * in parallel).
 *
 * `realmLookup` is included in the factory opts (even though
 * unused here) so a single factory signature works for both the
 * real impl and for tests that want to swap in a fake. When
 * `realmLookup === false`, the production caller short-circuits
 * to the `disabledPdcCache` above and never invokes this fn.
 */
function realPdcCache(opts: { realmLookup: boolean; env: NodeJS.ProcessEnv }): PdcCache {
  const { env } = opts;
  let cached: { value: Promise<string | null> } | null = null;
  return {
    async getPdc(): Promise<string | null> {
      if (cached) return cached.value;
      // GMFT_PDC_OVERRIDE is the test/CI escape hatch. Empty
      // string = "realm ran but no realm found" (deny all).
      // Non-empty = the PDC FQDN. Undefined = shell out.
      if ('GMFT_PDC_OVERRIDE' in env) {
        const override = env.GMFT_PDC_OVERRIDE ?? '';
        cached = { value: Promise.resolve(override) };
        return cached.value;
      }
      const promise = (async () => {
        try {
          const { spawn } = await import('node:child_process');
          const out = await new Promise<string>((resolve, reject) => {
            const proc = spawn('realm', ['list', '--name-only'], {
              stdio: ['ignore', 'pipe', 'pipe'],
            });
            const chunks: Buffer[] = [];
            proc.stdout.on('data', (c: Buffer) => chunks.push(c));
            proc.on('error', reject);
            proc.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
            // 5s timeout to avoid hanging the chokepoint on a
            // misconfigured Kerberos setup.
            setTimeout(() => {
              proc.kill('SIGKILL');
              reject(new Error('realm list timeout'));
            }, 5_000);
          });
          const pdc = out
            .split('\n')
            .map((l) => l.trim())
            .find((l) => l.length > 0);
          return pdc ?? '';
        } catch {
          // realm not installed, no Kerberos config, or process
          // errored. Treat as "no realm found" so the chokepoint
          // denies all AD calls with a clear reason.
          return '';
        }
      })();
      cached = { value: promise };
      return promise;
    },
  };
}

export function readChokepointEnv(opts: {
  cfg: { chokepoint: { allowPrivateNetworks: boolean; denylist: readonly string[] } };
  env?: NodeJS.ProcessEnv;
  /** Session-level target. Omitted for short-lived CLI invocations. */
  sessionTarget?: string;
  /** v0.2.D: live capability snapshot from `@gmft/tools`. Defaults to "host". */
  runnerCapabilities?: RunnerCapabilitiesShape;
  /**
   * v0.3.B — optional per-invocation allowlist. Loaded by the CLI
   * from `--scope <path>` and passed through. Empty/undefined =
   * the existing denylist-only behavior (back-compat).
   */
  allowlist?: readonly string[];
  /**
   * v0.4-B — override the default `realm list`-based PDC cache
   * factory. Tests pass an in-memory fake; production omits
   * this option and gets the real shell-out cache.
   */
  pdcCacheFactory?: PdcCacheFactory;
}): ChokepointEnv {
  const env = opts.env ?? process.env;
  const realmLookup = env.GMFT_REALM_LOOKUP === 'true';
  return {
    allowPrivateNetworks: opts.cfg.chokepoint.allowPrivateNetworks,
    allowElevation: env.GMFT_ALLOW_ELEVATION === 'true',
    denylist: opts.cfg.chokepoint.denylist,
    allowlist: opts.allowlist ?? [],
    sessionTarget: opts.sessionTarget,
    realmLookup,
    pdcCache: (opts.pdcCacheFactory ?? realPdcCache)({ realmLookup, env }),
    runnerCapabilities: opts.runnerCapabilities ?? DEFAULT_CAPS,
    allowUnsandboxedDestructive: env.GMFT_ALLOW_UNSANDBOXED_DESTRUCTIVE === 'true',
  };
}
