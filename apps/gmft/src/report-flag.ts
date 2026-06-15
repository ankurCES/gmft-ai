/**
 * v0.3.B — `--report` / `--report-format` CLI flag support.
 *
 * The CLI mounts the TUI, lets the user run a session, and on
 * `waitUntilExit()` drains the current session's findings via
 * `FindingsStore` to either a JSON or PDF report. The path is
 * resolved through the same reports-dir policy as the in-session
 * `report_write` / `report_pdf` tools (rejects ".." segments and any
 * escape from the reports root).
 *
 * Extracted from `cli.tsx` so the post-exit logic is testable
 * without booting the Ink runtime.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve as resolvePath } from 'node:path';
import {
  FindingsStore,
  type Finding,
} from '@gmft/core';
import {
  buildJsonReport,
  resolveOutputPath as resolveWriteOutputPath,
  renderPdfBuffer,
  resolvePdfOutputPath,
  reportsDir,
  type ReportFormat as WriteReportFormat,
  type PdfReportMeta,
} from '@gmft/tools';

/** Format the `--report` flag accepts. Mirrors what `report_write` + `report_pdf` produce. */
export type CliReportFormat = 'json' | 'pdf';

/**
 * Validate the `--report-format` flag value. Returns the parsed
 * format. Throws on anything else; the CLI converts the throw into
 * exit code 2 and a clear stderr message.
 */
export function parseReportFormat(
  raw: string | undefined,
): CliReportFormat {
  if (raw === undefined || raw === 'json') return 'json';
  if (raw === 'pdf') return 'pdf';
  throw new Error(
    `Invalid --report-format: "${raw}". Must be 'json' or 'pdf'.`,
  );
}

export interface PostExitReportOpts {
  /** The session id whose findings to read. */
  sessionId: string;
  /** The sessions base dir (FindingsStore baseDir). */
  baseDir: string;
  /** User-supplied output path; resolved against the reports dir. */
  outputPath: string;
  /** Output format. */
  format: CliReportFormat;
}

export interface PostExitReportResult {
  /** The absolute path the report was written to. */
  path: string;
  /** Echoed for the CLI's stdout line. */
  format: CliReportFormat;
  /** Number of findings included. */
  findingCount: number;
}

/**
 * Drain the current session's findings and write a JSON or PDF
 * report to the user-supplied path (resolved inside the reports
 * dir). Returns the resolved path so the CLI can echo it.
 *
 * Throws on any IO, path-resolution, or rendering failure; the CLI
 * catches and exits non-zero.
 */
export async function writePostExitReport(
  opts: PostExitReportOpts,
): Promise<PostExitReportResult> {
  const store = new FindingsStore({
    baseDir: opts.baseDir,
    sessionId: opts.sessionId,
  });
  const findings = store.list();

  if (opts.format === 'json') {
    const requested = anchorToReportsDir(opts.outputPath);
    const target = resolveWriteOutputPath(
      requested,
      opts.sessionId,
      'json' as WriteReportFormat,
    );
    const body = buildJsonReport(opts.sessionId, findings, true);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body, { encoding: 'utf8', mode: 0o644 });
    return { path: target, format: 'json', findingCount: findings.length };
  }

  // pdf
  const requested = anchorToReportsDir(opts.outputPath);
  const target = resolvePdfOutputPath(requested, opts.sessionId);
  const meta: PdfReportMeta = {
    sessionId: opts.sessionId,
    generatedAt: new Date().toISOString(),
    title: `GMFT session report — ${opts.sessionId}`,
  };
  const buffer = await renderPdfBuffer(findings, meta);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, buffer, { mode: 0o644 });
  return { path: target, format: 'pdf', findingCount: findings.length };
}

/**
 * Resolve a user-supplied `--report` path against the reports dir.
 *
 * - Absolute paths are passed through unchanged.
 * - Relative paths are anchored to `reportsDir()` so `gmft --report
 *   scan.json` lands at `${reportsDir}/scan.json` rather than
 *   `${cwd}/scan.json`. The in-tool path resolvers (resolveOutputPath,
 *   resolvePdfOutputPath) still enforce the escape-policy check, so a
 *   user who passes `../../etc/passwd` gets the same clear rejection
 *   they'd get from the in-session tools.
 */
function anchorToReportsDir(p: string): string {
  if (isAbsolute(p)) return p;
  return resolvePath(reportsDir(), p);
}
