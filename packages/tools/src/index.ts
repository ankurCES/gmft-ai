/**
 * @gmft/tools — concrete tool implementations + sandbox runner.
 *
 * Phase 3 ships one tool: shell_exec. The runner is docker-first with
 * a host-fallback that warns loudly (per ADR 0003).
 */
export * from './shared/prereq';
export * from './shared/runner';
export * from './shell/shell-exec';
export { tools, shellExecTool } from './catalog';
