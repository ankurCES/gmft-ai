import { fetch } from 'undici';
import type { ProviderModule, ValidationResult } from './types.js';

const OPENAI_API = 'https://api.openai.com';
const VALIDATE_TIMEOUT_MS = 5_000;

async function probe(url: string, init: RequestInit): Promise<ValidationResult> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), VALIDATE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: ac.signal });
    if (res.status === 401 || res.status === 403) return { ok: false, reason: 'invalid_key' };
    if (!res.ok) return { ok: false, reason: 'network' };
    return { ok: true };
  } catch {
    return { ok: false, reason: 'network' };
  } finally {
    clearTimeout(timer);
  }
}

export const openai: ProviderModule = {
  id: 'openai',
  displayName: 'OpenAI',
  authFields: [{ id: 'apiKey', label: 'API key', placeholder: 'sk-...' }],
  defaultEndpoint: OPENAI_API,
  modelCatalog: [
    { id: 'gpt-4o', displayName: 'GPT-4o', isDefault: true },
    { id: 'gpt-4o-mini', displayName: 'GPT-4o mini' },
    { id: 'o3-mini', displayName: 'o3-mini' },
  ],
  async validate(key, endpoint) {
    return probe(`${(endpoint ?? OPENAI_API).replace(/\/+$/, '')}/v1/models`, {
      headers: { authorization: `Bearer ${key}` },
    });
  },
};
