/**
 * Provider-aware model catalog.
 *
 * The LLM factory takes `(provider, model, apiKey, endpoint)` and
 * returns a `LanguageModel`. The `model` field is free-form — the
 * user picks it during onboarding (1.5b) and can change it at runtime
 * via `/model` (1.5e).
 *
 * `/provider` is a different beast: switching providers typically
 * means picking a model that exists for the new provider. The naive
 * "clear the model" reply is honest but bad UX — the user gets a
 * `(empty response)` or a 404 on the next turn. This module exposes
 * a single function that returns a sensible default for each known
 * provider, so the CLI can wire `/provider <id>` to a real model
 * instead of an empty string.
 *
 * The catalog is intentionally tiny: one model per provider, the
 * "fast/cheap" tier. Users who want a different model can `/model
 * <id>` right after `/provider <id>`. v0.1 has no dynamic discovery
 * (no `/models` listing); that lands in a later phase.
 */

import type { LlmConfig } from '../config/config.js';

/**
 * Default model for each provider. The values are stable as of
 * 2026-06 and pinned in unit tests — bump intentionally, not by
 * accident.
 */
const DEFAULTS: Record<LlmConfig['provider'], string> = {
  anthropic: 'claude-3-5-haiku-latest',
  openai: 'gpt-4o-mini',
  google: 'gemini-1.5-flash',
  openrouter: 'openai/gpt-4o-mini',
  ollama: 'llama3.2',
};

/**
 * Return a sensible default model id for `provider`. Used by the CLI
 * to fill in `config.llm.model` when the user runs `/provider <id>`
 * without a subsequent `/model <id>`. Falls back to `''` for an
 * unknown provider, mirroring the factory's behavior on an empty
 * model string.
 */
export function getDefaultModel(provider: string): string {
  return (DEFAULTS as Record<string, string>)[provider] ?? '';
}
