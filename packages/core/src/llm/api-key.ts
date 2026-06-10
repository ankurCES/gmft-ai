/**
 * Provider-aware API key lookup.
 *
 * The LLM factory (`createModel`) needs an `apiKey` per call. Keys live
 * in the `SecretStore` under the convention `${provider}.apiKey`
 * (set by `runOnboarding` in 1.5b). This module wraps the lookup so
 * callers (AgentApp, the CLI boot path) can resolve a key for any
 * provider without each call site having to know the store service
 * name or the key suffix.
 *
 * Returns `''` when:
 *   - the provider is not a cloud provider (e.g. `ollama` is allowed
 *     to fall through; the factory substitutes the literal 'ollama'),
 *   - the secret store is unavailable (e.g. keytar native binding
 *     failed to load — caller should log once at boot and move on),
 *   - the key is genuinely unset (the user hasn't onboarded that
 *     provider).
 *
 * The factory's own validation throws clearly downstream ("createModel:
 * <provider> requires apiKey"), so a `''` return is safe — it surfaces
 * as a chat-visible error on the next LLM turn instead of a crash.
 */
import { createSecretStore, type SecretStore, type SecretBackend } from '../config/secrets.js';

const SERVICE = 'gmft';

export type GetApiKey = (provider: string) => Promise<string>;

/**
 * Look up `${provider}.apiKey` in the SecretStore. Returns `''` on any
 * failure (store unavailable, key unset). Never throws.
 */
export async function lookupApiKey(
  provider: string,
  store?: SecretStore,
  preferred?: SecretBackend,
): Promise<string> {
  try {
    const s = store ?? (await createSecretStore({ service: SERVICE, preferred }));
    return (await s.get(`${provider}.apiKey`)) ?? '';
  } catch {
    // Secret store probe failed (keytar binding missing, permission
    // denied on the envfile, etc.). Defer the error to the next
    // createModel() call so the user sees one clear message at the
    // LLM turn boundary, not a stream of confusing lookup failures.
    return '';
  }
}

/**
 * Build a `GetApiKey` closure bound to a specific SecretStore. Use
 * this in the CLI boot path so the store is created exactly once and
 * reused for every swap.
 *
 * @example
 *   const store = await createSecretStore({ service: 'gmft' });
 *   const getApiKey = bindGetApiKey(store);
 *   const key = await getApiKey('openai'); // looks up openai.apiKey
 */
export function bindGetApiKey(store: SecretStore): GetApiKey {
  return async (provider: string): Promise<string> => {
    try {
      return (await store.get(`${provider}.apiKey`)) ?? '';
    } catch {
      return '';
    }
  };
}
