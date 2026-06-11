import { z } from 'zod';
import { run } from '../shared/runner';
import type { Tool, ToolContext, Finding } from '@gmft/core';

export const GobusterInput = z.object({
  url: z.string().min(1),
  wordlist: z.string().default('/usr/share/wordlists/dirb/common.txt'),
  mode: z.enum(['dir', 'dns', 'vhost']).default('dir'),
});
export type GobusterInputT = z.infer<typeof GobusterInput>;

export const GobusterOutput = z.object({
  findings: z.array(z.any()),
  mode: z.enum(['host', 'host+landlock', 'host+seccomp', 'host+landlock+seccomp', 'docker']),
  fellBack: z.boolean(),
  durationMs: z.number(),
});
export type GobusterOutputT = z.infer<typeof GobusterOutput>;

const pathLine = /^(\/[^\s]+)\s+\[Status:\s*(\d+)/;

export function parseGobusterText(text: string, target: string): Finding[] {
  const findings: Finding[] = [];
  let n = 0;
  for (const raw of text.split('\n')) {
    const m = raw.match(pathLine);
    if (!m) continue;
    const [, path, status] = m;
    findings.push({
      id: `gobuster-${n++}-${Date.now()}`,
      tool: 'gobuster',
      target,
      title: `${path} [Status: ${status}]`,
      severity: status === '200' ? 'low' : 'info',
      ts: Date.now(),
    });
  }
  return findings;
}

export const gobusterTool: Tool<typeof GobusterInput, typeof GobusterOutput> = {
  name: 'gobuster',
  category: 'binary',
  description: 'Run gobuster directory/DNS/vhost enumeration; returns parsed findings.',
  input: GobusterInput,
  output: GobusterOutput,
  flags: [],
  async run(input: GobusterInputT, _ctx: ToolContext): Promise<GobusterOutputT> {
    const parsed0 = GobusterInput.parse(input);
    const argv = [
      'gobuster',
      parsed0.mode,
      '-u',
      parsed0.url,
      '-w',
      parsed0.wordlist,
      '-q',
      '--no-error',
    ];
    const r = await run({ argv, timeoutMs: 300_000 });
    const findings = parseGobusterText(r.stdout, parsed0.url);
    return {
      findings,
      mode: r.mode,
      fellBack: r.fellBack,
      durationMs: r.durationMs,
    };
  },
};
