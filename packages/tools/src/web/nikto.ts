import { z } from 'zod';
import { run } from '../shared/runner.js';
import type { Tool, ToolContext, Finding } from '@gmft/core';

export const NiktoInput = z.object({
  target: z.string().min(1),
  tuning: z.string().optional(),
});
export type NiktoInputT = z.infer<typeof NiktoInput>;

export const NiktoOutput = z.object({
  findings: z.array(z.any()),
  mode: z.enum(['host', 'host+landlock', 'host+seccomp', 'host+landlock+seccomp', 'docker']),
  fellBack: z.boolean(),
  durationMs: z.number(),
});
export type NiktoOutputT = z.infer<typeof NiktoOutput>;

/**
 * Heuristic severity:
 * - "admin" / "phpmyadmin" / "login" → medium
 * - "apache" / "server-status" → low
 * - default → low
 */
function niktoSeverity(line: string): Finding['severity'] {
  const l = line.toLowerCase();
  if (l.includes('admin') || l.includes('login') || l.includes('phpmyadmin')) return 'medium';
  if (l.includes('server-status') || l.includes('apache')) return 'low';
  return 'low';
}

/** Meta lines that start with "+ " but are not findings. */
function isNiktoMeta(line: string): boolean {
  return (
    line.startsWith('+ Target ') ||
    line.startsWith('+ SSL') ||
    line.startsWith('+ Start') ||
    line.startsWith('+ Server:') ||
    line.includes('item(s) checked') ||
    line.includes('host(s) tested') ||
    line === '---------------------------------------------------------------------------'
  );
}

export function parseNiktoText(text: string, target: string): Finding[] {
  const findings: Finding[] = [];
  let n = 0;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('+ ')) continue;
    if (isNiktoMeta(line)) continue;
    const title = line.replace(/^\+\s*/, '').trim();
    findings.push({
      id: `nikto-${n++}-${Date.now()}`,
      tool: 'nikto',
      target,
      title,
      severity: niktoSeverity(title),
      ts: Date.now(),
    });
  }
  return findings;
}

export const niktoTool: Tool<typeof NiktoInput, typeof NiktoOutput> = {
  name: 'nikto',
  category: 'binary',
  description: 'Run nikto web server scanner; returns parsed findings.',
  input: NiktoInput,
  output: NiktoOutput,
  flags: [],
  async run(input: NiktoInputT, _ctx: ToolContext): Promise<NiktoOutputT> {
    const parsed0 = NiktoInput.parse(input);
    const argv = ['nikto', '-h', parsed0.target, '-Format', 'txt'];
    if (parsed0.tuning) argv.push('-Tuning', parsed0.tuning);
    const r = await run({ argv, timeoutMs: 300_000 });
    const findings = parseNiktoText(r.stdout, parsed0.target);
    return {
      findings,
      mode: r.mode,
      fellBack: r.fellBack,
      durationMs: r.durationMs,
    };
  },
};
