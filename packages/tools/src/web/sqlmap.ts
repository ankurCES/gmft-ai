import { z } from 'zod';
import { run } from '../shared/runner';
import type { Tool, ToolContext, Finding } from '@gmft/core';

export const SqlmapInput = z.object({
  url: z.string().min(1),
  data: z.string().optional(),
  level: z.number().int().min(1).max(5).default(1),
  risk: z.number().int().min(1).max(3).default(1),
});
export type SqlmapInputT = z.infer<typeof SqlmapInput>;

export const SqlmapOutput = z.object({
  findings: z.array(z.any()),
  mode: z.enum(['host', 'docker']),
  fellBack: z.boolean(),
  durationMs: z.number(),
});
export type SqlmapOutputT = z.infer<typeof SqlmapOutput>;

const injectableLine = /parameter '([^']+)' is vulnerable/i;
const paramBlock = /Parameter:\s*([^\n]+)/;

export function parseSqlmapText(text: string, target: string): Finding[] {
  const findings: Finding[] = [];
  const seen = new Set<string>();
  let n = 0;
  // First pass: lines that say "parameter X is vulnerable"
  for (const line of text.split('\n')) {
    const m = line.match(injectableLine);
    const param = m?.[1];
    if (param && !seen.has(param)) {
      seen.add(param);
      findings.push({
        id: `sqlmap-${n++}-${Date.now()}`,
        tool: 'sqlmap',
        target,
        title: `SQL injection in ${param}`,
        severity: 'critical',
        evidence: line.trim(),
        ts: Date.now(),
      });
    }
  }
  // Second pass: parameter blocks (Type, Title, Payload)
  for (const block of text.split(/\n---\n/)) {
    const pm = block.match(paramBlock);
    const param = pm?.[1];
    if (param && !seen.has(param)) {
      seen.add(param);
      findings.push({
        id: `sqlmap-${n++}-${Date.now()}`,
        tool: 'sqlmap',
        target,
        title: `SQL injection in ${param}`,
        severity: 'critical',
        evidence: block.trim().split('\n').slice(0, 4).join(' | '),
        ts: Date.now(),
      });
    }
  }
  return findings;
}

export const sqlmapTool: Tool<typeof SqlmapInput, typeof SqlmapOutput> = {
  name: 'sqlmap',
  category: 'binary',
  description:
    'Run sqlmap SQL-injection scanner against a URL. DESTRUCTIVE — chokepoint will require confirmation.',
  input: SqlmapInput,
  output: SqlmapOutput,
  flags: ['destructive'],
  async run(input: SqlmapInputT, _ctx: ToolContext): Promise<SqlmapOutputT> {
    const parsed0 = SqlmapInput.parse(input);
    const argv = [
      'sqlmap',
      '-u',
      parsed0.url,
      '--level',
      String(parsed0.level),
      '--risk',
      String(parsed0.risk),
      '--batch',
    ];
    if (parsed0.data) argv.push('--data', parsed0.data);
    const r = await run({ argv, timeoutMs: 600_000 });
    const findings = parseSqlmapText(r.stdout, parsed0.url);
    return {
      findings,
      mode: r.mode,
      fellBack: r.fellBack,
      durationMs: r.durationMs,
    };
  },
};
