/**
 * @gmft/core — agent runtime, chokepoint, tools, memory, session.
 *
 * Phase 1 ships only the surface: types, config loader, and a stub `runTurn`
 * that returns nothing. Real implementations land in phases 2+.
 */

export type ProviderId = 'anthropic' | 'openai' | 'google' | 'openrouter' | 'ollama';

export interface LlmConfig {
  provider: ProviderId;
  model: string;
  /** Resolved at runtime; never log this. */
  apiKey?: string;
  /** Resolved at runtime; never log this. */
  endpoint?: string;
}

export interface SandboxConfig {
  mode: 'docker' | 'host';
  defaultImage?: string;
}

export interface ChokepointConfig {
  allowPrivateNetworks: boolean;
  denylist: string[];
}

export interface UiConfig {
  theme: 'auto' | 'dark' | 'light' | 'high-contrast';
}

export interface GmftConfig {
  llm: LlmConfig;
  sandbox: SandboxConfig;
  chokepoint: ChokepointConfig;
  ui: UiConfig;
}

export const VERSION = '0.1.0-phase1';

export function version(): string {
  return VERSION;
}
