import { z } from 'zod';
import { run } from '../shared/runner.js';
import type { Tool, ToolContext, Finding } from '@gmft/core';

export const EvilTwinInput = z.object({
  targetBssid: z
    .string()
    .regex(/^[0-9A-Fa-f:]{17}$/, 'BSSID must be aa:bb:cc:dd:ee:ff form'),
  targetEssid: z.string().min(1).max(32),
  interface: z.string().min(1),
  channel: z.number().int().min(1).max(165),
});
export type EvilTwinInputT = z.infer<typeof EvilTwinInput>;

export const EvilTwinOutput = z.object({
  findings: z.array(z.any()),
  mode: z.enum(['host', 'host+landlock', 'host+seccomp', 'host+landlock+seccomp', 'docker']),
  fellBack: z.boolean(),
  durationMs: z.number(),
  fluxionArgs: z.array(z.string()),
  dryRun: z.boolean(),
  tmuxSession: z.string().optional(),
});
export type EvilTwinOutputT = z.infer<typeof EvilTwinOutput>;

/**
 * evil_twin — wraps the fluxion workflow as ONE high-friction tool.
 *
 * Flags: destructive + requiresElevation + typeToConfirm='attack'
 *   - destructive → chokepoint always requires user confirmation
 *   - requiresElevation → chokepoint denies unless GMFT_ALLOW_ELEVATION=true
 *   - typeToConfirm="attack" → user must type the literal "attack" to confirm
 *
 * On confirm (real mode, not dry):
 *   - shells out to `sudo ./fluxion.sh -i` inside a new tmux session named
 *     "gmft-evil-twin-<essid-slug>" so the user can `tmux attach -t <name>` later
 *
 * On dry mode (GMFT_DRY=1): the fluxion args are computed and returned
 *   but fluxion is NOT invoked and no sudo is requested. This is what
 *   tests use to assert the wiring without requiring fluxion on PATH.
 */
export const evilTwinTool: Tool<typeof EvilTwinInput, typeof EvilTwinOutput> = {
  name: 'evil_twin',
  category: 'binary',
  description:
    'Launch a fluxion evil-twin attack against a target AP. DESTRUCTIVE + ELEVATED. ' +
    'Requires the user to type "attack" to confirm.',
  input: EvilTwinInput,
  output: EvilTwinOutput,
  flags: ['destructive', 'requiresElevation'],
  typeToConfirm: 'attack',
  async run(input: EvilTwinInputT, _ctx: ToolContext): Promise<EvilTwinOutputT> {
    const parsed0 = EvilTwinInput.parse(input);
    const tmuxSession = `gmft-evil-twin-${parsed0.targetEssid
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')}`;
    const fluxionArgs = [
      'sudo',
      './fluxion.sh',
      '-i',
      '--essid',
      parsed0.targetEssid,
      '--bssid',
      parsed0.targetBssid,
      '--channel',
      String(parsed0.channel),
      '--interface',
      parsed0.interface,
    ];

    if (process.env.GMFT_DRY === '1') {
      return {
        findings: [] as Finding[],
        mode: 'host' as const,
        fellBack: false,
        durationMs: 0,
        fluxionArgs,
        dryRun: true,
      };
    }

    // Real mode: assertBinary is the project's prereq helper — it throws
    // if fluxion is not on PATH. We import it dynamically to avoid a
    // hard dep when running in dry mode under test.
    const { assertBinary } = await import('../shared/prereq.js');
    assertBinary('fluxion', 'sudo');

    // Wrap the fluxion invocation in a detached tmux session so the user
    // can attach later. We use tmux new-session -d to detach.
    const tmuxArgs = [
      'tmux',
      'new-session',
      '-d',
      '-s',
      tmuxSession,
      fluxionArgs.join(' '),
    ];
    const r = await run({ argv: tmuxArgs, timeoutMs: 60_000 });

    return {
      findings: [] as Finding[],
      mode: r.mode,
      fellBack: r.fellBack,
      durationMs: r.durationMs,
      fluxionArgs,
      dryRun: false,
      tmuxSession,
    };
  },
};
