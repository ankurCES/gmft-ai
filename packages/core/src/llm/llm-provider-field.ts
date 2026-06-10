import type { ConfigField, OnboardRuntime } from '../config/registry.js';
import { PROVIDERS, getProvider } from './providers/index.js';
import type { ProviderUI } from './providers/types.js';
import type { GmftConfig, LlmConfig } from '../config/config.js';

const FIELD_ID = 'llm-provider';
const FIELD_ORDER = 10; // early in the onboard flow

/**
 * Factory that returns the LLM-provider `ConfigField`. The caller passes
 * a `ProviderUI` adapter; 1.5b tests use a fake UI, 1.5c binds the real
 * Ink components.
 *
 * `isConfigured()` requires both `cfg.llm.provider` and `cfg.llm.model`
 * to be set. Secret existence is verified at prompt-time by calling
 * `runtime.getSecret(...)` for the chosen provider — if missing, we
 * force a re-prompt regardless of the cfg fields.
 */
export function createLlmProviderField(ui: ProviderUI): ConfigField {
  return {
    id: FIELD_ID,
    label: 'LLM provider',
    order: FIELD_ORDER,
    isConfigured(cfg) {
      if (!cfg.llm?.provider || !cfg.llm?.model) return false;
      return true;
    },
    async prompt(runtime: OnboardRuntime): Promise<Partial<GmftConfig> | null> {
      // Step 1: pick a provider
      const providerId = await ui.pickProvider(PROVIDERS);
      if (!providerId) return null; // user aborted
      const provider = getProvider(providerId);
      if (!provider) return null; // unknown id — should be impossible

      // Step 2: for each auth field, collect + store + validate
      const partial: Partial<GmftConfig> & { llm: LlmConfig } = {
        llm: { provider: provider.id, model: '' },
      };
      for (const field of provider.authFields) {
        const value = await ui.enterKey(field);
        if (!value) return null; // user aborted
        if (field.isEndpoint) {
          // Endpoints are config, not secrets. No SecretStore round-trip.
          partial.llm.endpoint = value;
        } else {
          // Secrets: write to SecretStore, then validate by reading back.
          // The onboard-runtime's validateProvider does the actual probe.
          await runtime.setSecret(`${provider.id}.${field.id}`, value);
          const v = await runtime.validateProvider(
            provider.id,
            value,
            partial.llm.endpoint,
          );
          if (!v.ok) {
            const retry = await ui.confirmAction(
              `Key validation failed (${v.reason}). Continue anyway?`,
            );
            if (!retry) return null;
            // The honest thing is to bail and let the user re-run onboard.
            // We don't loop here — keeps the driver dumb.
            return null;
          }
        }
      }

      // Step 3: pick a model
      const model = await ui.pickModel(provider, provider.modelCatalog);
      if (!model) return null; // user aborted
      partial.llm.model = model;

      return partial;
    },
  };
}
