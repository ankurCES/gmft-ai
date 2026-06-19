/**
 * @gmft/core — agent runtime, chokepoint, tools, memory, session.
 *
 * Phase 3 ships the chokepoint (the safety spine) and the tool
 * registry/executor (the dispatch path). Every tool call now flows
 * through `chokepoint.decide(...)` before the runner is invoked.
 * The agent loop's `AgentEvent` union is extended (additively) with
 * `tool-call-request` / `tool-result` / `confirmation-needed` for
 * observability and the TUI's `<ApprovalPrompt>` flow. The LLM
 * streaming surface and the provider/config surface are unchanged.
 */

export const VERSION = '0.1.0-phase4';

export function version(): string {
  return VERSION;
}

export {
  registerConfigField,
  getConfigFields,
  _clearConfigFields,
  type ConfigField,
  type OnboardRuntime,
} from './config/registry.js';

export {
  defaultConfig,
  loadConfig,
  saveConfig,
  configPath,
  configDir,
  type GmftConfig,
  type LlmConfig,
  type SandboxConfig,
  type ChokepointConfig,
  type UiConfig,
  type SecretsMeta,
} from './config/config.js';

export {
  createSecretStore,
  envPath,
  secretsEnvDir,
  type SecretStore,
  type SecretBackend,
  type CreateOpts,
} from './config/secrets.js';

export {
  PROVIDERS,
  getProvider,
} from './llm/providers/index.js';

export type {
  ProviderModule,
  ProviderUI,
  AuthField,
  ModelInfo,
  ValidationResult,
} from './llm/providers/types.js';

export { createLlmProviderField } from './llm/llm-provider-field.js';
export { runOnboarding, type RunOnboardingOpts } from './llm/onboard.js';
export { appendTurn, readLog, redactSecrets, type Turn } from './session/log.js';
export {
  redactAdSecrets,
  auditLogRedactedFields,
  type AdRedactedField,
  type AdRedactionResult,
  type RedactedToolOutput,
} from './transcript/redact-ad.js';
export {
  sessionDir,
  sessionPath,
  currentSessionPath,
  currentSessionIdPath,
} from './session/paths.js';

export { createModel, type CreateModelOpts } from './llm/model-factory.js';
export { buildSystemPrompt, type PromptEnv, type PromptScope, type SandboxMode } from './llm/prompts.js';
export { lookupApiKey, bindGetApiKey, type GetApiKey } from './llm/api-key.js';
export { getDefaultModel } from './llm/model-catalog.js';

export { runTurn, type AgentEvent, type RunTurnOpts } from './agent/loop.js';
export { tokenEstimate, totalTokens, type ChatMessage, type ChatRole } from './agent/context.js';
export { summarizeIfNeeded, type SummarizeOpts, type SummarizeResult } from './agent/summarizer.js';
// v0.2.A.2 — the supervisor wrapper. Consumers wire this around `runTurn`
// in their app layer (e.g. AgentApp) to observe fires + inject advice.
export { withSupervisor } from './agent/supervisor.js';
export type { WithSupervisorOpts, SupervisorWrapper, HistoryRef } from './agent/supervisor.js';
export type { SupervisorFire, SupervisorFireRecord, SupervisorFireEvent, SupervisorPostmortemEvent, SupervisorTurnRecord } from './agent/supervisor-types.js';

export {
  createChokepoint,
  readChokepointEnv,
  type Decision,
  type Chokepoint,
  type ChokepointCall,
  type ChokepointEnv,
} from './chokepoint/index.js';

export { FindingSchema, SeveritySchema, type Finding, type Severity } from './findings/index.js';
export { FindingsStore, type FindingsStoreOpts } from './findings/store.js';

export {
  ToolRegistry,
  TOOL_CATEGORIES,
  type Tool,
  type ToolCategory,
  type ToolContext,
} from './tools/index.js';

export {
  execute,
  runInner,
  type ExecuteCall,
  type ExecuteResult,
  type ExecuteOpts,
  type RunInnerOpts,
} from './tools/executor.js';
export { type InnerRunner, type InnerRunnerResult } from './tools/types.js';

// v0.3.C — audit observability (hash-chained JSONL + CLI).
// The `audit/` module is self-contained: types + canonical form,
// HMAC key management, the append-only writer, the path math,
// the sink interface (with opt-out env var), and the chokepoint
// decorator. The CLI primitives (`verifyAuditLog`, `readAuditLog`,
// `tailAuditLog`) live in `apps/gmft/src/cli-audit.ts` because
// they pull in `node:fs` reads that the core library should not
// expose — `apps/gmft` is the right layer for the binary.
export {
  GENESIS_PREV_HASH,
  canonicalForm,
  computeHash,
  type AuditEvent,
  type AuditEventKind,
} from './audit/types.js';
export {
  getOrCreateHmacKey,
  auditKeyMode,
  backupHmacKey,
  restoreHmacKey,
  ensureHmacKey,
  HMAC_KEY_FILENAME,
  SECRET_KEY_NAME,
} from './audit/key.js';
export {
  auditDir,
  auditLogPath,
  auditKeyPath,
  AUDIT_DIRNAME,
  AUDIT_LOG_FILENAME,
  AUDIT_KEY_FILENAME,
} from './audit/paths.js';
export { AuditWriter } from './audit/writer.js';
export { NOOP_SINK, makeAuditSink, type AuditSink } from './audit/sink.js';
export {
  withAuditChokepoint,
  withAuditSupervisor,
  withAuditToolResult,
  MAX_TOOL_RESULT_OUTPUT_CHARS,
} from './audit/instrument.js';
export { readAuditChainHead, type AuditChainHead } from './audit/head.js';
