import { z } from 'zod';
import { run } from '../shared/runner.js';
import type { Tool, ToolContext, Finding } from '@gmft/core';

/**
 * v0.3.B — Task 3. Modern fast port scanner written in Rust. It
 * performs the SYN scan quickly, then pipes the open ports to nmap
 * for service detection. For our purposes we use the `-g` and `-p`
 * flags to specify the port range, and the JSON output (`--greppable`
 * or `-oJ`) to parse the results in a structured way.
 *
 * We invoke `rustscan -a <target> -r <range> -- -sV` to get service
 * detection by default. The greppable format yields one JSON line per
 * host.
 */
export const RustscanInput = z.object({
  target: z.string().min(1),
  ports: z.string().default('1-65535'),
  ulimit: z.number().int().positive().default(5000),
});
export type RustscanInputT = z.infer<typeof RustscanInput>;

export const RustscanPort = z.object({
  port: z.number().int(),
  ip: z.string().optional(),
  service: z.string().optional(),
});
export type RustscanPort = z.infer<typeof RustscanPort>;

export const RustscanParsed = z.object({
  openPorts: z.array(RustscanPort),
  count: z.number(),
});
export type RustscanParsedT = z.infer<typeof RustscanParsed>;

export const RustscanOutput = z.object({
  openPorts: z.array(RustscanPort),
  count: z.number(),
  findings: z.array(z.any()),
  durationMs: z.number(),
  mode: z.enum(['host', 'host+landlock', 'host+seccomp', 'host+landlock+seccomp', 'docker']),
  fellBack: z.boolean(),
});
export type RustscanOutputT = z.infer<typeof RustscanOutput>;

/**
 * Parse rustscan greppable JSON output. The format is one JSON object
 * per host on a single line. We accept any record with an `ports` array
 * (each entry is a string like "80" or an object like `{"portid":"80"}`).
 * The actual upstream format varies between releases so we keep the
 * parser loose.
 */
export function parseRustscanOutput(stdout: string): RustscanParsedT {
  const openPorts: RustscanPort[] = [];
  if (!stdout || stdout.trim() === '') {
    return { openPorts, count: 0 };
  }
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let obj: any;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const ports = obj?.ports;
    if (!Array.isArray(ports)) continue;
    // In rustscan greppable format, the host IP sits at the record
    // level (not on each port). Fall back to it when a port entry
    // doesn't carry its own `ip`.
    const hostIp = typeof obj?.ip === 'string' ? obj.ip : undefined;
    for (const p of ports) {
      if (typeof p === 'string' || typeof p === 'number') {
        const n = Number(p);
        if (Number.isInteger(n) && n > 0 && n < 65536) {
          openPorts.push({ port: n, ip: hostIp });
        }
      } else if (p && typeof p === 'object') {
        const n = Number(p.portid ?? p.port ?? p.id);
        if (Number.isInteger(n) && n > 0 && n < 65536) {
          const portIp = typeof p.ip === 'string' ? p.ip : hostIp;
          openPorts.push({
            port: n,
            ip: portIp,
            service:
              typeof p.service === 'string'
                ? p.service
                : typeof p.name === 'string'
                  ? p.name
                  : undefined,
          });
        }
      }
    }
  }
  return { openPorts, count: openPorts.length };
}

/**
 * Findings: one Finding per open port. Severity is `medium` to match
 * masscan — an open port is a precondition, not a vulnerability.
 */
export function rustscanFindings(parsed: RustscanParsedT, target: string): Finding[] {
  const out: Finding[] = [];
  const now = Date.now();
  const targetSlug = target.replace(/[^a-zA-Z0-9.-]/g, '-');
  parsed.openPorts.forEach((p, idx) => {
    const where = p.ip ? `${p.ip}:${p.port}` : `${p.port}`;
    const title = p.service
      ? `Open port ${p.port} (${p.service})${p.ip ? ` on ${p.ip}` : ''}`
      : `Open port ${p.port}${p.ip ? ` on ${p.ip}` : ''}`;
    out.push({
      id: `rustscan-${targetSlug}-${p.port}-${idx}-${now}`,
      tool: 'rustscan',
      target,
      title,
      description: `rustscan discovered an open port (${p.port}) on ${target}${p.service ? ` running ${p.service}` : ''}.`,
      evidence: where,
      severity: 'medium',
      ts: now,
    });
  });
  return out;
}

export const rustscanTool: Tool<typeof RustscanInput, typeof RustscanOutput> = {
  name: 'rustscan',
  category: 'recon',
  flags: ['targetRequired'],
  // v0.3.B — opt in to scope-mode fan-out.
  targetsFromFile: true,
  description:
    'Fast Rust-based port scanner. Pipes results into nmap for service detection. Use only with authorization.',
  input: RustscanInput,
  output: RustscanOutput,
  async run(input: RustscanInputT, _ctx: ToolContext): Promise<RustscanOutputT> {
    const parsed = RustscanInput.parse(input);
    const argv = [
      'rustscan',
      '-a', parsed.target,
      '-r', parsed.ports,
      '--ulimit', String(parsed.ulimit),
      '-g',  // greppable JSON output
    ];
    const r = await run({ argv, image: 'gmft/network:0.3', timeoutMs: 300_000 });
    const parsed2 = parseRustscanOutput(r.stdout);
    const findings = rustscanFindings(parsed2, parsed.target);
    return {
      openPorts: parsed2.openPorts,
      count: parsed2.count,
      findings,
      durationMs: r.durationMs,
      mode: r.mode,
      fellBack: r.fellBack,
    };
  },
};
