/**
 * Tool picker for the TUI.
 *
 * Pure helpers that turn the catalog (`@gmft/tools`'s `tools` array)
 * into the formatted text that the `/tools [domain]` slash command
 * surfaces. No I/O, no React — easy to test, easy to reuse from a
 * future `/chains` command.
 *
 * The output is plain text (no Ink components); the chat's existing
 * `Message` component renders it as a `role: 'system'` row, so we get
 * the muted `sys` prefix for free.
 *
 * Format:
 *   27 tools registered:
 *
 *   network (12)
 *     nmap              [binary]  flags: targetRequired
 *       TCP port scan with nmap. -oX - emits XML to stdout for parsing.
 *     masscan           [binary]  flags: targetRequired, destructive
 *       Internet-scale port scanner. ...
 *     ...
 *
 *   web (8)
 *     ...
 *
 *   wifi (5)
 *     ...
 *
 *   reports (2)
 *     ...
 *
 *   shell (1)
 *     ...
 *
 * Domains: a tool's category is one of 'network' | 'web' | 'wifi'
 * | 'reports' | 'shell' | 'note'. `note` tools (none registered
 * today) would land in their own group.
 */

import { tools } from '@gmft/tools';
import { TOOL_CATEGORIES, type ToolCategory } from '@gmft/core';

export type { ToolCategory } from '@gmft/core';

export type ToolDomain = ToolCategory | string;

export interface ToolEntry {
  name: string;
  category: string;
  flags: readonly string[];
  description: string;
}

/**
 * Frozen view of the catalog. Built once at module load; tests can
 * call `listTools()` directly to assert the live catalog.
 *
 * v0.3.B — the `tools` array now exposes `description` too, so we
 * surface it. Older builds that pre-date the field get an empty
 * string (avoids `undefined` in the rendered output).
 */
const CATALOG: readonly ToolEntry[] = Object.freeze(
  tools.map((t) =>
    Object.freeze({
      name: t.name,
      category: t.category as ToolDomain,
      flags: Object.freeze([...t.flags]),
      description: (t as { description?: string }).description ?? '',
    }),
  ),
);

export function listTools(): readonly ToolEntry[] {
  return CATALOG;
}

/**
 * v0.3.B — the domain order used to be a hand-rolled list of
 * `network | web | wifi | reports | shell | note` strings, but
 * those never matched the live `category` field on the catalog
 * (which is `ToolCategory` from `@gmft/core`: `shell | http |
 * file | search | recon | binary | note`). The result was that
 * `groupByDomain` filtered every tool out and `/tools` rendered
 * an empty list. Use the canonical `TOOL_CATEGORIES` list as
 * the source of truth so the picker and the catalog stay in
 * lockstep — if a new category is added to core, the picker
 * automatically picks it up.
 */
const DOMAIN_ORDER: readonly ToolDomain[] = TOOL_CATEGORIES;

/**
 * Look up a tool by exact name. Returns undefined when not found.
 * Used by the `/run <tool>` parser so the slash command stays a
 * thin wrapper over the catalog.
 */
export function findTool(name: string): ToolEntry | undefined {
  return CATALOG.find((t) => t.name === name);
}

/**
 * Group the catalog by domain. Returns a sorted-by-domain list of
 * `{ domain, entries }` rows. Within a row, entries are sorted
 * alphabetically by name so the output is deterministic.
 *
 * If `domainFilter` is given and matches a known domain, only that
 * group's row is returned. Unknown domain strings yield an empty
 * array (the caller surfaces "unknown domain" to the user).
 */
export function groupByDomain(
  entries: readonly ToolEntry[],
  domainFilter?: string,
): readonly { domain: ToolDomain; entries: readonly ToolEntry[] }[] {
  const buckets = new Map<ToolDomain, ToolEntry[]>();
  for (const e of entries) {
    const arr = buckets.get(e.category as ToolDomain);
    if (arr) {
      arr.push(e);
    } else {
      buckets.set(e.category as ToolDomain, [e]);
    }
  }
  const rows: { domain: ToolDomain; entries: readonly ToolEntry[] }[] = [];
  for (const domain of DOMAIN_ORDER) {
    if (domainFilter && domainFilter !== domain) continue;
    const list = buckets.get(domain);
    if (!list || list.length === 0) continue;
    const sorted = [...list].sort((a, b) => a.name.localeCompare(b.name));
    rows.push({ domain, entries: Object.freeze(sorted) });
  }
  return Object.freeze(rows);
}

const NAME_COL = 18;
const FLAG_COL = 30;

function pad(name: string, width: number): string {
  if (name.length >= width) return name;
  return name + ' '.repeat(width - name.length);
}

function renderFlags(flags: readonly string[]): string {
  if (flags.length === 0) return '';
  return `flags: ${flags.join(', ')}`;
}

/**
 * Format the tool list for display in the chat.
 *
 * Returns `{ text, count, domainCount }`. The `text` field is what
 * the slash dispatcher pushes into the chat as a `role: 'system'`
 * message. `count` is the number of tools rendered (after any
 * domain filter). `domainCount` is the number of domain groups
 * rendered — useful for tests and for the heading line.
 */
export interface ToolListResult {
  text: string;
  count: number;
  domainCount: number;
}

export function formatToolList(domainFilter?: string): ToolListResult {
  const rows = groupByDomain(CATALOG, domainFilter);
  const totalCount = rows.reduce((acc, r) => acc + r.entries.length, 0);

  const lines: string[] = [];
  if (domainFilter) {
    lines.push(`${totalCount} ${domainFilter} tool${totalCount === 1 ? '' : 's'}:`);
  } else {
    lines.push(
      `${totalCount} tool${totalCount === 1 ? '' : 's'} registered:`,
    );
  }
  lines.push('');

  for (const row of rows) {
    lines.push(`${row.domain} (${row.entries.length})`);
    for (const tool of row.entries) {
      const head = `  ${pad(tool.name, NAME_COL - 2)} [${tool.category}]`;
      const flags = renderFlags(tool.flags);
      // First line: name + category + (flags, if any), padded for
      // a clean second column. Second line: indented description.
      if (flags) {
        lines.push(pad(head, FLAG_COL) + flags);
      } else {
        lines.push(head);
      }
      // Description is wrapped to 80 cols. We don't pull in a wrap
      // dep — descriptions are one short line (~80-120 chars), so a
      // simple indent + slice into 72-char chunks is good enough.
      const desc = tool.description.trim();
      const indent = '    ';
      const maxWidth = 80 - indent.length;
      if (desc.length <= maxWidth) {
        lines.push(`${indent}${desc}`);
      } else {
        let rest = desc;
        while (rest.length > maxWidth) {
          // Try to break on a space near the boundary
          let cut = rest.lastIndexOf(' ', maxWidth);
          if (cut <= indent.length) cut = maxWidth;
          lines.push(`${indent}${rest.slice(0, cut)}`);
          rest = rest.slice(cut).trimStart();
        }
        if (rest.length > 0) lines.push(`${indent}${rest}`);
      }
    }
    lines.push('');
  }

  // Trim trailing blank line.
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }

  return {
    text: lines.join('\n'),
    count: totalCount,
    domainCount: rows.length,
  };
}
