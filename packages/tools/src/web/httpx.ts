import { z } from 'zod';
import { run } from '../shared/runner.js';
import type { Tool, ToolContext, Finding } from '@gmft/core';

export const HttpxInput = z.object({
  target: z.string().min(1),
  ports: z.string().optional(),
  statusCode: z.boolean().optional(),
  contentLength: z.boolean().optional(),
  title: z.boolean().optional(),
  followRedirects: z.boolean().optional(),
  method: z.string().optional(),
});
export type HttpxInputT = z.infer<typeof HttpxInput>;

export const HttpxOutput = z.object({
  findings: z.array(z.any()),
  mode: z.enum(['host', 'host+landlock', 'host+seccomp', 'host+landlock+seccomp', 'docker']),
  fellBack: z.boolean(),
  durationMs: z.number(),
});
export type HttpxOutputT = z.infer<typeof HttpxOutput>;

export interface HttpxLine {
  url: string;
  statusCode?: number;
  contentLength?: number;
  title?: string;
}

/**
 * Parse httpx default text output.
 *
 * Format: one URL per line. With `-status-code`, `-content-length`, and
 * `-title` flags, the line looks like:
 *   https://example.com [200] [1234] [Example Domain]
 * Without those flags it's just the URL.
 */
export function parseHttpxOutput(text: string): HttpxLine[] {
  const lines: HttpxLine[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    // Match: <url> [[<status>]] [[<length>]] [[<title>]]
    const m = line.match(
      /^(\S+)(?:\s+\[(\d+)\])?(?:\s+\[(\d+)\])?(?:\s+\[(.*?)\])?\s*$/,
    );
    if (!m) continue;
    const [, url, statusCode, contentLength, title] = m;
    if (!url) continue;
    const line0: HttpxLine = { url };
    if (statusCode) line0.statusCode = Number(statusCode);
    if (contentLength) line0.contentLength = Number(contentLength);
    if (title) line0.title = title;
    lines.push(line0);
  }
  return lines;
}

/**
 * Convert parsed httpx lines into Finding records.
 *
 * Severity: any non-2xx/3xx status → medium (live but unexpected).
 * 2xx/3xx → info (live, healthy).
 */
export function httpxToFindings(lines: HttpxLine[]): Finding[] {
  return lines.map((l, i) => {
    const isUnexpected = l.statusCode !== undefined &&
      l.statusCode >= 400;
    const slug = l.url.replace(/[^a-zA-Z0-9.-]/g, '-');
    return {
      id: `httpx-${i}-${Date.now()}`,
      tool: 'httpx',
      target: l.url,
      title: l.title
        ? `${l.statusCode ?? '?'} — ${l.title}`
        : `HTTP ${l.statusCode ?? 'unknown'}`,
      severity: isUnexpected ? ('medium' as const) : ('info' as const),
      description: `httpx probed ${l.url}` +
        (l.statusCode ? ` (status ${l.statusCode})` : '') +
        (l.contentLength ? ` (length ${l.contentLength})` : ''),
      evidence: l.url,
      ts: Date.now(),
      meta: { slug, statusCode: l.statusCode, contentLength: l.contentLength, title: l.title },
    };
  });
}

export const httpxTool: Tool<typeof HttpxInput, typeof HttpxOutput> = {
  name: 'httpx',
  category: 'binary',
  description: 'Probe HTTP(S) endpoints for live hosts, status, title, and content length.',
  input: HttpxInput,
  output: HttpxOutput,
  flags: [],
  async run(input: HttpxInputT, _ctx: ToolContext): Promise<HttpxOutputT> {
    const parsed0 = HttpxInput.parse(input);
    const argv = ['httpx', '-u', parsed0.target, '-silent'];
    if (parsed0.ports) argv.push('-ports', parsed0.ports);
    if (parsed0.statusCode) argv.push('-status-code');
    if (parsed0.contentLength) argv.push('-content-length');
    if (parsed0.title) argv.push('-title');
    if (parsed0.followRedirects) argv.push('-follow-redirects');
    if (parsed0.method) argv.push('-method', parsed0.method);
    const r = await run({ argv, timeoutMs: 300_000 });
    const lines = parseHttpxOutput(r.stdout);
    return {
      findings: httpxToFindings(lines),
      mode: r.mode,
      fellBack: r.fellBack,
      durationMs: r.durationMs,
    };
  },
};
