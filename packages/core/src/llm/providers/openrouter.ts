import { fetch } from 'undici';
import type { ProviderModule, ValidationResult } from './types.js';

const OPENROUTER_API = 'https://openrouter.ai';
const VALIDATE_TIMEOUT_MS = 5_000;

async function probe(url: string, key: string): Promise<ValidationResult> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), VALIDATE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      headers: { authorization: `Bearer ${key}` },
    });
    if (res.status === 401 || res.status === 403) return { ok: false, reason: 'invalid_key' };
    if (!res.ok) return { ok: false, reason: 'network' };
    return { ok: true };
  } catch {
    return { ok: false, reason: 'network' };
  } finally {
    clearTimeout(timer);
  }
}

export const openrouter: ProviderModule = {
  id: 'openrouter',
  displayName: 'OpenRouter',
  authFields: [{ id: 'apiKey', label: 'API key', placeholder: 'sk-or-...' }],
  defaultEndpoint: OPENROUTER_API,
  modelCatalog: [
    // OpenRouter's catalog is huge; onboard only lists a curated few.
    { id: 'anthropic/claude-3.5-sonnet', displayName: 'Claude 3.5 Sonnet', isDefault: true },
    { id: 'openai/gpt-4o', displayName: 'GPT-4o' },
    { id: 'google/gemini-2.0-flash', displayName: 'Gemini 2.0 Flash' },
  ],
  async validate(key, endpoint) {
    return probe(
      `${(endpoint ?? OPENROUTER_API).replace(/\/+$/, '')}/api/v1/auth/key`,
      key,
    );
  },
};
