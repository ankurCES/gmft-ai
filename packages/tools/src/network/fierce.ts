import { z } from 'zod';
import { run } from '../shared/runner.js';
import type { Tool, ToolContext, Finding } from '@gmft/core';

/**
 * v0.3.B — Task 6. Perl-based DNS brute-forcer / zone-transfer
 * scanner by Microsoft / Robert David Graham. Walks a wordlist
 * against the target domain to discover hostnames, then attempts
 * zone transfers on each discovered nameserver.
 *
 * We invoke `fierce -dns <domain> [-wordlist <file>]` and parse the
 * `Found: <name> -> <ip>` lines that the tool emits for each
 * discovered host.
 */
export const FierceInput = z.object({
  domain: z.string().min(1),
  nameserver: z.string().optional(),
  wordlist: z.string().optional(),
  delay: z.number().int().nonnegative().max(10).default(0),
});
export type FierceInputT = z.infer<typeof FierceInput>;

export const FierceHost = z.object({
  name: z.string(),
  ip: z.string().optional(),
});
export type FierceHostT = z.infer<typeof FierceHost>;

export const FierceParsed = z.object({
  hosts: z.array(FierceHost),
  count: z.number(),
});
export type FierceParsedT = z.infer<typeof FierceParsed>;

export const FierceOutput = z.object({
  hosts: z.array(FierceHost),
  count: z.number(),
  findings: z.array(z.any()),
  durationMs: z.number(),
  mode: z.enum(['host', 'host+landlock', 'host+seccomp', 'host+landlock+seccomp', 'docker']),
  fellBack: z.boolean(),
});
export type FierceOutputT = z.infer<typeof FierceOutput>;

/**
 * Parse fierce's text output. The canonical discovery line is:
 *   Found: <hostname> -> <ip>
 * (some versions omit the IP and just print `Found: <hostname>`).
 * Banners, progress lines, and section headers (e.g. `Now performing
 * ...`, `Zone:`, `NS:`, `Wildcard`) are skipped.
 */
const FOUND_IP = /^Found:\s+(\S+)\s+->\s+(\S+)/;
const FOUND_BARE = /^Found:\s+(\S+)\s*$/;

export function parseFierceOutput(stdout: string): FierceParsedT {
  const hosts: FierceHost[] = [];
  if (!stdout || stdout.trim() === '') {
    return { hosts, count: 0 };
  }
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const m = FOUND_IP.exec(trimmed);
    if (m) {
      hosts.push({ name: m[1]!, ip: m[2]! });
      continue;
    }
    const bare = FOUND_BARE.exec(trimmed);
    if (bare) {
      hosts.push({ name: bare[1]! });
      continue;
    }
  }
  return { hosts, count: hosts.length };
}

/**
 * Findings: one Finding per discovered host. Severity is `low` —
 * hostile findings are unlikely from brute alone, but the host list
 * is the primary recon output the operator reviews.
 */
export function fierceFindings(parsed: FierceParsedT, target: string): Finding[] {
  const out: Finding[] = [];
  const now = Date.now();
  const targetSlug = target.replace(/[^a-zA-Z0-9.-]/g, '-');
  parsed.hosts.forEach((h, idx) => {
    out.push({
      id: `fierce-${targetSlug}-${idx}-${now}`,
      tool: 'fierce',
      target,
      title: h.ip ? `Discovered host: ${h.name} -> ${h.ip}` : `Discovered host: ${h.name}`,
      description: `fierce discovered host ${h.name}${h.ip ? ` resolving to ${h.ip}` : ''} on ${target}.`,
      evidence: h.ip ? `${h.name} -> ${h.ip}` : h.name,
      severity: 'low',
      ts: now,
    });
  });
  return out;
}

export const fierceTool: Tool<typeof FierceInput, typeof FierceOutput> = {
  name: 'fierce',
  category: 'recon',
  flags: ['targetRequired'],
  // v0.3.B — opt in to scope-mode fan-out.
  targetsFromFile: true,
  description:
    'DNS brute-forcer and zone-transfer scanner. Walks a wordlist to discover hostnames, then attempts zone transfers.',
  input: FierceInput,
  output: FierceOutput,
  async run(input: FierceInputT, _ctx: ToolContext): Promise<FierceOutputT> {
    const parsed = FierceInput.parse(input);
    const argv = ['fierce', '-dns', parsed.domain, '-delay', String(parsed.delay)];
    if (parsed.nameserver) {
      argv.push('-dnsserver', parsed.nameserver);
    }
    if (parsed.wordlist) {
      argv.push('-wordlist', parsed.wordlist);
    }
    const r = await run({ argv, image: 'gmft/network:0.3', timeoutMs: 300_000 });
    const parsed2 = parseFierceOutput(r.stdout);
    const findings = fierceFindings(parsed2, parsed.domain);
    return {
      hosts: parsed2.hosts,
      count: parsed2.count,
      findings,
      durationMs: r.durationMs,
      mode: r.mode,
      fellBack: r.fellBack,
    };
  },
};
