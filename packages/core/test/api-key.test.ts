/**
 * Unit tests for the apiKey lookup helper.
 *
 * `lookupApiKey` and `bindGetApiKey` wrap SecretStore so callers don't
 * each have to know the `${provider}.apiKey` convention. We mock the
 * SecretStore interface directly (it's the only collaborator) and
 * assert:
 *   - happy path: key present -> returned
 *   - missing key: returns ''
 *   - store throws: returns '' (never throws upward)
 *   - bindGetApiKey: closure is stable + delegates to the bound store
 */
import { describe, expect, it, vi } from 'vitest';
import { bindGetApiKey, lookupApiKey } from '../src/llm/api-key.js';
import type { SecretStore } from '../src/config/secrets.js';

function makeStore(get: (key: string) => Promise<string | undefined>): SecretStore {
  return {
    get: vi.fn(get),
    set: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
  };
}

describe('lookupApiKey', () => {
  it('returns the secret when the store has it', async () => {
    const store = makeStore(async (k) => (k === 'anthropic.apiKey' ? 'sk-ant-123' : undefined));
    const key = await lookupApiKey('anthropic', store);
    expect(key).toBe('sk-ant-123');
    expect(store.get).toHaveBeenCalledWith('anthropic.apiKey');
  });

  it('returns "" when the secret is missing', async () => {
    const store = makeStore(async () => undefined);
    const key = await lookupApiKey('openai', store);
    expect(key).toBe('');
  });

  it('returns "" when the store throws (never throws upward)', async () => {
    const store = makeStore(async () => {
      throw new Error('keytar binding missing');
    });
    const key = await lookupApiKey('openai', store);
    expect(key).toBe('');
  });

  it('looks up <provider>.apiKey — not a raw key', async () => {
    // Regression guard: a previous version accidentally called
    // store.get(provider) and got back the literal 'anthropic'.
    // The contract is `${provider}.apiKey` and we keep it explicit.
    const store = makeStore(async (k) => (k === 'google.apiKey' ? 'goog-key' : 'WRONG'));
    const key = await lookupApiKey('google', store);
    expect(key).toBe('goog-key');
  });
});

describe('bindGetApiKey', () => {
  it('returns a closure that calls the bound store', async () => {
    const store = makeStore(async (k) => (k === 'openai.apiKey' ? 'sk-oai' : undefined));
    const getApiKey = bindGetApiKey(store);
    const key = await getApiKey('openai');
    expect(key).toBe('sk-oai');
  });

  it('returns "" for an unknown provider without throwing', async () => {
    const store = makeStore(async () => undefined);
    const getApiKey = bindGetApiKey(store);
    expect(await getApiKey('openrouter')).toBe('');
    expect(await getApiKey('ollama')).toBe('');
  });

  it('returns "" when the bound store throws (keytar hiccup)', async () => {
    const store = makeStore(async () => {
      throw new Error('DB lock');
    });
    const getApiKey = bindGetApiKey(store);
    expect(await getApiKey('anthropic')).toBe('');
  });
});
