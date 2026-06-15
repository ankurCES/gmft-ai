/**
 * @gmft/tools — concrete tool implementations + sandbox runner.
 *
 * Phase 3 ships one tool: shell_exec. The runner is docker-first with
 * a host-fallback that warns loudly (per ADR 0003).
 */
export * from './shared/prereq.js';
export * from './shared/runner.js';
// v0.2.D — expose the live capability snapshot. The runner imports
// from here too, but downstream consumers (TUI, audit log) need the
// same single source of truth for kernel-layer availability.
export * from './shared/capabilities.js';
export * from './shared/stream.js';
export * from './shell/shell-exec.js';
export * from './network/index.js';
// v0.3.B — surface the web + wifi tool barrels so the v0.3.B tools
// (nuclei, nikto, gobuster, ffuf, sqlmap, httpx, wpscan, snmpcheck,
// evil-twin, deauth, wifite-scan, bettercap, aircrack, kismet) can
// be imported by name. The catalog array already includes them;
// these re-exports make them available to AgentApp's `/run` wiring
// and to any future consumer that wants the typed tool constant
// rather than the catalog projection.
export * from './web/index.js';
export * from './wifi/index.js';
export * from './reports/selections.js';
export {
  defaultReportPath,
  reportsDir,
  resolveOutputPath,
  buildJsonReport,
  type ReportFormat,
} from './reports/write.js';
export {
  renderPdfBuffer,
  resolvePdfOutputPath,
  defaultPdfPath,
  type PdfReportMeta,
  type PdfRenderer,
} from './reports/pdf.js';
export { FindingsStore, type FindingsStoreOpts, type Finding, type Severity, FindingSchema, SeveritySchema } from '@gmft/core';
export { tools, shellExecTool, nmapTool, dnsenumTool, theHarvesterTool, whatwebTool, reportWriteTool, reportPdfTool } from './catalog.js';
