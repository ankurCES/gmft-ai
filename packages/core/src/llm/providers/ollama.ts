import { fetch } from 'undici';
import type { ProviderModule, ValidationResult } from './types.js';

const OLLAMA_DEFAULT = 'http://localhost:11434';
const VALIDATE_TIMEOUT_MS = 3_000; // local probe can be quick

async function probe(url: string): Promise<ValidationResult> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), VALIDATE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ac.signal });
    // Ollama returns 200 + JSON on /api/tags if running. Any non-2xx
    // (Ollama doesn't auth, so no 401) is "not running" = network.
    if (!res.ok) return { ok: false, reason: 'network' };
    return { ok: true };
  } catch {
    return { ok: false, reason: 'network' };
  } finally {
    clearTimeout(timer);
  }
}

export const ollama: ProviderModule = {
  id: 'ollama',
  displayName: 'Ollama (local)',
  // No apiKey — the user provides an endpoint URL. This is the one
  // place where `isEndpoint: true` matters.
  authFields: [
    {
      id: 'endpoint',
      label: 'Ollama server URL',
      isEndpoint: true,
      placeholder: OLLAMA_DEFAULT,
    },
  ],
  defaultEndpoint: OLLAMA_DEFAULT,
  // Ollama's model catalog is whatever the local server has installed.
  // We list 3 popular defaults; the user picks one. Phase 2 can swap
  // this for a live `GET /api/tags` call.
  modelCatalog: [
    { id: 'llama3.2', displayName: 'Llama 3.2', isDefault: true },
    { id: 'qwen2.5', displayName: 'Qwen 2.5' },
    { id: 'gemma2', displayName: 'Gemma 2' },
  ],
  // Ollama's validate ignores the key param (no auth). The "auth field"
  // value is the endpoint URL; we read it from the `endpoint` arg.
  async validate(_key, endpoint) {
    return probe(`${(endpoint ?? OLLAMA_DEFAULT).replace(/\/+$/, '')}/api/tags`);
  },
};
