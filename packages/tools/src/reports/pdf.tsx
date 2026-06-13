/**
 * report_pdf — render findings to a single PDF document.
 *
 * Design split (per phase 6 plan):
 *   - `renderPdfBuffer(findings, meta)` is a PURE function: input +
 *     metadata in, `Buffer` out. No filesystem, no globals. This is
 *     what gets unit-tested.
 *   - `reportPdfTool` is the thin `@gmft/core` `Tool` wrapper: it
 *     loads findings via `FindingsStore`, applies the selection
 *     sidecar + severity filter, and writes the buffer to the
 *     reports dir. The wrapper reuses the path-resolution helpers
 *     from `write.ts` so all report formats land under
 *     `~/.local/share/gmft/reports/`.
 *
 * Implementation: `@react-pdf/renderer` runs in plain Node — no
 * headless browser, no puppeteer. We build a `Document` with one
 * `Page` per finding plus a cover page, then render to a buffer
 * via `renderToBuffer`. The output is a real `%PDF-` document.
 *
 * Output path policy matches `report_write`:
 *   - default = `${dataDir()}/gmft/reports/${sessionId}.pdf`
 *   - user override must resolve inside the reports dir; `..` is
 *     rejected up front. If the file exists, a timestamp segment is
 *     inserted to avoid clobber.
 *
 * Flags: `destructive` (writes a file outside cwd). Not
 * `requiresElevation` (path is always under `~/.local/share`).
 */
import { z } from 'zod';
import { writeFileSync, mkdirSync, existsSync, realpathSync, statSync } from 'node:fs';
import { dirname, resolve, basename, extname, join } from 'node:path';
import {
  Document,
  Page,
  Text,
  View,
  StyleSheet,
  renderToBuffer,
  type DocumentProps,
} from '@react-pdf/renderer';
import React from 'react';
import { FindingsStore, type Finding, type Severity } from '@gmft/core';
import type { Tool, ToolContext } from '@gmft/core';
import {
  readSelections,
  defaultReportPath,
  resolveOutputPath,
  type ReportFormat,
  reportsDir,
} from './write.js';

/**
 * Minimal interface over `@react-pdf/renderer` so tests can pass a
 * stub. We don't expose the real renderer's full type surface — only
 * the one method we actually call.
 */
export interface PdfRenderer {
  renderToBuffer: (element: React.ReactElement<DocumentProps>) => Promise<Buffer>;
}

export const ReportPdfInput = z.object({
  baseDir: z.string().min(1).describe('Directory holding {sessionId}.jsonl + .selections.json (typically the sessions dir).'),
  sessionId: z.string().min(1).describe('The session id whose findings to read.'),
  severityFilter: z.enum(['info', 'low', 'medium', 'high', 'critical']).default('medium')
    .describe('Include findings at or above this severity.'),
  outputPath: z.string().optional()
    .describe('Override the default report path (must be inside the reports dir).'),
  includeEvidence: z.boolean().default(true)
    .describe('Include the heavy `evidence` block per finding. Defaults to true.'),
  title: z.string().optional()
    .describe('Cover-page title; defaults to "GMFT session report — {sessionId}".'),
});
export type ReportPdfInputT = z.infer<typeof ReportPdfInput>;

export const ReportPdfOutput = z.object({
  path: z.string(),
  format: z.literal('pdf'),
  findingCount: z.number().int().nonnegative(),
  bytesWritten: z.number().int().nonnegative(),
});
export type ReportPdfOutputT = z.infer<typeof ReportPdfOutput>;

export interface PdfReportMeta {
  sessionId: string;
  generatedAt: string;        // ISO 8601
  title: string;              // cover-page title
  operator?: string;          // optional: surfaced in the cover footer
}

/** Severity ordering — must match `write.ts` (and the chokepoint). */
const SEVERITY_ORDER: Record<Severity, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

function meetsSeverity(severity: Severity, min: Severity): boolean {
  return SEVERITY_ORDER[severity] >= SEVERITY_ORDER[min];
}

const SEVERITY_COLORS: Record<Severity, string> = {
  info: '#3b82f6',     // blue
  low: '#10b981',      // green
  medium: '#f59e0b',   // amber
  high: '#ef4444',     // red
  critical: '#7c2d12', // dark red
};

// react-pdf uses an in-house StyleSheet helper. Plain objects work too,
// but the helper deduplicates + gives us a typed bag.
const styles = StyleSheet.create({
  coverPage: { padding: 48, fontFamily: 'Helvetica' },
  coverTitle: { fontSize: 26, fontFamily: 'Helvetica-Bold', marginBottom: 16 },
  coverMeta: { fontSize: 11, color: '#6b7280', marginBottom: 4 },
  coverCount: { fontSize: 14, fontFamily: 'Helvetica-Bold', marginTop: 24, marginBottom: 8 },
  severityRow: { flexDirection: 'row', marginRight: 12 },
  severityBadge: { fontSize: 10, color: 'white', padding: 4, borderRadius: 3, fontFamily: 'Helvetica-Bold' },
  page: { padding: 36, fontFamily: 'Helvetica', fontSize: 11, lineHeight: 1.4 },
  findingHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  findingTitle: { fontSize: 14, fontFamily: 'Helvetica-Bold', flex: 1 },
  findingSection: { marginBottom: 4 },
  findingLabel: { fontFamily: 'Helvetica-Bold', color: '#374151' },
  findingBody: { marginBottom: 8 },
  description: { marginBottom: 8 },
  evidenceBlock: {
    backgroundColor: '#1f2937',
    color: '#f9fafb',
    padding: 8,
    borderRadius: 3,
    fontFamily: 'Courier',
    fontSize: 9,
    lineHeight: 1.3,
  },
  hr: { borderBottomColor: '#e5e7eb', borderBottomWidth: 1, marginVertical: 12 },
  footer: { position: 'absolute', bottom: 24, left: 36, right: 36, fontSize: 9, color: '#9ca3af', textAlign: 'center' },
});

// Pull the `render` callback out of JSX-land so TypeScript's
// `react-jsx` parser doesn't trip on the inline function expression
// inside an attribute value (it expects either a string, a number,
// or a `{` brace expression, not a bare arrow).
const renderPageNumber = (props: {
  pageNumber: number;
  totalPages: number;
  subPageNumber: number;
  subPageTotalPages: number;
}): React.ReactNode => `${props.pageNumber} / ${props.totalPages}`;

function CoverPage({ meta, findings }: { meta: PdfReportMeta; findings: Finding[] }): React.JSX.Element {
  const severities: Record<Severity, number> = { info: 0, low: 0, medium: 0, high: 0, critical: 0 };
  for (const f of findings) severities[f.severity]++;
  return (
    <Page size="A4" style={styles.coverPage}>
      <Text style={styles.coverTitle}>{meta.title}</Text>
      <Text style={styles.coverMeta}>Session: {meta.sessionId}</Text>
      <Text style={styles.coverMeta}>Generated: {meta.generatedAt}</Text>
      {meta.operator && <Text style={styles.coverMeta}>Operator: {meta.operator}</Text>}
      <Text style={styles.coverCount}>Findings: {findings.length}</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
        {(['critical', 'high', 'medium', 'low', 'info'] as Severity[]).map((s) => (
          <View key={s} style={styles.severityRow}>
            <Text style={[styles.severityBadge, { backgroundColor: SEVERITY_COLORS[s] }]}>
              {s.toUpperCase()} {severities[s]}
            </Text>
          </View>
        ))}
      </View>
    </Page>
  );
}

function FindingPage({ finding, index }: { finding: Finding; index: number }): React.JSX.Element {
  const wrapTargets: Array<[string, string]> = [
    ['Tool', finding.tool],
    ['Target', finding.target],
    ['Severity', finding.severity.toUpperCase()],
    ['Detected', new Date(finding.ts).toISOString()],
  ];
  return (
    <Page size="A4" style={styles.page} wrap>
      <View style={styles.findingHeader}>
        <Text style={styles.findingTitle}>
          {String(index + 1).padStart(2, '0')}. {finding.title}
        </Text>
      </View>
      <View style={styles.findingSection}>
        {wrapTargets.map(([label, value]) => (
          <Text key={label} style={styles.findingBody}>
            <Text style={styles.findingLabel}>{label}: </Text>
            <Text>{value}</Text>
          </Text>
        ))}
      </View>
      {finding.description && (
        <Text style={styles.description}>{finding.description}</Text>
      )}
      {finding.evidence && (
        <View wrap={false}>
          <Text style={[styles.findingLabel, { marginBottom: 4 }]}>Evidence</Text>
          <Text style={styles.evidenceBlock}>{finding.evidence}</Text>
        </View>
      )}
      <Text style={styles.footer} render={renderPageNumber} fixed />
    </Page>
  );
}

function buildDocument(meta: PdfReportMeta, findings: Finding[]): React.JSX.Element {
  return (
    <Document
      title={meta.title}
      author={meta.operator ?? 'gmft'}
      subject="Penetration test report"
      creator="gmft report_pdf"
    >
      <CoverPage meta={meta} findings={findings} />
      {findings.length === 0 ? (
        <Page size="A4" style={styles.page}>
          <Text>No findings matched the report filters.</Text>
          <Text style={styles.footer} render={renderPageNumber} fixed />
        </Page>
      ) : (
        findings.map((f, i) => <FindingPage key={f.id} finding={f} index={i} />)
      )}
    </Document>
  );
}

/**
 * Pure render: `(findings, meta) → Buffer`. This is the function the
 * unit tests pin — no filesystem, no `process.cwd`, no env reads.
 *
 * `renderer` is injected (defaults to `@react-pdf/renderer`) so the
 * test can pass a stub without monkey-patching the module. Default
 * is the real renderer.
 */
export async function renderPdfBuffer(
  findings: Finding[],
  meta: PdfReportMeta,
  renderer: PdfRenderer = { renderToBuffer: (el) => renderToBuffer(el) },
): Promise<Buffer> {
  const doc = buildDocument(meta, findings);
  return renderer.renderToBuffer(doc);
}

/**
 * Resolve the output path for a PDF report. Mirrors the policy from
 * `write.ts` (`markdown` / `html` / `json`) so the helper there can
 * be reused — we re-implement the small amount of logic locally
 * rather than import a single format-keyed helper, to keep
 * `write.ts` and `pdf.ts` decoupled (changing one shouldn't force
 * the other to rebuild).
 */
function pdfReportsDir(): string {
  // reportsDir() in write.ts already uses XDG_DATA_HOME; reuse the
  // same root so all formats land in one place.
  return reportsDir();
}

/**
 * Default PDF report path: `${reportsDir()}/${sessionId}.pdf`.
 * Exported so the CLI's `--report pdf` flag (and tests) can predict
 * the path without running the tool.
 */
export function defaultPdfPath(sessionId: string): string {
  return join(pdfReportsDir(), `${sessionId}.pdf`);
}

export function resolvePdfOutputPath(
  requested: string,
  sessionId: string,
): string {
  const reportsRoot = resolve(pdfReportsDir());
  const candidate = resolve(requested);
  if (/(^|\/|\\)\.\.(\/|\\|$)/.test(requested)) {
    throw new Error(
      `report_pdf: outputPath "${requested}" contains a ".." segment; must be inside ${reportsRoot}`,
    );
  }
  let realCandidate = candidate;
  try {
    realCandidate = realpathSync(candidate);
  } catch {
    // not on disk yet
  }
  if (!(realCandidate === reportsRoot || realCandidate.startsWith(reportsRoot + '/'))) {
    throw new Error(
      `report_pdf: outputPath "${requested}" resolves to "${realCandidate}" which is outside the reports dir (${reportsRoot})`,
    );
  }
  if (existsSync(candidate)) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const base = basename(candidate, extname(candidate));
    return join(dirname(candidate), `${base}.${ts}.pdf`);
  }
  return candidate;
}

export const reportPdfTool: Tool<typeof ReportPdfInput, typeof ReportPdfOutput> = {
  name: 'report_pdf',
  category: 'file',
  description:
    'Render the current session findings to a self-contained PDF report ' +
    '(`%PDF-` format, single file). Reads {baseDir}/{sessionId}.jsonl + ' +
    '.selections.json, filters by severity (or selection), and writes ' +
    '`{sessionId}.pdf` to the reports dir. No headless browser — uses ' +
    '`@react-pdf/renderer` (pure-Node).',
  input: ReportPdfInput,
  output: ReportPdfOutput,
  flags: ['destructive'],
  async run(
    args: ReportPdfInputT,
    _ctx: ToolContext,
  ): Promise<ReportPdfOutputT> {
    const parsed = ReportPdfInput.parse(args);

    // 1. Output path
    const target = parsed.outputPath
      ? resolvePdfOutputPath(parsed.outputPath, parsed.sessionId)
      : defaultPdfPath(parsed.sessionId);

    // 2. Read findings via FindingsStore
    const store = new FindingsStore({ baseDir: parsed.baseDir, sessionId: parsed.sessionId });
    const all = store.list();

    // 3. Selection sidecar (if any) — restricts to checked ids
    const selections = readSelections(parsed.baseDir, parsed.sessionId);
    const afterSelections = selections && selections.checkedIds.length > 0
      ? all.filter((f) => selections.checkedIds.includes(f.id))
      : all;

    // 4. Severity filter
    const final = afterSelections.filter((f) => meetsSeverity(f.severity, parsed.severityFilter));

    // 5. Evidence inclusion (drops heavy blocks for slim reports)
    const projected = parsed.includeEvidence
      ? final
      : final.map(({ evidence: _evidence, ...rest }) => rest);

    // 6. Build the PDF
    const meta: PdfReportMeta = {
      sessionId: parsed.sessionId,
      generatedAt: new Date().toISOString(),
      title: parsed.title ?? `GMFT session report — ${parsed.sessionId}`,
    };
    const buffer = await renderPdfBuffer(projected, meta);

    // 7. Write
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, buffer, { mode: 0o644 });
    const bytes = statSync(target).size;

    return {
      path: target,
      format: 'pdf' as const,
      findingCount: final.length,
      bytesWritten: bytes,
    };
  },
};

// Re-export `reportsDir` and the path helpers from `write.ts` as a
// type-only convenience for any future caller that wants a single
// import. The runtime exports below are intentional: callers that
// already import `defaultReportPath` from `write.ts` keep working,
// and this module's own logic stays self-contained.
export type { ReportFormat };
export { defaultReportPath, resolveOutputPath };
