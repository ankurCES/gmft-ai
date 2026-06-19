/**
 * v0.4-B — `psexec` tool. Wraps `impacket-psexec` to spawn a remote
 * shell on a Windows target via SMB. Requires valid AD credentials.
 *
 * Chokepoint contract (per ADR-0018 §10.1):
 *   - `category: 'ad'`       → `checkAdScope` rejects `--scope`,
 *                              `checkDomainController` blocks PDC
 *   - `flags: ['destructive', 'targetRequired']`
 *                              → `checkTarget` validates `args.target`,
 *                                `checkDestructive` confirms
 *   - `typeToConfirm: 'attack'`
 *                              → `checkTypeToConfirm` returns
 *                                `type-then-confirm`; user must type
 *                                literal `attack` before the run fires
 *   - no `targetsFromFile`    → `executeWithScope` rejects paths
 *
 * Image: `gmft/ad:0.1` (impacket installed via Dockerfile.ad).
 */

import { z } from 'zod';
import { run } from '../shared/runner.js';
import type { Tool, ToolContext } from '@gmft/core';
import {
  AdInputBase,
  AdOutputBase,
  AD_IMAGE,
  buildImpacketTarget,
  defaultAdFindings,
} from './shared.js';

export const PsexecInput = AdInputBase.merge(
  z.object({
    /** Command to run on the remote host. Defaults to `cmd.exe`. */
    command: z.string().min(1).default('cmd.exe'),
  }),
);
export type PsexecInputT = z.infer<typeof PsexecInput>;

export const PsexecOutput = AdOutputBase;
export type PsexecOutputT = z.infer<typeof PsexecOutput>;

export function buildPsexecArgs(input: PsexecInputT): string[] {
  const target = buildImpacketTarget(input);
  return ['impacket-psexec', target, input.command];
}

export const psexecTool: Tool<typeof PsexecInput, typeof PsexecOutput> = {
  name: 'psexec',
  category: 'ad',
  flags: ['destructive', 'targetRequired'],
  typeToConfirm: 'attack',
  description:
    'Remote shell on a Windows target via SMB using impacket-psexec. ' +
    'Requires domain/user + (password or NTLM hash).',
  input: PsexecInput,
  output: PsexecOutput,
  async run(input: PsexecInputT, _ctx: ToolContext): Promise<PsexecOutputT> {
    const parsed = PsexecInput.parse(input);
    const argv = buildPsexecArgs(parsed);
    const r = await run({ argv, image: AD_IMAGE, timeoutMs: 120_000 });
    return {
      stdout: r.stdout,
      stderr: r.stderr,
      exitCode: r.exitCode,
      durationMs: r.durationMs,
      mode: r.mode,
      fellBack: r.fellBack,
      findings: [...defaultAdFindings(r.stdout)],
    };
  },
};
