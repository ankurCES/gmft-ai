/**
 * The "host fallback for destructive/elevated tools requires Docker
 * or kernel landlock" rule. v0.2.D's contribution to the chokepoint.
 *
 * Order in the aggregator: LAST. The other 4 rules (elevation,
 * typeToConfirm, destructive, target) all fire first so the user
 * is *asked* (via the destructive confirm flow) before being told
 * the tool can't run.
 *
 * Fires when ALL of:
 *   - the call carries `destructive` or `requiresElevation`, AND
 *   - the resolved runner mode is `host` (no Docker, no
 *     landlock — i.e. `resolvedAuto === 'host'`), AND
 *   - the env does NOT have
 *     `GMFT_ALLOW_UNSANDBOXED_DESTRUCTIVE=true` set.
 *
 * The deny reason is a single line that fits in the StatusRail.
 */

import type { Decision, ChokepointCall, ChokepointEnv } from './decision.js';

/**
 * The chokepoint only reads one field off the capabilities snapshot
 * (`resolvedAuto`). To avoid a `@gmft/core` -> `@gmft/tools` import
 * (which would create a workspace cycle, since `@gmft/tools` depends
 * on `@gmft/core`), we describe that field structurally. The
 * `runnerCapabilities()` factory in `@gmft/tools` returns a
 * superset, so it is assignable to this type.
 *
 * Kept in sync with `RunnerCapabilities` in
 * `packages/tools/src/shared/capabilities.ts`. If the upstream type
 * ever changes the literal set, update both.
 */
export interface RunnerCapabilitiesShape {
  resolvedAuto: 'host' | 'host+landlock' | 'docker';
}

export function checkRequiresSandbox(
  call: ChokepointCall,
  env: ChokepointEnv & {
    runnerCapabilities: RunnerCapabilitiesShape;
    allowUnsandboxedDestructive: boolean;
  },
): Decision | null {
  const isRisky =
    call.flags.includes('destructive') || call.flags.includes('requiresElevation');
  if (!isRisky) return null;
  if (env.runnerCapabilities.resolvedAuto !== 'host') return null;
  if (env.allowUnsandboxedDestructive) return null;
  return {
    kind: 'deny',
    reason:
      'host fallback for destructive/elevated tools requires Docker or kernel landlock ' +
      '(set GMFT_ALLOW_UNSANDBOXED_DESTRUCTIVE=true to override; not recommended)',
  };
}
