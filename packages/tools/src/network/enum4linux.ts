import { z } from 'zod';
import { run } from '../shared/runner.js';
import type { Tool, ToolContext, Finding } from '@gmft/core';

/**
 * v0.3.B — Task 7. Enumerate information from Windows and Samba
 * systems via SMB. Wraps the legacy Perl `enum4linux` (and the
 * newer `enum4linux-ng` if available). Output is human-readable
 * text with section headers (Users, Shares, Groups, Password
 * Policy, etc.).
 *
 * We invoke `enum4linux -a <target>` and parse the well-known
 * section headers to extract structured data: usernames, share
 * names, and group names. The full text is also preserved in the
 * output for the operator to review.
 */
export const Enum4linuxInput = z.object({
  target: z.string().min(1),
  username: z.string().optional(),
  password: z.string().optional(),
  timeout: z.number().int().positive().max(60).default(10),
});
export type Enum4linuxInputT = z.infer<typeof Enum4linuxInput>;

export const Enum4linuxParsed = z.object({
  users: z.array(z.string()),
  shares: z.array(z.string()),
  groups: z.array(z.string()),
  os: z.string().optional(),
  raw: z.string(),
});
export type Enum4linuxParsedT = z.infer<typeof Enum4linuxParsed>;

export const Enum4linuxOutput = z.object({
  users: z.array(z.string()),
  shares: z.array(z.string()),
  groups: z.array(z.string()),
  os: z.string().optional(),
  raw: z.string(),
  findings: z.array(z.any()),
  durationMs: z.number(),
  mode: z.enum(['host', 'host+landlock', 'host+seccomp', 'host+landlock+seccomp', 'docker']),
  fellBack: z.boolean(),
});
export type Enum4linuxOutputT = z.infer<typeof Enum4linuxOutput>;

/**
 * Parse enum4linux text output. Section headers we care about:
 *   - `Users on <host>`: bullet list of usernames (`user:[username]`)
 *   - `Share Enumeration on <host>`: bullet list of share names (`Sharename: <name>`)
 *   - `Groups on <host>`: bullet list of group names (`group:[name]`)
 *   - `OS information on <host>`: OS string on the line `OS: <text>`
 *
 * Anything else (banners, progress, footers) is left in `raw` for
 * the operator to review but not extracted.
 */
export function parseEnum4linuxOutput(stdout: string): Enum4linuxParsedT {
  const out: Enum4linuxParsedT = {
    users: [],
    shares: [],
    groups: [],
    raw: stdout ?? '',
  };
  if (!stdout || stdout.trim() === '') {
    return out;
  }

  let section: 'unknown' | 'users' | 'shares' | 'groups' | 'os' | 'other' = 'unknown';
  let sectionHadContent = false;
  const lines = stdout.split('\n');
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    // Section header detection — case-insensitive prefix match.
    if (/^Users on /i.test(line)) {
      section = 'users';
      sectionHadContent = false;
      continue;
    }
    if (/^Share Enumeration on /i.test(line) || /^SMB share enumeration on /i.test(line)) {
      section = 'shares';
      sectionHadContent = false;
      continue;
    }
    if (/^Groups on /i.test(line)) {
      section = 'groups';
      sectionHadContent = false;
      continue;
    }
    if (/^OS information on /i.test(line) || /^Operating system on /i.test(line)) {
      section = 'os';
      sectionHadContent = false;
      continue;
    }
    // The `===` / `---` divider that appears immediately after a
    // section header is decorative — it should not reset the
    // current section. We only treat subsequent dividers as
    // end-of-section markers, and only if we've already seen
    // content for the current section.
    if (/^={3,}/.test(line) || /^-{3,}/.test(line)) {
      if (sectionHadContent) section = 'other';
      continue;
    }
    // End-of-section marker (common in enum4linux-ng output).
    if (line === '[+] Done' || line === '[-] Done') {
      section = 'other';
      continue;
    }

    if (section === 'users') {
      // Typical line: `user:[admin] rid:[0x1f4]` or `user:admin`
      const m = /^(?:user:)?\[?([A-Za-z0-9._$-]+)\]?/i.exec(line);
      if (m && m[1] && m[1]!.toLowerCase() !== 'rid') {
        out.users.push(m[1]!);
        sectionHadContent = true;
      }
    } else if (section === 'shares') {
      // Typical line: `Sharename       Type      Comment`  (header — skip)
      // Or data line:    `ADMIN$          Disk      Remote Admin`
      // We want the share name (first token of data lines).
      if (/^Sharename\b/i.test(line)) continue;
      const m = /^(\S+)\s+(Disk|IPC|Printer|Special)/.exec(line);
      if (m) {
        out.shares.push(m[1]!);
        sectionHadContent = true;
      }
    } else if (section === 'groups') {
      // Typical line: `group:[Domain Admins]` or `group:Domain Admins`
      const m = /^(?:group:)?\[?([A-Za-z0-9._ -]+?)\]?(?:\s+rid:|$)/i.exec(line);
      if (m && m[1]) {
        out.groups.push(m[1]!);
        sectionHadContent = true;
      }
    } else if (section === 'os') {
      // Typical line: `OS: Windows 10.0 Build 19041` (enum4linux classic)
      // or `OS details: Microsoft Windows 10 Pro` (enum4linux-ng)
      const m = /^OS(?:\s+details)?:\s+(.+)$/i.exec(line);
      if (m) {
        out.os = m[1]!.trim();
        sectionHadContent = true;
      }
    }
  }

  // Dedupe while preserving order.
  out.users = Array.from(new Set(out.users));
  out.shares = Array.from(new Set(out.shares));
  out.groups = Array.from(new Set(out.groups));
  return out;
}

/**
 * Findings: one Finding per discovered user / share / group. Severities:
 *   - high for any share named ADMIN$, C$, IPC$ (admin shares)
 *   - medium for any other share
 *   - medium for any user (lateral-movement risk)
 *   - low for groups
 */
export function enum4linuxFindings(parsed: Enum4linuxParsedT, target: string): Finding[] {
  const out: Finding[] = [];
  const now = Date.now();
  const targetSlug = target.replace(/[^a-zA-Z0-9.-]/g, '-');

  for (const u of parsed.users) {
    out.push({
      id: `enum4linux-user-${targetSlug}-${u}-${now}`,
      tool: 'enum4linux',
      target,
      title: `SMB user: ${u}`,
      description: `enum4linux discovered the SMB user ${u} on ${target}.`,
      evidence: u,
      severity: 'medium',
      ts: now,
    });
  }
  for (const s of parsed.shares) {
    const isAdminShare = /^[A-Z]\$$|^(ADMIN|IPC)\$$/i.test(s);
    out.push({
      id: `enum4linux-share-${targetSlug}-${s}-${now}`,
      tool: 'enum4linux',
      target,
      title: isAdminShare ? `Admin SMB share: ${s}` : `SMB share: ${s}`,
      description: `enum4linux discovered the SMB share ${s} on ${target}${isAdminShare ? ' (admin share — high risk if accessible)' : ''}.`,
      evidence: s,
      severity: isAdminShare ? 'high' : 'medium',
      ts: now,
    });
  }
  for (const g of parsed.groups) {
    out.push({
      id: `enum4linux-group-${targetSlug}-${g}-${now}`,
      tool: 'enum4linux',
      target,
      title: `SMB group: ${g}`,
      description: `enum4linux discovered the SMB group ${g} on ${target}.`,
      evidence: g,
      severity: 'low',
      ts: now,
    });
  }
  return out;
}

export const enum4linuxTool: Tool<typeof Enum4linuxInput, typeof Enum4linuxOutput> = {
  name: 'enum4linux',
  category: 'recon',
  flags: ['targetRequired'],
  // v0.3.B — opt in to scope-mode fan-out.
  targetsFromFile: true,
  description:
    'Enumerate users, shares, groups, and OS info from a remote SMB/Samba system. Use only with authorization.',
  input: Enum4linuxInput,
  output: Enum4linuxOutput,
  async run(input: Enum4linuxInputT, _ctx: ToolContext): Promise<Enum4linuxOutputT> {
    const parsed = Enum4linuxInput.parse(input);
    const argv = ['enum4linux', '-a', '-t', String(parsed.timeout), parsed.target];
    if (parsed.username) {
      argv.push('-u', parsed.username);
    }
    if (parsed.password) {
      argv.push('-p', parsed.password);
    }
    const r = await run({ argv, image: 'gmft/network:0.3', timeoutMs: 300_000 });
    const parsed2 = parseEnum4linuxOutput(r.stdout);
    const findings = enum4linuxFindings(parsed2, parsed.target);
    return {
      users: parsed2.users,
      shares: parsed2.shares,
      groups: parsed2.groups,
      os: parsed2.os,
      raw: parsed2.raw,
      findings,
      durationMs: r.durationMs,
      mode: r.mode,
      fellBack: r.fellBack,
    };
  },
};
