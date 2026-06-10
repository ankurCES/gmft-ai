/**
 * report_write — read the current session's findings, filter them by
 * severity (and the operator's selection sidecar), and write a
 * self-contained markdown or HTML report.
 *
 * The tool's `args` carry `baseDir` and `sessionId` rather than
 * reading them from `ToolContext` so the tool stays pure: the same
 * report can be regenerated for any past session. This matches the
 * existing `FindingsStore` shape (which already takes a `baseDir` +
 * `sessionId`).
 *
 * Output path policy (per plan §B.1, open-question #2):
 *   - default = `${dataDir()}/gmft/reports/${sessionId}.${ext}`
 *   - user override: `outputPath` is normalized via `path.resolve` and
 *     must resolve inside the reports dir. `..` escape throws.
 *   - if the file already exists, a timestamp segment is inserted
 *     before the extension to avoid clobber.
 *
 * Selections integration (per plan §B.3): if the sidecar
 * `${baseDir}/${sessionId}.selections.json` exists and contains a
 * non-empty `checkedIds` array, ONLY those findings are included
 * (the severity filter is still applied on top as a safety net).
 * If the sidecar is missing or empty, the severity filter is the
 * sole gate. This lets the operator drive the report from the TUI
 * (FindingsTab checkboxes) or call `report_write` directly with no
 * UI interaction — both paths work.
 *
 * Flags: `destructive` because the tool writes a file outside the
 * session's working dir. Not `requiresElevation` because the path is
 * always under `~/.local/share`, which is user-writable.
 */
import { z } from 'zod';
import { writeFileSync, mkdirSync, existsSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve, basename, extname } from 'node:path';
import { homedir } from 'node:os';
import { FindingsStore, type Finding, type Severity } from '@gmft/core';
import type { Tool, ToolContext } from '@gmft/core';
import { readSelections } from './selections.js';

export const ReportWriteInput = z.object({
  baseDir: z.string().min(1).describe('Directory holding {sessionId}.jsonl + .selections.json (typically the sessions dir).'),
  sessionId: z.string().min(1).describe('The session id whose findings to read.'),
  format: z.enum(['markdown', 'html']).default('markdown'),
  severityFilter: z.enum(['info', 'low', 'medium', 'high', 'critical']).default('medium')
    .describe('Include findings at or above this severity.'),
  outputPath: z.string().optional()
    .describe('Override the default report path (must be inside the reports dir).'),
});
export type ReportWriteInputT = z.infer<typeof ReportWriteInput>;

export const ReportWriteOutput = z.object({
  path: z.string(),
  format: z.enum(['markdown', 'html']),
  findingCount: z.number().int().nonnegative(),
  bytesWritten: z.number().int().nonnegative(),
});
export type ReportWriteOutputT = z.infer<typeof ReportWriteOutput>;

/** Severity ordering — used for the "at or above" filter. */
const SEVERITY_ORDER: Record<Severity, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

/** The canonical reports dir under the user's data home. */
export function reportsDir(): string {
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), '.local', 'share');
  return join(base, 'gmft', 'reports');
}

/**
 * Default report path: `${reportsDir()}/${sessionId}.${ext}`.
 * Exported so tests (and the TUI's `/report` slash command) can
 * predict the path without running the tool.
 */
export function defaultReportPath(sessionId: string, format: 'markdown' | 'html'): string {
  const ext = format === 'markdown' ? 'md' : 'html';
  return join(reportsDir(), `${sessionId}.${ext}`);
}

/**
 * Resolve a user-supplied `outputPath` against the reports dir,
 * blocking any escape via `..` or symlinks. Throws on violation.
 */
export function resolveOutputPath(
  requested: string,
  sessionId: string,
  format: 'markdown' | 'html',
): string {
  const ext = format === 'markdown' ? 'md' : 'html';
  const reportsRoot = resolve(reportsDir());
  const candidate = resolve(requested);
  // Reject any literal `..` segments in the requested path before
  // resolving. `path.resolve` already normalizes them away, but a
  // raw '..' in the input is almost certainly a bug or attack and
  // worth a clearer error.
  if (/(^|\/|\\)\.\.(\/|\\|$)/.test(requested)) {
    throw new Error(
      `report_write: outputPath "${requested}" contains a ".." segment; must be inside ${reportsRoot}`,
    );
  }
  // Realpath check: if the file (or any parent) exists, follow the
  // symlink and verify the resolved path is still under the reports
  // dir. For non-existent paths, mkdir -p the parent and trust the
  // lexical check.
  let realCandidate = candidate;
  try {
    realCandidate = realpathSync(candidate);
  } catch {
    // path doesn't exist yet — that's fine, we mkdir below
  }
  if (!(realCandidate === reportsRoot || realCandidate.startsWith(reportsRoot + '/'))) {
    throw new Error(
      `report_write: outputPath "${requested}" resolves to "${realCandidate}" which is outside the reports dir (${reportsRoot})`,
    );
  }
  // Already exists? Insert a timestamp segment to avoid clobber.
  if (existsSync(candidate)) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const base = basename(candidate, extname(candidate));
    return join(dirname(candidate), `${base}.${ts}.${ext}`);
  }
  return candidate;
}

/**
 * Read the selection sidecar at `${baseDir}/${sessionId}.selections.json`.
 * Re-exported here for backwards compat with anything that imported
 * it from this module before the extraction to `./selections.ts`.
 * New callers should import directly from `./selections.ts`.
 */
export { readSelections };

function meetsSeverity(severity: Severity, min: Severity): boolean {
  return SEVERITY_ORDER[severity] >= SEVERITY_ORDER[min];
}

function renderMarkdown(title: string, findings: Finding[]): string {
  const lines: string[] = [];
  lines.push(`# ${title}`);
  lines.push('');
  lines.push(`_Generated: ${new Date().toISOString()}_`);
  lines.push(`_Findings: ${findings.length}_`);
  lines.push('');
  for (const f of findings) {
    lines.push(`## [${f.severity.toUpperCase()}] ${f.title}`);
    lines.push('');
    lines.push(`- **Tool:** \`${f.tool}\``);
    lines.push(`- **Target:** \`${f.target}\``);
    if (f.description) {
      lines.push('');
      lines.push(f.description);
    }
    if (f.evidence) {
      lines.push('');
      lines.push('### Evidence');
      lines.push('');
      lines.push('```');
      lines.push(f.evidence);
      lines.push('```');
    }
    lines.push('');
  }
  return lines.join('\n');
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function severityColor(severity: Severity): string {
  switch (severity) {
    case 'info': return '#3b82f6';     // blue
    case 'low': return '#10b981';      // green
    case 'medium': return '#f59e0b';   // amber
    case 'high': return '#ef4444';     // red
    case 'critical': return '#7c2d12'; // dark red
  }
}

function renderHtml(title: string, findings: Finding[]): string {
  const body = findings.map((f) => {
    const color = severityColor(f.severity);
    const evidence = f.evidence
      ? `<pre><code>${escapeHtml(f.evidence)}</code></pre>`
      : '';
    const description = f.description
      ? `<p>${escapeHtml(f.description)}</p>`
      : '';
    return `<section class="finding">
  <h2><span class="badge" style="background:${color}">${escapeHtml(f.severity.toUpperCase())}</span> ${escapeHtml(f.title)}</h2>
  <dl>
    <dt>Tool</dt><dd><code>${escapeHtml(f.tool)}</code></dd>
    <dt>Target</dt><dd><code>${escapeHtml(f.target)}</code></dd>
  </dl>
  ${description}
  ${evidence}
</section>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 900px; margin: 2em auto; padding: 0 1em; color: #1f2937; }
  h1 { border-bottom: 2px solid #e5e7eb; padding-bottom: 0.3em; }
  .meta { color: #6b7280; font-size: 0.9em; }
  section.finding { border-left: 4px solid #e5e7eb; padding: 1em; margin: 1.5em 0; background: #f9fafb; }
  .badge { display: inline-block; color: white; padding: 0.2em 0.6em; border-radius: 4px; font-size: 0.75em; font-weight: 700; margin-right: 0.5em; vertical-align: middle; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.3em 1em; margin: 0.5em 0; }
  dt { font-weight: 600; color: #6b7280; }
  pre { background: #1f2937; color: #f9fafb; padding: 1em; border-radius: 4px; overflow-x: auto; }
  code { font-family: ui-monospace, SFMono-Regular, monospace; font-size: 0.9em; }
</style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <p class="meta">Generated: ${escapeHtml(new Date().toISOString())} · Findings: ${findings.length}</p>
  ${body}
</body>
</html>
`;
}

export const reportWriteTool: Tool<typeof ReportWriteInput, typeof ReportWriteOutput> = {
  name: 'report_write',
  category: 'file',
  description:
    'Generate a penetration-test report from the current session findings. ' +
    'Reads {baseDir}/{sessionId}.jsonl + .selections.json, filters by severity ' +
    '(or selection), and writes markdown or HTML to the reports dir.',
  input: ReportWriteInput,
  output: ReportWriteOutput,
  flags: ['destructive'],
  async run(
    args: ReportWriteInputT,
    _ctx: ToolContext,
  ): Promise<ReportWriteOutputT> {
    const parsed = ReportWriteInput.parse(args);

    // 1. Resolve output path (default or override)
    const target = parsed.outputPath
      ? resolveOutputPath(parsed.outputPath, parsed.sessionId, parsed.format)
      : defaultReportPath(parsed.sessionId, parsed.format);

    // 2. Read findings via the canonical FindingsStore
    const store = new FindingsStore({ baseDir: parsed.baseDir, sessionId: parsed.sessionId });
    const all = store.list();

    // 3. Apply selection sidecar (if any) — restricts to checked ids
    const selections = readSelections(parsed.baseDir, parsed.sessionId);
    const afterSelections = selections && selections.checkedIds.length > 0
      ? all.filter((f) => selections.checkedIds.includes(f.id))
      : all;

    // 4. Apply severity filter
    const final = afterSelections.filter((f) => meetsSeverity(f.severity, parsed.severityFilter));

    // 5. Render
    const title = `GMFT session report — ${parsed.sessionId}`;
    const body = parsed.format === 'markdown'
      ? renderMarkdown(title, final)
      : renderHtml(title, final);

    // 6. Write
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body, { encoding: 'utf8', mode: 0o644 });
    const bytes = statSync(target).size;

    return {
      path: target,
      format: parsed.format,
      findingCount: final.length,
      bytesWritten: bytes,
    };
  },
};
