import { z } from 'zod';
import { run } from '../shared/runner.js';
import type { Tool, ToolContext, Finding } from '@gmft/core';

/**
 * v0.3.B — Task 5. DNS enumeration tool by darkoperator. Performs a
 * collection of DNS queries (zone transfer, brute force, SRV record
 * lookup, etc.) against the target domain.
 *
 * We invoke `dnsrecon -d <domain> -n <nameserver>` and parse the
 * line-oriented text output. Each record appears on its own line in
 * the canonical format:
 *   [<type>] <name> <value>
 * We extract the type, name, and value and bucket them in the result.
 */
export const DnsreconInput = z.object({
  domain: z.string().min(1),
  nameserver: z.string().optional(),
  type: z.enum(['std', 'axfr', 'brt', 'srv', 'bing', 'crt']).default('std'),
});
export type DnsreconInputT = z.infer<typeof DnsreconInput>;

export const DnsreconRecord = z.object({
  type: z.string(),
  name: z.string(),
  value: z.string(),
});
export type DnsreconRecordT = z.infer<typeof DnsreconRecord>;

export const DnsreconParsed = z.object({
  records: z.array(DnsreconRecord),
  count: z.number(),
});
export type DnsreconParsedT = z.infer<typeof DnsreconParsed>;

export const DnsreconOutput = z.object({
  records: z.array(DnsreconRecord),
  count: z.number(),
  findings: z.array(z.any()),
  durationMs: z.number(),
  mode: z.enum(['host', 'host+landlock', 'host+seccomp', 'host+landlock+seccomp', 'docker']),
  fellBack: z.boolean(),
});
export type DnsreconOutputT = z.infer<typeof DnsreconOutput>;

/**
 * Parse dnsrecon's line-oriented text output. Real-world output mixes
 * a banner header, section dividers (e.g. `[*] Performing General
 * Lookups`), and one record per line in the format:
 *   [<Type>] <name> <value...>
 *
 * We accept the bracketed-type form (most common) and the bare form
 * (`A example.com 1.2.3.4`). Lines that don't match either shape are
 * ignored — they are banners, progress markers, or footer text.
 */
const BRACKETED = /^\[([A-Za-z0-9-]+)\]\s+(\S+)\s+(.+)$/;
const BARE = /^([A-Z]{1,5})\s+(\S+)\s+(.+)$/;

export function parseDnsreconOutput(stdout: string): DnsreconParsedT {
  const records: DnsreconRecordT[] = [];
  if (!stdout || stdout.trim() === '') {
    return { records, count: 0 };
  }
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    // Skip banner / progress / footer noise.
    if (trimmed.startsWith('[*]') || trimmed.startsWith('[-]') || trimmed.startsWith('[+]')) continue;
    if (trimmed.startsWith('---')) continue;
    if (trimmed.toLowerCase().startsWith('performing')) continue;
    if (trimmed.toLowerCase().startsWith('dnsrecon')) continue;

    const bracketed = BRACKETED.exec(trimmed);
    if (bracketed) {
      records.push({ type: bracketed[1]!, name: bracketed[2]!, value: bracketed[3]!.trim() });
      continue;
    }
    const bare = BARE.exec(trimmed);
    if (bare) {
      records.push({ type: bare[1]!, name: bare[2]!, value: bare[3]!.trim() });
      continue;
    }
  }
  return { records, count: records.length };
}

/**
 * Findings: one Finding per DNS record. Severity:
 *   - `high` for SOA / NS records at apex (misconfigs are common here)
 *   - `medium` for A / AAAA / CNAME (general recon)
 *   - `info` for everything else
 */
export function dnsreconFindings(parsed: DnsreconParsedT, target: string): Finding[] {
  const out: Finding[] = [];
  const now = Date.now();
  const targetSlug = target.replace(/[^a-zA-Z0-9.-]/g, '-');
  parsed.records.forEach((r, idx) => {
    const sev = r.type === 'SOA' || r.type === 'NS' ? 'high' : (r.type === 'A' || r.type === 'AAAA' || r.type === 'CNAME') ? 'medium' : 'info';
    out.push({
      id: `dnsrecon-${targetSlug}-${r.type}-${idx}-${now}`,
      tool: 'dnsrecon',
      target,
      title: `${r.type} record: ${r.name} -> ${r.value}`,
      description: `dnsrecon discovered a ${r.type} record for ${r.name} (${r.value}) while querying ${target}.`,
      evidence: `${r.type} ${r.name} ${r.value}`,
      severity: sev,
      ts: now,
    });
  });
  return out;
}

export const dnsreconTool: Tool<typeof DnsreconInput, typeof DnsreconOutput> = {
  name: 'dnsrecon',
  category: 'recon',
  flags: ['targetRequired'],
  // v0.3.B — opt in to scope-mode fan-out.
  targetsFromFile: true,
  description:
    'DNS enumeration. Performs zone transfer, brute force, and standard lookups against the target domain.',
  input: DnsreconInput,
  output: DnsreconOutput,
  async run(input: DnsreconInputT, _ctx: ToolContext): Promise<DnsreconOutputT> {
    const parsed = DnsreconInput.parse(input);
    const argv = ['dnsrecon', '-d', parsed.domain, '-t', parsed.type];
    if (parsed.nameserver) {
      argv.push('-n', parsed.nameserver);
    }
    const r = await run({ argv, image: 'gmft/network:0.3', timeoutMs: 180_000 });
    const parsed2 = parseDnsreconOutput(r.stdout);
    const findings = dnsreconFindings(parsed2, parsed.domain);
    return {
      records: parsed2.records,
      count: parsed2.count,
      findings,
      durationMs: r.durationMs,
      mode: r.mode,
      fellBack: r.fellBack,
    };
  },
};
