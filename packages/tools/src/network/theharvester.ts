import { z } from 'zod';
import { run } from '../shared/runner';
import type { Tool, ToolContext, Finding } from '@gmft/core';

export const TheHarvesterInput = z.object({
  domain: z.string().min(1),
  sources: z.array(z.string()).default(['google']),
  limit: z.number().int().min(1).max(10000).default(100),
});
export type TheHarvesterInputT = z.infer<typeof TheHarvesterInput>;

export const TheHarvesterOutput = z.object({
  raw: z.string(),
  emails: z.array(z.string()),
  hosts: z.array(
    z.object({
      host: z.string(),
      address: z.string().optional(),
    }),
  ),
  urls: z.array(z.string()),
  findings: z.array(z.any()),
  durationMs: z.number(),
  mode: z.enum(['host', 'host+landlock', 'host+seccomp', 'host+landlock+seccomp', 'docker']),
  fellBack: z.boolean(),
});
export type TheHarvesterOutputT = z.infer<typeof TheHarvesterOutput>;

interface Parsed {
  emails: string[];
  hosts: { host: string; address?: string }[];
  urls: string[];
}

export function parseTheHarvester(raw: string): Parsed {
  const parsed: Parsed = { emails: [], hosts: [], urls: [] };
  let section: 'emails' | 'hosts' | 'urls' | null = null;
  for (const lineRaw of raw.split('\n')) {
    const line = lineRaw.trim();
    if (line === '' || line.startsWith('---')) {
      // Noise within a section — don't reset.
      continue;
    }
    if (line.startsWith('[*] Emails found:') || line.startsWith('[*] Emails found')) {
      section = 'emails';
      continue;
    }
    if (line.startsWith('[*] Hosts found:') || line.startsWith('[*] Hosts found')) {
      section = 'hosts';
      continue;
    }
    if (line.startsWith('[*] URLs found:') || line.startsWith('[*] URLs found')) {
      section = 'urls';
      continue;
    }
    if (line.startsWith('[*]')) {
      // Other [*] lines (Searching, Target domain, etc.) reset section.
      section = null;
      continue;
    }
    if (section === 'emails' && line.includes('@')) {
      parsed.emails.push(line);
    } else if (section === 'hosts') {
      const m = line.match(/^([^:\s]+):(\S+)/);
      if (m) parsed.hosts.push({ host: m[1]!, address: m[2]! });
      else parsed.hosts.push({ host: line });
    } else if (section === 'urls') {
      if (line.startsWith('http://') || line.startsWith('https://')) {
        parsed.urls.push(line);
      }
    }
  }
  return parsed;
}

export function theHarvesterFindings(parsed: Parsed, target: string): Finding[] {
  const out: Finding[] = [];
  const now = Date.now();
  const safeEmail = (e: string) => e.replace(/[^a-zA-Z0-9._@-]/g, '-');
  for (const e of parsed.emails) {
    out.push({
      id: `theharvester-email-${safeEmail(e)}-${now}`,
      tool: 'theHarvester',
      target,
      title: `Email ${e}`,
      description: `Email address discovered via OSINT: ${e}`,
      evidence: e,
      severity: 'low',
      ts: now,
    });
  }
  for (const h of parsed.hosts) {
    out.push({
      id: `theharvester-host-${h.host.replace(/[^a-zA-Z0-9.-]/g, '-')}-${now}`,
      tool: 'theHarvester',
      target,
      title: `Host ${h.host}${h.address ? ` -> ${h.address}` : ''}`,
      description: h.address ? `${h.host} (${h.address})` : h.host,
      evidence: h.address,
      severity: 'info',
      ts: now,
    });
  }
  for (const u of parsed.urls) {
    out.push({
      id: `theharvester-url-${u.replace(/[^a-zA-Z0-9._:/-]/g, '-')}-${now}`,
      tool: 'theHarvester',
      target,
      title: `URL ${u}`,
      description: `URL discovered via OSINT: ${u}`,
      evidence: u,
      severity: 'info',
      ts: now,
    });
  }
  return out;
}

export const theHarvesterTool: Tool<typeof TheHarvesterInput, typeof TheHarvesterOutput> = {
  name: 'theHarvester',
  category: 'recon',
  flags: ['targetRequired'],
  description: 'OSINT email/host/URL harvesting with theHarvester. Sources joined with commas; -f - emits results to stdout for parsing.',
  input: TheHarvesterInput,
  output: TheHarvesterOutput,
  async run(input: TheHarvesterInputT, _ctx: ToolContext): Promise<TheHarvesterOutputT> {
    // Apply zod defaults (sources, limit) before using.
    const parsed0 = TheHarvesterInput.parse(input);
    const r = await run({
      argv: [
        'theHarvester',
        '-d',
        parsed0.domain,
        '-b',
        parsed0.sources.join(','),
        '-l',
        String(parsed0.limit),
        '-f',
        '-',
      ],
      image: 'gmft/network:0.1',
      timeoutMs: 120_000,
    });
    const parsed = parseTheHarvester(r.stdout);
    const findings = theHarvesterFindings(parsed, parsed0.domain);
    return {
      raw: r.stdout,
      emails: parsed.emails,
      hosts: parsed.hosts,
      urls: parsed.urls,
      findings,
      durationMs: r.durationMs,
      mode: r.mode,
      fellBack: r.fellBack,
    };
  },
};
