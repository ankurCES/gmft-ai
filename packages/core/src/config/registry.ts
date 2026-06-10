import type { GmftConfig } from './config.js';

export interface OnboardRuntime {
  getSecret(key: string): Promise<string | null>;
  setSecret(key: string, value: string): Promise<void>;
  validateProvider(
    providerId: string,
    key: string,
    endpoint?: string,
  ): Promise<{ ok: true } | { ok: false; reason: 'invalid_key' | 'network' | 'unknown' }>;
  providers: readonly import('../llm/providers/types.js').ProviderModule[];
}

export interface ConfigField {
  /** Stable id. e.g. 'llm-provider', 'tools.allowlist', 'sandbox.docker'. */
  id: string;
  /** Human label shown in the onboarding header. */
  label: string;
  /** Order hint, lower = earlier. Stable across versions. */
  order: number;
  /**
   * Whether the field is already satisfied given the current config.
   * Skipped by runOnboarding when true. Allows `--provider` to skip
   * onboarding for that field.
   */
  isConfigured(cfg: GmftConfig): boolean;
  /**
   * Walk the user through this field. Return a partial config to merge,
   * or `null` if the user aborted. Receives a runtime for secret I/O,
   * validation, and provider lookup.
   */
  prompt(runtime: OnboardRuntime): Promise<Partial<GmftConfig> | null>;
}

const fields: ConfigField[] = [];

export function registerConfigField(field: ConfigField): void {
  if (fields.some((f) => f.id === field.id)) {
    throw new Error(`ConfigField id already registered: ${field.id}`);
  }
  fields.push(field);
}

export function getConfigFields(): readonly ConfigField[] {
  return [...fields].sort((a, b) => a.order - b.order);
}

/** Test-only. Resets the registry between tests. */
export function _clearConfigFields(): void {
  fields.length = 0;
}
