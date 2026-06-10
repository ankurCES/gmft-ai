import { anthropic } from './anthropic.js';
import { openai } from './openai.js';
import { google } from './google.js';
import { openrouter } from './openrouter.js';
import { ollama } from './ollama.js';
import type { ProviderModule } from './types.js';

/**
 * The full list of providers, in stable order. Order is the order shown
 * in the onboard picker. Frozen so callers can't mutate it.
 */
export const PROVIDERS: readonly ProviderModule[] = Object.freeze([
  anthropic,
  openai,
  google,
  openrouter,
  ollama,
]);

export function getProvider(id: string): ProviderModule | undefined {
  return PROVIDERS.find((p) => p.id === id);
}
