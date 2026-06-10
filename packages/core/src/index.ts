/**
 * @gmft/core — agent runtime, chokepoint, tools, memory, session.
 *
 * Phase 1 ships only the surface: types, config loader, and a stub `runTurn`
 * that returns nothing. Real implementations land in phases 2+.
 */

export const VERSION = '0.1.0-phase1';

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
