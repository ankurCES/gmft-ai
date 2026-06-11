import { z } from 'zod';
import { run } from '../shared/runner';
import type { Tool, ToolContext, Finding } from '@gmft/core';

export const WhatwebInput = z.object({
  url: z.string().url(),
  aggression: z.number().int().min(1).max(4).default(1),
});
export type WhatwebInputT = z.infer<typeof WhatwebInput>;

export const WhatwebOutput = z.object({
  technologies: z.array(
    z.object({
      name: z.string(),
      value: z.string().optional(),
    }),
  ),
  findings: z.array(z.any()),
  durationMs: z.number(),
  mode: z.enum(['host', 'host+landlock', 'docker']),
  fellBack: z.boolean(),
});
export type WhatwebOutputT = z.infer<typeof WhatwebOutput>;

interface Tech {
  name: string;
  value?: string;
}

export function parseWhatweb(ndjson: string): Tech[] {
  const out: Tech[] = [];
  const seen = new Set<string>();
  for (const line of ndjson.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) continue;
    const plugins = (parsed as { plugins?: Record<string, unknown> }).plugins;
    if (!plugins) continue;
    for (const [name, raw] of Object.entries(plugins)) {
      // whatweb NDJSON emits plugins as either a flat string array
      // (e.g. `["nginx"]`) or an object with a `string` field
      // (e.g. `{ "string": ["nginx"], "version": [...] }`).
      let value: string | undefined;
      if (Array.isArray(raw)) {
        // Flat string array — take the first element if it's a string.
        if (typeof raw[0] === 'string') value = raw[0];
      } else if (raw && typeof raw === 'object') {
        const info = raw as { string?: string[] };
        value = info.string?.[0];
      }
      const key = `${name}|${value ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ name, value });
    }
  }
  return out;
}

export function whatwebFindings(techs: Tech[], target: string): Finding[] {
  const out: Finding[] = [];
  const now = Date.now();
  for (const t of techs) {
    out.push({
      id: `whatweb-${t.name.replace(/[^a-zA-Z0-9._-]/g, '-')}-${now}`,
      tool: 'whatweb',
      target,
      title: `Tech ${t.name}${t.value ? ` (${t.value})` : ''}`,
      description: t.value ?? t.name,
      evidence: t.value,
      severity: 'info',
      ts: now,
    });
  }
  return out;
}

export const whatwebTool: Tool<typeof WhatwebInput, typeof WhatwebOutput> = {
  name: 'whatweb',
  category: 'recon',
  flags: ['targetRequired'],
  description: 'Web technology fingerprinting with whatweb --log-json=-. -q quiet, --no-errors, -a 1-4 aggression.',
  input: WhatwebInput,
  output: WhatwebOutput,
  async run(input: WhatwebInputT, _ctx: ToolContext): Promise<WhatwebOutputT> {
    // Apply zod defaults (aggression) before using.
    const parsed0 = WhatwebInput.parse(input);
    const r = await run({
      argv: [
        'whatweb',
        '--no-errors',
        '-q',
        '--log-json=-',
        '-a',
        String(parsed0.aggression),
        parsed0.url,
      ],
      image: 'gmft/network:0.1',
      timeoutMs: 60_000,
    });
    const techs = parseWhatweb(r.stdout);
    const findings = whatwebFindings(techs, parsed0.url);
    return {
      technologies: techs,
      findings,
      durationMs: r.durationMs,
      mode: r.mode,
      fellBack: r.fellBack,
    };
  },
};
