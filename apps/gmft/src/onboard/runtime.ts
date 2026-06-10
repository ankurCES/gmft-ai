import {
  PROVIDERS,
  getProvider,
  createSecretStore,
  type OnboardRuntime,
  type ProviderModule,
  type SecretStore,
} from '@gmft/core';

/**
 * Production `OnboardRuntime` for the gmft CLI. Wires:
 *   - `createSecretStore({ service: 'gmft' })` — the core factory probes
 *     keytar first and falls back to EnvFileStore on failure
 *   - `ProviderModule.validate()` for the `validateProvider` probe
 *   - `PROVIDERS` for the readonly provider list
 *
 * `createSecretStore` is async, so we memoize its promise lazily on first
 * use and keep `createOnboardRuntime()` itself synchronous. This matches
 * the sync `createOnboardRuntime(): OnboardRuntime` shape expected by
 * consumers (e.g. the LLM provider field).
 *
 * `setSecret` is a no-op for `isEndpoint` fields, but the LLM provider
 * field only calls setSecret for non-endpoint auth fields, so the field
 * itself handles endpoints before calling setSecret. (See
 * packages/core/src/llm/llm-provider-field.ts.)
 */
export function createOnboardRuntime(): OnboardRuntime {
  let storePromise: Promise<SecretStore> | null = null;
  const getStore = (): Promise<SecretStore> => {
    if (!storePromise) {
      storePromise = createSecretStore({ service: 'gmft' }).catch((err) => {
        storePromise = null;
        throw err;
      });
    }
    return storePromise;
  };

  return {
    providers: PROVIDERS,

    async getSecret(key: string): Promise<string | null> {
      const store = await getStore();
      return store.get(key);
    },

    async setSecret(key: string, value: string): Promise<void> {
      const store = await getStore();
      await store.set(key, value);
    },

    async validateProvider(
      providerId: string,
      key: string,
      endpoint?: string,
    ): Promise<
      { ok: true } | { ok: false; reason: 'invalid_key' | 'network' | 'unknown' }
    > {
      const provider = getProvider(providerId);
      if (!provider) return { ok: false, reason: 'unknown' };
      const v = await provider.validate(key, endpoint);
      if (v.ok) return { ok: true };
      return { ok: false, reason: v.reason };
    },
  };
}
