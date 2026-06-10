import { z } from 'zod';
import { run } from '../shared/runner';
import type { Tool, ToolContext, Finding } from '@gmft/core';

export const NucleiInput = z.object({
  target: z.string().min(1),
  templates: z.string().optional(),
  severity: z
    .enum(['info', 'low', 'medium', 'high', 'critical'])
    .optional(),
});
export type NucleiInputT = z.infer<typeof NucleiInput>;

export const NucleiOutput = z.object({
  findings: z.array(z.any()),
  mode: z.enum(['host', 'docker']),
  fellBack: z.boolean(),
  durationMs: z.number(),
});
export type NucleiOutputT = z.infer<typeof NucleiOutput>;

export function parseNucleiNdjson(text: string): Finding[] {
  const findings: Finding[] = [];
  let n = 0;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec: any;
    try {
      rec = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const info = rec.info ?? {};
    findings.push({
      id: `nuclei-${n++}-${Date.now()}`,
      tool: 'nuclei',
      target: String(rec['matched-at'] ?? rec.host ?? ''),
      title: String(info.name ?? rec.template ?? 'nuclei finding'),
      severity: (info.severity ?? 'info') as Finding['severity'],
      description: info.description,
      evidence: rec['matched-at'],
      ts: rec.timestamp ? Date.parse(rec.timestamp) : Date.now(),
    });
  }
  return findings;
}

export const nucleiTool: Tool<typeof NucleiInput, typeof NucleiOutput> = {
  name: 'nuclei',
  category: 'binary',
  description: 'Run nuclei templates against a target; returns parsed findings.',
  input: NucleiInput,
  output: NucleiOutput,
  flags: [],
  async run(input: NucleiInputT, _ctx: ToolContext): Promise<NucleiOutputT> {
    const parsed0 = NucleiInput.parse(input);
    const argv = ['nuclei', '-u', parsed0.target, '-json', '-silent'];
    if (parsed0.templates) argv.push('-t', parsed0.templates);
    if (parsed0.severity) argv.push('-severity', parsed0.severity);
    const r = await run({ argv, timeoutMs: 300_000 });
    const findings = parseNucleiNdjson(r.stdout);
    return {
      findings,
      mode: r.mode,
      fellBack: r.fellBack,
      durationMs: r.durationMs,
    };
  },
};
