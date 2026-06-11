import { z } from 'zod';
import { run } from '../shared/runner';
import type { Tool, ToolContext } from '@gmft/core';

export const NmapInput = z.object({
  target: z.string().min(1),
  ports: z.string().optional(),
  scripts: z.string().optional(),
  timing: z.number().int().min(0).max(5).default(4),
});
export type NmapInputT = z.infer<typeof NmapInput>;

export const NmapPort = z.object({
  port: z.number().int(),
  protocol: z.string(),
  state: z.string(),
  service: z.string().optional(),
  product: z.string().optional(),
  version: z.string().optional(),
});
export type NmapPort = z.infer<typeof NmapPort>;

export const NmapHost = z.object({
  address: z.string(),
  hostname: z.string().optional(),
  ports: z.array(NmapPort),
});
export type NmapHost = z.infer<typeof NmapHost>;

export const NmapOutput = z.object({
  xml: z.string(),
  hosts: z.array(NmapHost),
  findings: z.array(z.any()),
  durationMs: z.number(),
  mode: z.enum(['host', 'docker']),
  fellBack: z.boolean(),
});
export type NmapOutputT = z.infer<typeof NmapOutput>;

const hostBlock = /<host\b[\s\S]*?<\/host>/g;
const statusMatch = /<status\s+state="([^"]+)"/;
const addressMatch = /<address\s+addr="([^"]+)"\s+addrtype="ipv4"/;
const hostnameMatch = /<hostname\s+name="([^"]+)"\s+type="user"/;
const portBlock = /<port\s+protocol="([^"]+)"\s+portid="(\d+)"[\s\S]*?<\/port>/g;
const stateMatch = /<state\s+state="([^"]+)"/;
const serviceMatch = /<service\s+name="([^"]+)"(?:[^>]*\bproduct="([^"]*)")?(?:[^>]*\bversion="([^"]*)")?/;

export function parseNmapXml(xml: string): NmapHost[] {
  const hosts: NmapHost[] = [];
  for (const hb of xml.match(hostBlock) ?? []) {
    const sm = statusMatch.exec(hb);
    if (sm?.[1] !== 'up') continue;
    const am = addressMatch.exec(hb);
    if (!am) continue;
    const hm = hostnameMatch.exec(hb);
    const ports: NmapPort[] = [];
    for (const pb of hb.match(portBlock) ?? []) {
      const stm = stateMatch.exec(pb);
      const svm = serviceMatch.exec(pb);
      ports.push({
        port: Number(RegExp.$2 ?? 0) || Number(pb.match(/portid="(\d+)"/)?.[1] ?? 0),
        protocol: pb.match(/protocol="([^"]+)"/)?.[1] ?? 'tcp',
        state: stm?.[1] ?? 'unknown',
        service: svm?.[1],
        product: svm?.[2],
        version: svm?.[3],
      });
    }
    hosts.push({
      address: am[1]!,
      hostname: hm?.[1],
      ports,
    });
  }
  return hosts;
}

import type { Finding } from '@gmft/core';

export function nmapFindings(hosts: NmapHost[], target: string): Finding[] {
  const out: Finding[] = [];
  const now = Date.now();
  for (const h of hosts) {
    for (const p of h.ports) {
      if (p.state !== 'open' && p.state !== 'filtered') continue;
      const ev = [p.service, p.product, p.version].filter(Boolean).join(' ').trim();
      out.push({
        id: `nmap-${target.replace(/[^a-zA-Z0-9.-]/g, '-')}-${p.port}-${p.protocol}-${now}`,
        tool: 'nmap',
        target,
        title: `Port ${p.port}/${p.protocol} ${p.state}${ev ? ` (${ev})` : ''}`,
        description: ev || `Port ${p.port}/${p.protocol} is ${p.state}`,
        evidence: ev,
        severity: p.state === 'open' ? 'medium' : 'low',
        ts: now,
      });
    }
  }
  return out;
}

export const nmapTool: Tool<typeof NmapInput, typeof NmapOutput> = {
  name: 'nmap',
  category: 'recon',
  flags: ['targetRequired'],
  // v0.1 phase 6 — opt in to scope-mode fan-out. The agent can
  // pass `args.target` as a path to a targets file and the executor
  // will clone the args per line and replace `target` with each
  // line. Without this flag, `executeWithScope('nmap', ...)` would
  // throw (the safety guard that prevents silent scope fan-out on
  // a tool that didn't ask for it).
  targetsFromFile: true,
  description: 'TCP port scan with nmap. -oX - emits XML to stdout for parsing.',
  input: NmapInput,
  output: NmapOutput,
  async run(input: NmapInputT, _ctx: ToolContext): Promise<NmapOutputT> {
    // Apply zod defaults (timing) before using.
    const parsed0 = NmapInput.parse(input);
    const argv = [
      'nmap',
      '-oX',
      '-',
      ...(parsed0.ports ? ['-p', parsed0.ports] : []),
      ...(parsed0.scripts ? ['--script', parsed0.scripts] : []),
      `-T${parsed0.timing}`,
      parsed0.target,
    ];
    const r = await run({
      argv,
      image: 'gmft/network:0.1',
      timeoutMs: 120_000,
    });
    const hosts = parseNmapXml(r.stdout);
    const findings = nmapFindings(hosts, parsed0.target);
    return {
      xml: r.stdout,
      hosts,
      findings,
      durationMs: r.durationMs,
      mode: r.mode,
      fellBack: r.fellBack,
    };
  },
};
