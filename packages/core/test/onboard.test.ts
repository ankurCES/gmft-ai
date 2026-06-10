import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  registerConfigField,
  getConfigFields,
  _clearConfigFields,
  type ConfigField,
  type OnboardRuntime,
} from '../src/config/registry.js';
import { runOnboarding } from '../src/llm/onboard.js';
import type { GmftConfig, LlmConfig, UiConfig } from '../src/config/config.js';

function fakeRuntime(overrides: Partial<OnboardRuntime> = {}): OnboardRuntime {
  return {
    getSecret: async () => null,
    setSecret: async () => {},
    validateProvider: async () => ({ ok: true }),
    providers: [],
    ...overrides,
  };
}

function fakeField(
  id: string,
  opts: { configured?: boolean; returns?: Partial<GmftConfig> | null } = {},
): ConfigField {
  return {
    id,
    label: id,
    order: 100,
    isConfigured: () => opts.configured ?? false,
    prompt: async () => opts.returns ?? null,
  };
}

describe('runOnboarding', () => {
  beforeEach(() => _clearConfigFields());

  it('prompts every unconfigured field, merges partials, saves once', async () => {
    registerConfigField(
      fakeField('a', {
        returns: { llm: { provider: 'anthropic', model: 'm' } as LlmConfig },
      }),
    );
    registerConfigField(
      fakeField('b', { returns: { ui: { theme: 'dark' } as UiConfig } }),
    );
    const saved: GmftConfig[] = [];
    const result = await runOnboarding({
      fields: getConfigFields(),
      runtimeFactory: () => fakeRuntime(),
      save: async (cfg) => {
        saved.push(cfg);
      },
    });
    expect(result).not.toBeNull();
    const cfg = result as unknown as GmftConfig;
    expect(cfg.llm.provider).toBe('anthropic');
    expect(cfg.ui.theme).toBe('dark');
    expect(saved).toHaveLength(1);
  });

  it('skips fields that are already configured', async () => {
    const prompt = vi.fn(async () => null);
    registerConfigField({ id: 'a', label: 'a', order: 1, isConfigured: () => true, prompt });
    registerConfigField(
      fakeField('b', { returns: { ui: { theme: 'light' } as UiConfig } }),
    );
    await runOnboarding({
      fields: getConfigFields(),
      runtimeFactory: () => fakeRuntime(),
      save: async () => {},
    });
    expect(prompt).not.toHaveBeenCalled();
  });

  it('returns null and skips save if any field prompts null (user abort)', async () => {
    registerConfigField(fakeField('a', { returns: null }));
    registerConfigField(
      fakeField('b', { returns: { ui: { theme: 'dark' } as UiConfig } }),
    );
    const save = vi.fn(async () => {});
    const result = await runOnboarding({
      fields: getConfigFields(),
      runtimeFactory: () => fakeRuntime(),
      save,
    });
    expect(result).toBeNull();
    expect(save).not.toHaveBeenCalled();
  });

  it('honors force:true and re-prompts configured fields', async () => {
    const prompt = vi.fn(async () => ({ ui: { theme: 'high-contrast' } as UiConfig }));
    registerConfigField({ id: 'a', label: 'a', order: 1, isConfigured: () => true, prompt });
    await runOnboarding({
      fields: getConfigFields(),
      runtimeFactory: () => fakeRuntime(),
      save: async () => {},
      force: true,
    });
    expect(prompt).toHaveBeenCalled();
  });
});
