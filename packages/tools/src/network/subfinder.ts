import { z } from 'zod';
import { run } from '../shared/runner.js';
import type { Tool, ToolContext, Finding } from '@gmft/core';

/**
 * v0.3.B — Task 4. Passive subdomain enumeration tool by
 * projectdiscovery. Subfinder queries a large set of passive sources
 * (Certificate Transparency logs, DNS databases, search engines,
 * threat intel feeds) to find subdomains of a given domain without
 * touching the target's nameservers.
 *
 * We invoke `subfinder -d <domain> -silent -nW` and parse the
 * newline-delimited output. The `-nW` flag strips the color codes
 * and `=-=` separators that the default interactive output adds.
 */
export const SubfinderInput = z.object({
  domain: z.string().min(1),
  sources: z.array(z.string()).optional(),
  timeout: z.number().int().positive().max(60).default(30),
});
export type SubfinderInputT = z.infer<typeof SubfinderInput>;

export const SubfinderParsed = z.object({
  subdomains: z.array(z.string()),
  count: z.number(),
});
export type SubfinderParsedT = z.infer<typeof SubfinderParsed>;

export const SubfinderOutput = z.object({
  subdomains: z.array(z.string()),
  count: z.number(),
  findings: z.array(z.any()),
  durationMs: z.number(),
  mode: z.enum(['host', 'host+landlock', 'host+seccomp', 'host+landlock+seccomp', 'docker']),
  fellBack: z.boolean(),
});
export type SubfinderOutputT = z.infer<typeof SubfinderOutput>;

/**
 * Parse subfinder's silent newline-delimited output. Each non-empty
 * trimmed line is a discovered subdomain. The `-silent` flag already
 * strips progress / banner noise, so a strict split is safe.
 */
export function parseSubfinderOutput(stdout: string): SubfinderParsedT {
  const subdomains: string[] = [];
  if (!stdout || stdout.trim() === '') {
    return { subdomains, count: 0 };
  }
  for (const line of stdout.split('\n')) {
    const s = line.trim();
    if (s.length === 0) continue;
    // Defensive: skip the banner that leaks through if -silent is missing.
    if (s.startsWith('[') || s.toLowerCase().startsWith('starting')) continue;
    subdomains.push(s);
  }
  return { subdomains, count: subdomains.length };
}

/**
 * Findings: one Finding per unique subdomain. Severity is `info` —
 * discovering a subdomain isn't a vulnerability, but the list is the
 * primary recon output the operator wants to review.
 */
export function subfinderFindings(parsed: SubfinderParsedT, target: string): Finding[] {
  const out: Finding[] = [];
  const now = Date.now();
  const targetSlug = target.replace(/[^a-zA-Z0-9.-]/g, '-');
  parsed.subdomains.forEach((sub, idx) => {
    out.push({
      id: `subfinder-${targetSlug}-${idx}-${now}`,
      tool: 'subfinder',
      target,
      title: `Subdomain discovered: ${sub}`,
      description: `subfinder discovered the subdomain ${sub} while enumerating ${target}.`,
      evidence: sub,
      severity: 'info',
      ts: now,
    });
  });
  return out;
}

export const subfinderTool: Tool<typeof SubfinderInput, typeof SubfinderOutput> = {
  name: 'subfinder',
  category: 'recon',
  flags: ['targetRequired'],
  // v0.3.B — opt in to scope-mode fan-out.
  targetsFromFile: true,
  description:
    'Passive subdomain enumeration. Queries CT logs, DNS databases, and threat intel feeds without touching the target.',
  input: SubfinderInput,
  output: SubfinderOutput,
  async run(input: SubfinderInputT, _ctx: ToolContext): Promise<SubfinderOutputT> {
    const parsed = SubfinderInput.parse(input);
    const argv = [
      'subfinder',
      '-d', parsed.domain,
      '-timeout', String(parsed.timeout),
      '-silent',
      '-nW',
    ];
    if (parsed.sources && parsed.sources.length > 0) {
      argv.push('-sources', parsed.sources.join(','));
    }
    const r = await run({ argv, image: 'gmft/network:0.3', timeoutMs: 120_000 });
    const parsed2 = parseSubfinderOutput(r.stdout);
    const findings = subfinderFindings(parsed2, parsed.domain);
    return {
      subdomains: parsed2.subdomains,
      count: parsed2.count,
      findings,
      durationMs: r.durationMs,
      mode: r.mode,
      fellBack: r.fellBack,
    };
  },
};
