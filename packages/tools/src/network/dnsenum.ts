import { z } from 'zod';
import { run } from '../shared/runner';
import type { Tool, Finding } from '@gmft/core';

export const DnsenumInput = z.object({
  domain: z.string().min(1),
});
export type DnsenumInput = z.infer<typeof DnsenumInput>;

export const DnsenumRecord = z.object({
  host: z.string(),
  address: z.string().optional(),
});
export type DnsenumRecord = z.infer<typeof DnsenumRecord>;

export const DnsenumMx = z.object({
  host: z.string(),
  pref: z.number().int(),
});
export type DnsenumMx = z.infer<typeof DnsenumMx>;

export const DnsenumOutput = z.object({
  raw: z.string(),
  records: z.array(DnsenumRecord),
  nameservers: z.array(z.string()),
  mx: z.array(DnsenumMx),
  findings: z.array(z.any()),
  durationMs: z.number(),
  mode: z.enum(['host', 'docker']),
  fellBack: z.boolean(),
});
export type DnsenumOutput = z.infer<typeof DnsenumOutput>;

interface Parsed {
  records: DnsenumRecord[];
  nameservers: string[];
  mx: DnsenumMx[];
}

export function parseDnsenum(raw: string): Parsed {
  const parsed: Parsed = { records: [], nameservers: [], mx: [] };
  let section: 'hosts' | 'ns' | 'mx' | null = null;
  for (const lineRaw of raw.split('\n')) {
    const line = lineRaw.trim();
    if (line === '' || /^[-_=*]{3,}$/.test(line)) {
      // Noise (blank line or divider). Don't reset section — it stays in effect
      // until the next section header or end marker.
      continue;
    }
    if (/^Host's addresses:/i.test(line)) {
      section = 'hosts';
      continue;
    }
    if (/^Name Servers:/i.test(line)) {
      section = 'ns';
      continue;
    }
    if (/^MX \(Mail Exchange\)/i.test(line)) {
      section = 'mx';
      continue;
    }
    if (line.startsWith('Trying') || line.startsWith('Brute')) {
      section = null;
      continue;
    }
    if (section === 'hosts') {
      const m = line.match(/^(\S+)\s{2,}(\S+)/);
      if (m) parsed.records.push({ host: m[1].replace(/\.+$/, ''), address: m[2] });
    } else if (section === 'ns') {
      const m = line.match(/^(\S+)/);
      if (m) parsed.nameservers.push(m[1].replace(/\.+$/, ''));
    } else if (section === 'mx') {
      const m = line.match(/^(\S+)\s+pref=(\d+)/);
      if (m) parsed.mx.push({ host: m[1].replace(/\.+$/, ''), pref: parseInt(m[2]!, 10) });
    }
  }
  return parsed;
}

export function dnsenumFindings(parsed: Parsed, target: string): Finding[] {
  const out: Finding[] = [];
  const now = Date.now();
  const seen = new Set<string>();
  const add = (
    title: string,
    description: string,
    evidence: string | undefined,
    host: string,
    address?: string,
  ) => {
    const key = `${host}|${address ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      id: `dnsenum-${host.replace(/[^a-zA-Z0-9.-]/g, '-')}-${now}`,
      tool: 'dnsenum',
      target,
      title,
      description,
      evidence,
      severity: 'info',
      ts: now,
    });
  };
  for (const r of parsed.records) {
    add(
      `Host ${r.host}${r.address ? ` -> ${r.address}` : ''}`,
      r.address ?? r.host,
      r.address,
      r.host,
      r.address,
    );
  }
  for (const ns of parsed.nameservers) {
    add(`Nameserver ${ns}`, ns, ns, ns);
  }
  for (const m of parsed.mx) {
    add(`MX ${m.host} (pref ${m.pref})`, `Mail exchange: ${m.host} pref=${m.pref}`, m.host, m.host);
  }
  return out;
}

export const dnsenumTool: Tool<DnsenumInput, DnsenumOutput> = {
  name: 'dnsenum',
  category: 'recon',
  flags: ['targetRequired'],
  description: 'DNS enumeration with dnsenum --noreverse -o -. Outputs host addresses, nameservers, MX records.',
  inputSchema: DnsenumInput,
  outputSchema: DnsenumOutput,
  async run(input) {
    const r = await run({
      argv: ['dnsenum', '--noreverse', '-o', '-', input.domain],
      image: 'gmft/network:0.1',
      timeoutMs: 60_000,
    });
    const parsed = parseDnsenum(r.stdout);
    const findings = dnsenumFindings(parsed, input.domain);
    return {
      raw: r.stdout,
      records: parsed.records,
      nameservers: parsed.nameservers,
      mx: parsed.mx,
      findings,
      durationMs: r.durationMs,
      mode: r.mode,
      fellBack: r.fellBack,
    };
  },
};
