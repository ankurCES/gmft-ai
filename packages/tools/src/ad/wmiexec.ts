/**
 * v0.4-B — `wmiexec` tool. Wraps `impacket-wmiexec` to spawn a
 * semi-interactive shell on a Windows target via WMI. Requires
 * valid AD credentials.
 *
 * Chokepoint contract: same as `psexec` (see `./psexec.ts` for
 * the per-flag rationale). `wmiexec` is preferred over `psexec`
 * on networks where SMB is blocked but WMI (TCP/135 + dynamic
 * RPC ports) is allowed.
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

export const WmiexecInput = AdInputBase.merge(
  z.object({
    /** Command to run on the remote host. Defaults to `cmd.exe`. */
    command: z.string().min(1).default('cmd.exe'),
  }),
);
export type WmiexecInputT = z.infer<typeof WmiexecInput>;

export const WmiexecOutput = AdOutputBase;
export type WmiexecOutputT = z.infer<typeof WmiexecOutput>;

export function buildWmiexecArgs(input: WmiexecInputT): string[] {
  const target = buildImpacketTarget(input);
  return ['impacket-wmiexec', target, input.command];
}

export const wmiexecTool: Tool<typeof WmiexecInput, typeof WmiexecOutput> = {
  name: 'wmiexec',
  category: 'ad',
  flags: ['destructive', 'targetRequired'],
  typeToConfirm: 'attack',
  description:
    'Remote shell on a Windows target via WMI using impacket-wmiexec. ' +
    'Useful when SMB is blocked but WMI (135/dynamic) is allowed.',
  input: WmiexecInput,
  output: WmiexecOutput,
  async run(input: WmiexecInputT, _ctx: ToolContext): Promise<WmiexecOutputT> {
    const parsed = WmiexecInput.parse(input);
    const argv = buildWmiexecArgs(parsed);
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
