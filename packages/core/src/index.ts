/**
 * @gmft/core — agent runtime, chokepoint, tools, memory, session.
 *
 * Phase 1.5f ships live model + provider switching:
 * lookupApiKey / bindGetApiKey (SecretStore-backed key resolution),
 * getDefaultModel (provider -> model catalog), and the new
 * AgentApp wiring that rebuilds the LanguageModel on /model and
 * /provider. The LLM streaming surface from 1.5d is unchanged.
 * Tools + chokepoint land in phase 3.
 */

export const VERSION = '0.1.0-phase1.5f';

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
