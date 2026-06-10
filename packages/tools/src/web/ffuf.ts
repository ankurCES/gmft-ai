import { z } from 'zod';
import { run } from '../shared/runner';
import type { Tool, ToolContext, Finding } from '@gmft/core';

export const FfufInput = z.object({
  url: z.string().min(1),
  wordlist: z.string().default('/usr/share/wordlists/dirb/common.txt'),
  match: z.string().optional(),
});
export type FfufInputT = z.infer<typeof FfufInput>;

export const FfufOutput = z.object({
  findings: z.array(z.any()),
  mode: z.enum(['host', 'docker']),
  fellBack: z.boolean(),
  durationMs: z.number(),
});
export type FfufOutputT = z.infer<typeof FfufOutput>;

export function parseFfufJson(text: string, target: string): Finding[] {
  const findings: Finding[] = [];
  let rec: any;
  try {
    rec = JSON.parse(text);
  } catch {
    return findings;
  }
  let n = 0;
  for (const r of rec.results ?? []) {
    const status = r.status;
    findings.push({
      id: `ffuf-${n++}-${Date.now()}`,
      tool: 'ffuf',
      target,
      title: `${r.input?.FUZZ ?? r.url ?? '?'} [Status: ${status}]`,
      severity: status === 200 ? 'low' : status === 403 ? 'low' : 'info',
      ts: Date.now(),
    });
  }
  return findings;
}

export const ffufTool: Tool<typeof FfufInput, typeof FfufOutput> = {
  name: 'ffuf',
  category: 'binary',
  description: 'Run ffuf web fuzzer; returns parsed findings.',
  input: FfufInput,
  output: FfufOutput,
  flags: [],
  async run(input: FfufInputT, _ctx: ToolContext): Promise<FfufOutputT> {
    const parsed0 = FfufInput.parse(input);
    const argv = ['ffuf', '-u', parsed0.url, '-w', parsed0.wordlist, '-json', '-s'];
    if (parsed0.match) argv.push('-mc', parsed0.match);
    const r = await run({ argv, timeoutMs: 300_000 });
    const findings = parseFfufJson(r.stdout, parsed0.url);
    return {
      findings,
      mode: r.mode,
      fellBack: r.fellBack,
      durationMs: r.durationMs,
    };
  },
};
