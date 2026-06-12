import { z } from 'zod';
import { run } from '../shared/runner.js';
import type { Tool, ToolContext, Finding } from '@gmft/core';

/**
 * v0.3.B — Task 2. Internet-scale port scanner. Wraps `masscan` which
 * is fast enough to scan the entire IPv4 internet in under 5 minutes
 * (per the upstream README). Use sparingly and only with explicit
 * authorization.
 *
 * We invoke `masscan -p<ports> --rate=<rate> -oL - <target>` and read
 * the machine-readable list output. The `-oL -` form writes one
 * line per result to stdout in the canonical:
 *   `Discovered open port <port>/<proto> on <ip>`
 * shape, which is trivial to parse line-by-line. The plan's parser
 * is the strict form of that line; everything else (banners,
 * progress, "Starting masscan ...") is ignored.
 */
export const MasscanInput = z.object({
  target: z.string().min(1),
  ports: z.string().min(1),
  rate: z.number().int().positive(),
});
export type MasscanInputT = z.infer<typeof MasscanInput>;

export const MasscanPort = z.object({
  port: z.number().int(),
  protocol: z.string(),
  ip: z.string().optional(),
});
export type MasscanPort = z.infer<typeof MasscanPort>;

export const MasscanParsed = z.object({
  openPorts: z.array(MasscanPort),
  count: z.number(),
});
export type MasscanParsedT = z.infer<typeof MasscanParsed>;

export const MasscanOutput = z.object({
  openPorts: z.array(MasscanPort),
  count: z.number(),
  findings: z.array(z.any()),
  durationMs: z.number(),
  mode: z.enum(['host', 'host+landlock', 'host+seccomp', 'host+landlock+seccomp', 'docker']),
  fellBack: z.boolean(),
});
export type MasscanOutputT = z.infer<typeof MasscanOutput>;

const PORT_LINE = /^Discovered open port (\d+)\/(\w+) on (\S+)/;

/**
 * Parse masscan's `-oL -` (list) format. Returns one entry per open
 * port. Empty / whitespace-only input returns an empty result set.
 */
export function parseMasscanOutput(stdout: string): MasscanParsedT {
  const openPorts: MasscanPort[] = [];
  if (!stdout || stdout.trim() === '') {
    return { openPorts, count: 0 };
  }
  for (const line of stdout.split('\n')) {
    const m = PORT_LINE.exec(line);
    if (!m) continue;
    openPorts.push({
      port: Number(m[1]),
      protocol: m[2]!,
      ip: m[3]!,
    });
  }
  return { openPorts, count: openPorts.length };
}

/**
 * Turn parsed open ports into one Finding per port. `medium` severity
 * is the right default: an open port isn't a vulnerability on its own,
 * but it's the precondition for almost every network finding.
 */
export function masscanFindings(parsed: MasscanParsedT, target: string): Finding[] {
  const out: Finding[] = [];
  const now = Date.now();
  const targetSlug = target.replace(/[^a-zA-Z0-9.-]/g, '-');
  parsed.openPorts.forEach((p, idx) => {
    const where = p.ip ? `${p.ip}:${p.port}/${p.protocol}` : `${p.port}/${p.protocol}`;
    out.push({
      id: `masscan-${targetSlug}-${p.port}-${p.protocol}-${idx}-${now}`,
      tool: 'masscan',
      target,
      title: `Open ${p.protocol.toUpperCase()} port ${p.port}${p.ip ? ` on ${p.ip}` : ''}`,
      description: `masscan discovered an open ${p.protocol.toUpperCase()} port (${p.port}) on ${target}.`,
      evidence: where,
      severity: 'medium',
      ts: now,
    });
  });
  return out;
}

export const masscanTool: Tool<typeof MasscanInput, typeof MasscanOutput> = {
  name: 'masscan',
  category: 'recon',
  flags: ['targetRequired'],
  // v0.3.B — opt in to scope-mode fan-out. The agent can pass
  // `args.target` as a path to a targets file and the executor will
  // clone the args per line and replace `target` with each line. The
  // chokepoint still gates individual runs via `targetRequired`.
  targetsFromFile: true,
  description:
    'Internet-scale port scanner. Discovers open TCP/UDP ports across large address ranges. Use only with authorization.',
  input: MasscanInput,
  output: MasscanOutput,
  async run(input: MasscanInputT, _ctx: ToolContext): Promise<MasscanOutputT> {
    const parsed = MasscanInput.parse(input);
    const argv = [
      'masscan',
      '-p', parsed.ports,
      '--rate', String(parsed.rate),
      '-oL', '-',
      parsed.target,
    ];
    const r = await run({ argv, image: 'gmft/network:0.3', timeoutMs: 300_000 });
    const parsed2 = parseMasscanOutput(r.stdout);
    const findings = masscanFindings(parsed2, parsed.target);
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
