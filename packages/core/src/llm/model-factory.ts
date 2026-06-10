/**
 * Factory that turns a stable `LlmConfig` + auth material into a Vercel
 * AI SDK `LanguageModel` handle. The returned value is what `streamText`
 * accepts. v0.1 has no tools (chokepoint lands in phase 3), so this
 * factory is the only LLM-side surface area.
 *
 * Branching rules (locked 2026-06-13):
 *   anthropic  -> @ai-sdk/anthropic   (apiKey required)
 *   openai     -> @ai-sdk/openai      (apiKey required)
 *   google     -> @ai-sdk/google      (apiKey required)
 *   openrouter -> @ai-sdk/openai      (apiKey + endpoint required, compat=compatible)
 *   ollama     -> @ai-sdk/openai      (endpoint required, compat=compatible)
 *
 * Why we use @ai-sdk/openai for openrouter/ollama and not
 * @ai-sdk/openai-compatible: the openai-compatible package is pinned to
 * `>=1.0` (provider V2) in this workspace, but `ai@4.3.19` is built on
 * `@ai-sdk/provider@1.1.3` (V1). The V2 model objects can't be passed
 * into `streamText`. `@ai-sdk/openai@1.3.24` is V1-native and accepts a
 * custom `baseURL` + `compatibility: 'compatible'` — which is exactly
 * what OpenRouter / Ollama need. This sidesteps the version skew without
 * a lockfile churn.
 */

import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import type { LanguageModel } from 'ai';
import type { LlmConfig } from '../config/config.js';

export interface CreateModelOpts {
  /** Stable id matching `LlmConfig.provider`. */
  provider: LlmConfig['provider'];
  /** Model id, e.g. 'claude-3-5-sonnet-latest', 'gpt-4o-mini', 'llama3'. */
  model: string;
  /**
   * API key. Required for all cloud providers (anthropic/openai/google/
   * openrouter). For Ollama the SDK still requires a non-empty string,
   * so callers should pass 'ollama' (the factory does this automatically
   * if you pass an empty string).
   */
  apiKey: string;
  /**
   * Base URL for OpenRouter / Ollama. Required for those providers.
   * For cloud providers this is ignored.
   */
  endpoint?: string;
}

/**
 * Build a Vercel AI SDK `LanguageModel` from provider + auth material.
 * Throws if a required `endpoint` is missing for openrouter / ollama, or
 * if `apiKey` is empty for a cloud provider.
 */
export function createModel(opts: CreateModelOpts): LanguageModel {
  const { provider, model, apiKey, endpoint } = opts;

  switch (provider) {
    case 'anthropic': {
      if (!apiKey) throw new Error('createModel: anthropic requires apiKey');
      const a = createAnthropic({ apiKey });
      return a(model);
    }
    case 'openai': {
      if (!apiKey) throw new Error('createModel: openai requires apiKey');
      const o = createOpenAI({ apiKey });
      return o(model);
    }
    case 'google': {
      if (!apiKey) throw new Error('createModel: google requires apiKey');
      const g = createGoogleGenerativeAI({ apiKey });
      return g(model);
    }
    case 'openrouter': {
      if (!apiKey) throw new Error('createModel: openrouter requires apiKey');
      if (!endpoint) throw new Error('createModel: openrouter requires endpoint');
      const c = createOpenAI({
        apiKey,
        baseURL: endpoint,
        compatibility: 'compatible',
        name: 'openrouter',
      });
      return c(model);
    }
    case 'ollama': {
      if (!endpoint) throw new Error('createModel: ollama requires endpoint');
      const c = createOpenAI({
        // SDK requires a non-empty key; Ollama doesn't check it.
        apiKey: apiKey || 'ollama',
        baseURL: endpoint,
        compatibility: 'compatible',
        name: 'ollama',
      });
      return c(model);
    }
  }
}
