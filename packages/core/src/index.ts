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
  type ExecuteCall,
  type ExecuteResult,
  type ExecuteOpts,
} from './tools/executor.js';
