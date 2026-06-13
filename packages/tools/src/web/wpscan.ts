import { z } from 'zod';
import { run } from '../shared/runner.js';
import type { Tool, ToolContext, Finding } from '@gmft/core';

export const WpscanInput = z.object({
  target: z.string().min(1).url(),
  enumerate: z.string().optional(),
  apiToken: z.string().optional(),
  detectPluginVersion: z.boolean().optional(),
  userscan: z.boolean().optional(),
});
export type WpscanInputT = z.infer<typeof WpscanInput>;

export const WpscanOutput = z.object({
  findings: z.array(z.any()),
  mode: z.enum(['host', 'host+landlock', 'host+seccomp', 'host+landlock+seccomp', 'docker']),
  fellBack: z.boolean(),
  durationMs: z.number(),
});
export type WpscanOutputT = z.infer<typeof WpscanOutput>;

export interface WpscanPlugin {
  name: string;
  version?: string;
  outdated: boolean;
}
export interface WpscanTheme {
  name: string;
  version?: string;
  outdated: boolean;
}
export interface WpscanVulnerability {
  title: string;
  component: string; // plugin or theme name
  componentType: 'plugin' | 'theme' | 'wordpress';
}
export interface WpscanUsername {
  username: string;
}
export interface WpscanParsed {
  wordpressVersion?: string;
  plugins: WpscanPlugin[];
  themes: WpscanTheme[];
  vulnerabilities: WpscanVulnerability[];
  usernames: WpscanUsername[];
}

/**
 * Parse wpscan human-readable output.
 *
 * wpscan output is line-based with status prefixes:
 *   [+] — positive detection
 *   [i] — informational
 *   [!] — warning / vulnerability
 *   [?] — unknown
 *
 * We extract:
 *   - WordPress core version (from "[i] WordPress version X.Y.Z")
 *   - Plugins from "[+] <name>" followed by " | Location:" and " | Latest Version:"
 *   - Themes from "[+] <name>" (in the Themes section)
 *   - Usernames from "[i] User(s) Identified:" block (one username per line)
 *   - Vulnerabilities from "[!] Title: <title>" in the context of a plugin/theme
 *
 * The output is one big text block and wpscan does not emit machine-
 * readable markers (e.g. JSON) without --format json. This parser
 * targets the default human-readable output.
 */
export function parseWpscanOutput(text: string): WpscanParsed {
  const out: WpscanParsed = {
    plugins: [],
    themes: [],
    vulnerabilities: [],
    usernames: [],
  };

  const lines = text.split('\n');
  let section: 'header' | 'plugins' | 'themes' | 'users' | 'other' = 'header';

  /**
   * Apply a `| Key: Value` or `| Key: Value (annotation)` line to the
   * most recent plugin/theme. Returns true if it matched and was
   * applied.
   */
  function applySubLine(
    line: string,
    target: { name: string; version?: string; outdated: boolean } | undefined,
  ): boolean {
    if (!target) return false;
    if (!line.startsWith('|')) return false;
    // Strip leading pipe + whitespace.
    const rest = line.replace(/^\|\s+/, '');

    // Version detection. wpscan emits one of:
    //   "Version: 5.3"
    //   "Latest Version: 5.3"
    //   "Confirmed By: ... (Aggressive Detection)" (does NOT carry version)
    // We also see " | Version: 5.3 (80% confidence)" and ignore the suffix.
    const verMatch = rest.match(/^(?:Latest\s+)?Version:\s+(\S+)/);
    if (verMatch) {
      target.version = verMatch[1];
      return true;
    }
    // Status: "Outdated" or "Up To Date" or "Latest" (insecure).
    if (/^Status:\s+Outdated/.test(rest)) {
      target.outdated = true;
      return true;
    }
    // Vulnerability under a plugin/theme: " [!] Title: ..."
    const vuln = rest.match(/^\[!\] Title:\s+(.+)/);
    if (vuln) {
      // Caller decides componentType by which array is being filled.
      return false; // handled outside
    }
    return false;
  }

  for (const raw of lines) {
    // Trim both ends so we can match pipes at the start regardless
    // of indentation depth. wpscan indents sub-lines with a single
    // space before the pipe.
    const line = raw.trim();

    // Section markers — wpscan uses headers like "[+] Plugin(s)" or
    // "[+] Themes" or "[i] User(s) Identified".
    if (/^\[\+\]\s+Plugin\(s\)/.test(line)) {
      section = 'plugins';
      continue;
    }
    if (/^\[\+\]\s+Theme\(s\)/.test(line)) {
      section = 'themes';
      continue;
    }
    if (/^\[i\]\s+User\(s\)\s+Identified/.test(line)) {
      section = 'users';
      continue;
    }

    // WordPress core version. Real wpscan emits this as:
    //   "[+] WordPress version 6.4.2 identified (Insecure, ...)"
    // Sometimes also as:
    //   "[i] WordPress version 6.4.2 identified"
    // Accept both prefixes.
    const wpVer = line.match(/^\[[+i]\]\s+WordPress version (\S+) identified/);
    if (wpVer) {
      out.wordpressVersion = wpVer[1];
      continue;
    }

    // Plugin entry: "[+] <slug>". Real wpscan plugin names are
    // slug-shaped: lowercase alphanumerics + `-` + `_` + `.`. We
    // explicitly exclude patterns wpscan uses for non-plugin lines,
    // e.g. "[+] WordPress user : admin" or "[+] Headers".
    if (section === 'plugins') {
      const pluginHeader = line.match(/^\[\+\]\s+([a-z0-9][a-z0-9._-]*)\s*$/i);
      const headerName = pluginHeader?.[1];
      if (headerName) {
        out.plugins.push({ name: headerName, outdated: false });
        continue;
      }
      // Vulnerability indented under a plugin: " | [!] Title: ..."
      const pluginVuln = line.match(/^\|\s+\[!\] Title:\s+(.+)/);
      const pluginVulnTitle = pluginVuln?.[1];
      if (pluginVulnTitle && out.plugins.length > 0) {
        out.vulnerabilities.push({
          title: pluginVulnTitle,
          component: out.plugins[out.plugins.length - 1]!.name,
          componentType: 'plugin',
        });
        continue;
      }
      // Other indented sub-lines: version / status applied to last plugin.
      if (applySubLine(line, out.plugins[out.plugins.length - 1])) continue;
    }

    // Theme entries appear under "[+] WordPress theme in use: <name>"
    // (a single in-use theme) and also under "[+] Theme(s)" listings.
    // The in-use theme is always printed before the Plugin(s) section.
    const themeInUse = line.match(/^\[\+\]\s+WordPress theme in use:\s+(.+?)\s*$/);
    const themeInUseName = themeInUse?.[1];
    if (themeInUseName) {
      out.themes.push({ name: themeInUseName, outdated: false });
      continue;
    }

    // Theme sub-lines that follow either the in-use header (section
    // is still 'header' at that point) or any theme under [+] Theme(s).
    // We accept theme sub-lines in any section as long as we have at
    // least one theme and the section is not explicitly "plugins" or
    // "users".
    if (section !== 'plugins' && section !== 'users' && out.themes.length > 0) {
      const themeVuln = line.match(/^\|\s+\[!\] Title:\s+(.+)/);
      const themeVulnTitle = themeVuln?.[1];
      if (themeVulnTitle) {
        out.vulnerabilities.push({
          title: themeVulnTitle,
          component: out.themes[out.themes.length - 1]!.name,
          componentType: 'theme',
        });
        continue;
      }
      if (applySubLine(line, out.themes[out.themes.length - 1])) continue;
    }

    // Usernames: each user is one line like "[+] admin" or "[i] admin"
    // under the [i] User(s) Identified: block.
    if (section === 'users') {
      const userMatch = line.match(/^\[[+i]\]\s+(\S+)\s*$/);
      const username = userMatch?.[1];
      if (username) {
        out.usernames.push({ username });
        continue;
      }
    }
  }

  return out;
}

/**
 * Convert parsed wpscan output into Finding records.
 *
 * Severity mapping:
 *   - WordPress version detected          -> info
 *   - Outdated plugin/theme (no vuln)     -> medium
 *   - Plugin/theme/wordpress vulnerability -> high
 *   - Enumerated username                  -> medium
 *   - Plugin/theme detected (in-date)     -> info
 */
export function wpscanToFindings(parsed: WpscanParsed): Finding[] {
  const out: Finding[] = [];
  const now = Date.now();
  let n = 0;

  const slug = (s: string) => s.replace(/[^a-zA-Z0-9.-]/g, '-');

  if (parsed.wordpressVersion) {
    out.push({
      id: `wpscan-${n++}-${now}`,
      tool: 'wpscan',
      target: '',
      title: `WordPress ${parsed.wordpressVersion} detected`,
      severity: 'info',
      description: `wpscan identified WordPress core version ${parsed.wordpressVersion}.`,
      evidence: parsed.wordpressVersion,
      ts: now,
      meta: { slug: slug(parsed.wordpressVersion) },
    });
  }

  for (const p of parsed.plugins) {
    out.push({
      id: `wpscan-${n++}-${now}`,
      tool: 'wpscan',
      target: p.name,
      title: p.version
        ? `Plugin: ${p.name} ${p.version}${p.outdated ? ' (outdated)' : ''}`
        : `Plugin: ${p.name}${p.outdated ? ' (outdated)' : ''}`,
      severity: p.outdated ? 'medium' : 'info',
      description: `wpscan detected plugin ${p.name}` +
        (p.version ? ` version ${p.version}` : '') +
        (p.outdated ? ' which is out of date' : ''),
      ts: now,
      meta: { slug: slug(p.name), version: p.version, outdated: p.outdated },
    });
  }

  for (const t of parsed.themes) {
    out.push({
      id: `wpscan-${n++}-${now}`,
      tool: 'wpscan',
      target: t.name,
      title: t.version
        ? `Theme: ${t.name} ${t.version}${t.outdated ? ' (outdated)' : ''}`
        : `Theme: ${t.name}${t.outdated ? ' (outdated)' : ''}`,
      severity: t.outdated ? 'medium' : 'info',
      description: `wpscan detected theme ${t.name}` +
        (t.version ? ` version ${t.version}` : '') +
        (t.outdated ? ' which is out of date' : ''),
      ts: now,
      meta: { slug: slug(t.name), version: t.version, outdated: t.outdated },
    });
  }

  for (const v of parsed.vulnerabilities) {
    out.push({
      id: `wpscan-${n++}-${now}`,
      tool: 'wpscan',
      target: v.component,
      title: `Vulnerable ${v.componentType}: ${v.component} — ${v.title}`,
      severity: 'high',
      description: `wpscan reports ${v.component} (${v.componentType}) has vulnerability: ${v.title}`,
      ts: now,
      meta: { slug: slug(v.component), vulnTitle: v.title, componentType: v.componentType },
    });
  }

  for (const u of parsed.usernames) {
    out.push({
      id: `wpscan-${n++}-${now}`,
      tool: 'wpscan',
      target: u.username,
      title: `Enumerated WordPress user: ${u.username}`,
      severity: 'medium',
      description: `wpscan enumerated WordPress user ${u.username} (attackers will target this username for credential attacks).`,
      ts: now,
      meta: { slug: slug(u.username) },
    });
  }

  return out;
}

export const wpscanTool: Tool<typeof WpscanInput, typeof WpscanOutput> = {
  name: 'wpscan',
  category: 'binary',
  description: 'Scan a WordPress site for vulnerable plugins, themes, and exposed users.',
  input: WpscanInput,
  output: WpscanOutput,
  flags: [],
  async run(input: WpscanInputT, _ctx: ToolContext): Promise<WpscanOutputT> {
    const parsed0 = WpscanInput.parse(input);
    const argv = ['wpscan', '--url', parsed0.target, '--no-banner'];
    if (parsed0.enumerate) argv.push('--enumerate', parsed0.enumerate);
    if (parsed0.apiToken) argv.push('--api-token', parsed0.apiToken);
    if (parsed0.detectPluginVersion) argv.push('--plugins-detection', 'aggressive');
    if (parsed0.userscan) argv.push('--userscan', 'stealthy');
    const r = await run({ argv, timeoutMs: 600_000 });
    const parsed = parseWpscanOutput(r.stdout);
    return {
      findings: wpscanToFindings(parsed),
      mode: r.mode,
      fellBack: r.fellBack,
      durationMs: r.durationMs,
    };
  },
};
