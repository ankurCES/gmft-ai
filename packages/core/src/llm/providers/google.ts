import { fetch } from 'undici';
import type { ProviderModule, ValidationResult } from './types.js';

const GOOGLE_API = 'https://generativelanguage.googleapis.com';
const VALIDATE_TIMEOUT_MS = 5_000;

async function probe(url: string): Promise<ValidationResult> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), VALIDATE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ac.signal });
    if (res.status === 401 || res.status === 403) return { ok: false, reason: 'invalid_key' };
    if (!res.ok) return { ok: false, reason: 'network' };
    return { ok: true };
  } catch {
    return { ok: false, reason: 'network' };
  } finally {
    clearTimeout(timer);
  }
}

export const google: ProviderModule = {
  id: 'google',
  displayName: 'Google AI Studio',
  authFields: [{ id: 'apiKey', label: 'API key', placeholder: 'AIza...' }],
  defaultEndpoint: GOOGLE_API,
  modelCatalog: [
    { id: 'gemini-2.0-flash', displayName: 'Gemini 2.0 Flash', isDefault: true },
    { id: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro' },
    { id: 'gemini-1.5-flash', displayName: 'Gemini 1.5 Flash' },
  ],
  async validate(key, endpoint) {
    const base = (endpoint ?? GOOGLE_API).replace(/\/+$/, '');
    return probe(`${base}/v1beta/models?key=${encodeURIComponent(key)}`);
  },
};
