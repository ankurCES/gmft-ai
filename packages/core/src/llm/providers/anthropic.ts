import { fetch } from 'undici';
import type { ProviderModule, ValidationResult } from './types.js';

const ANTHROPIC_API = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';
const VALIDATE_TIMEOUT_MS = 5_000;

export const anthropic: ProviderModule = {
  id: 'anthropic',
  displayName: 'Anthropic',
  authFields: [
    {
      id: 'apiKey',
      label: 'API key',
      placeholder: 'sk-ant-...',
    },
  ],
  defaultEndpoint: ANTHROPIC_API,
  modelCatalog: [
    {
      id: 'claude-3-5-sonnet-latest',
      displayName: 'Claude 3.5 Sonnet (latest)',
      isDefault: true,
    },
    { id: 'claude-3-5-haiku-latest', displayName: 'Claude 3.5 Haiku (latest)' },
    { id: 'claude-3-opus-latest', displayName: 'Claude 3 Opus (latest)' },
  ],
  async validate(key, endpoint, signal): Promise<ValidationResult> {
    const url = `${(endpoint ?? ANTHROPIC_API).replace(/\/+$/, '')}/v1/messages`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), VALIDATE_TIMEOUT_MS);
    signal?.addEventListener('abort', () => ac.abort(), { once: true });
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'x-api-key': key,
          'anthropic-version': ANTHROPIC_VERSION,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-3-5-haiku-latest',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'hi' }],
        }),
        signal: ac.signal,
      });
      if (res.status === 401 || res.status === 403) return { ok: false, reason: 'invalid_key' };
      if (!res.ok) return { ok: false, reason: 'network' };
      return { ok: true };
    } catch {
      return { ok: false, reason: 'network' };
    } finally {
      clearTimeout(timer);
    }
  },
};
