/**
 * v0.4-B — shared helpers for the 5 AD attack tools
 * (`psexec`, `wmiexec`, `secretsdump`, `kerberoast`, `asreproast`).
 *
 * All 5 tools invoke impacket binaries with the same authentication
 * shape: `<domain>/<user>:<auth>@<target>` where `<auth>` is either
 * a password, a NTLM hash (`LM:NTLM`), or empty (for kerberoast /
 * asreproast which are pre-auth and don't need credentials).
 *
 * The shared helper avoids 5 near-identical argv builders and keeps
 * the `target` arg canonical — every tool's argv ends with
 * `<domain>/<user>:<auth>@<target>` so the chokepoint's `checkTarget`
 * rule has one consistent shape to match on (see ADR-0018 §10.1).
 */

import { z } from 'zod';

/**
 * Canonical input shape for all 5 AD tools. Each tool is allowed to
 * extend this (e.g. psexec adds `command`) via `.merge()` — but the
 * 5 fields below are required for the chokepoint's
 * `checkTarget` + `checkDomainController` rules to apply.
 */
export const AdInputBase = z.object({
  /** DC FQDN or IP. Required: triggers `checkTarget`. */
  target: z.string().min(1),
  /** AD domain (e.g. `CORP`). Optional — impacket infers from target
   *  if omitted. Lowercased on the wire. */
  domain: z.string().optional(),
  /** Username. Required for psexec/wmiexec/secretsdump. */
  username: z.string().optional(),
  /** Password. Mutually exclusive with `hashes`. */
  password: z.string().optional(),
  /** NTLM hash (`LM:NTLM` or `NTLM` for blank LM). Mutually exclusive
   *  with `password`. */
  hashes: z.string().optional(),
});
export type AdInputBaseT = z.infer<typeof AdInputBase>;

/**
 * Canonical output shape for all 5 AD tools. Mirrors the runner's
 * raw output plus a parsed findings array so the agent loop can
 * auto-append to the FindingsStore.
 */
export const AdOutputBase = z.object({
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number().int(),
  durationMs: z.number().int(),
  mode: z.enum([
    'host',
    'host+landlock',
    'host+seccomp',
    'host+landlock+seccomp',
    'docker',
  ]),
  fellBack: z.boolean(),
  findings: z.array(z.any()),
});
export type AdOutputBaseT = z.infer<typeof AdOutputBase>;

/**
 * Impacket binary names. All 5 tools route through `gmft/ad:0.1`
 * (the `Dockerfile.ad` image at the repo root).
 */
export const AD_IMAGE = 'gmft/ad:0.1';

/**
 * Standard impacket authentication shape:
 *   `<domain>/<user>:<auth>@<target>`
 *
 * Returns the assembled string or throws if the input is missing a
 * required field. The `target` is always the LAST component because
 * impacket's positional parser reads it last; this lets
 * `checkDomainController` compare `target` directly against the
 * resolved PDC FQDN.
 *
 * For kerberoast / asreproast (pre-auth attacks), `username` is
 * the account to enumerate — not the attacker. The assembled string
 * is therefore `<domain>/<user>@<target>` with no `:<auth>` part.
 */
export function buildImpacketTarget(input: AdInputBaseT): string {
  const { target, domain, username, password, hashes } = input;

  // Pre-auth (no password/hashes) — kerberoast / asreproast.
  if (!password && !hashes) {
    if (!username) {
      throw new Error(
        'username is required for pre-auth AD tools (kerberoast/asreproast)',
      );
    }
    return `${domain ? domain + '/' : ''}${username}@${target}`;
  }

  // Authenticated — psexec / wmiexec / secretsdump.
  if (!username) {
    throw new Error(
      'username is required for authenticated AD tools (psexec/wmiexec/secretsdump)',
    );
  }
  const auth = hashes ?? password ?? '';
  return `${domain ? domain + '/' : ''}${username}:${auth}@${target}`;
}

/**
 * Common `Finding` extractor for AD tools. Each tool can override
 * this to extract tool-specific findings (hashes, sessions, etc.);
 * the default just returns an empty array so the schema validates.
 */
export function defaultAdFindings(_stdout: string): readonly unknown[] {
  return [];
}
