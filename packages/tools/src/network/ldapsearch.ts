import { z } from 'zod';
import { run } from '../shared/runner.js';
import type { Tool, ToolContext, Finding } from '@gmft/core';

/**
 * v0.3.B — Task 8. Query an LDAP directory and return entries.
 *
 * Invokes `ldapsearch -x -H ldap://<host> -b <baseDN> -s <scope> -LLL`
 * and parses the LDIF output into structured entries. The `-LLL` flags
 * disable schema output, comment output, and the LDIF version 1 header
 * (a.k.a. "the three Ls" — see `man ldapsearch`) which makes the
 * resulting LDIF easy to parse line-by-line.
 */
export const LdapsearchInput = z.object({
  host: z.string().min(1), // LDAP server hostname
  baseDN: z.string().min(1), // base DN
  scope: z.enum(['base', 'one', 'sub']).default('sub'),
});
export type LdapsearchInputT = z.infer<typeof LdapsearchInput>;

export const LdapsearchEntry = z.object({
  dn: z.string(),
  attrs: z.record(z.string(), z.array(z.string())),
});
export type LdapsearchEntry = z.infer<typeof LdapsearchEntry>;

export const LdapsearchOutput = z.object({
  entries: z.array(LdapsearchEntry),
  count: z.number(),
  findings: z.array(z.any()),
  durationMs: z.number(),
  mode: z.enum(['host', 'host+landlock', 'host+seccomp', 'host+landlock+seccomp', 'docker']),
  fellBack: z.boolean(),
});
export type LdapsearchOutputT = z.infer<typeof LdapsearchOutput>;

/**
 * Parse an LDIF document (the kind `ldapsearch -LLL` emits) into
 * structured entries.
 *
 * LDIF rules we follow:
 *   - Entries are separated by blank lines.
 *   - The first line of an entry is `dn: <DN>`.
 *   - Attribute lines look like `attrName: value`. A continuation
 *     line starts with a single space — we don't handle those (rare
 *     in `-LLL` output and out of scope for the recon tool).
 *   - Lines starting with `#` are comments — skipped.
 *   - `version: 1` is the LDIF version header — skipped.
 *   - Multi-valued attributes appear as multiple lines with the
 *     same `attrName:` prefix; we collect them into an array.
 *
 * Empty / whitespace-only input returns `{ entries: [] }`.
 */
export function parseLdapsearchLdif(stdout: string): { entries: LdapsearchEntry[] } {
  const entries: LdapsearchEntry[] = [];
  if (!stdout || stdout.trim() === '') {
    return { entries };
  }

  // Split on blank lines. LDIF may use \n or \r\n; collapse CRLF first
  // so the regex stays simple.
  const normalized = stdout.replace(/\r\n/g, '\n');
  const blocks = normalized.split(/\n\s*\n/);

  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.length > 0);
    if (lines.length === 0) continue;

    // Skip the LDIF version header (it's a single `version: 1` line
    // sitting alone in its block when `-LLL` is partially bypassed).
    if (lines.length === 1 && lines[0]!.toLowerCase().startsWith('version:')) continue;

    let dn: string | null = null;
    const attrs: Record<string, string[]> = {};
    for (const line of lines) {
      // Skip comments.
      if (line.startsWith('#')) continue;
      // Skip `version:` headers (in case they appear alongside entries).
      if (line.toLowerCase().startsWith('version:')) continue;
      // The first colon separates the attribute name from the value.
      // We only need a single split — LDIF values themselves shouldn't
      // contain a leading colon.
      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) continue;
      const name = line.slice(0, colonIdx).trim();
      const value = line.slice(colonIdx + 1).trimStart();
      if (name.toLowerCase() === 'dn') {
        dn = value;
        continue;
      }
      if (name.length === 0) continue;
      const bucket = attrs[name] ?? [];
      bucket.push(value);
      attrs[name] = bucket;
    }
    if (dn === null) continue; // not a valid entry — skip
    entries.push({ dn, attrs });
  }

  return { entries };
}

/**
 * Turn parsed entries into one Finding per entry. The `target` is the
 * input host — the Finding records which server was queried, not
 * which DN was returned (the DN is the title, so it's still
 * recoverable from the Finding).
 */
export function ldapsearchFindings(
  parsed: { entries: LdapsearchEntry[] },
  target: string,
): Finding[] {
  const out: Finding[] = [];
  const now = Date.now();
  const hostSlug = target.replace(/[^a-zA-Z0-9.-]/g, '-');
  parsed.entries.forEach((entry, idx) => {
    out.push({
      id: `ldapsearch-${hostSlug}-${idx}-${now}`,
      tool: 'ldapsearch',
      target,
      title: `LDAP entry: ${entry.dn}`,
      description: `Discovered LDAP entry on ${target} (${Object.keys(entry.attrs).length} attributes).`,
      evidence: entry.dn,
      severity: 'low',
      ts: now,
    });
  });
  return out;
}

export const ldapsearchTool: Tool<typeof LdapsearchInput, typeof LdapsearchOutput> = {
  name: 'ldapsearch',
  category: 'recon',
  flags: ['targetRequired'],
  // v0.3.B — opt in to scope-mode fan-out. The agent can pass
  // `args.host` as a path to a targets file and the executor will
  // clone the args per line and replace `host` with each line. The
  // chokepoint still gates individual runs via `targetRequired`.
  targetsFromFile: true,
  description: 'Query an LDAP directory. Returns entries with their attributes.',
  input: LdapsearchInput,
  output: LdapsearchOutput,
  async run(input: LdapsearchInputT, _ctx: ToolContext): Promise<LdapsearchOutputT> {
    const parsed = LdapsearchInput.parse(input);
    const argv = [
      'ldapsearch',
      '-x',
      '-H', `ldap://${parsed.host}`,
      '-b', parsed.baseDN,
      '-s', parsed.scope,
      '-LLL',
    ];
    const r = await run({ argv, image: 'gmft/network:0.3', timeoutMs: 60_000 });
    const parsed2 = parseLdapsearchLdif(r.stdout);
    const findings = ldapsearchFindings(parsed2, parsed.host);
    return {
      entries: parsed2.entries,
      count: parsed2.entries.length,
      findings,
      durationMs: r.durationMs,
      mode: r.mode,
      fellBack: r.fellBack,
    };
  },
};
