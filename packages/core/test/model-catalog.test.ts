/**
 * Unit tests for the model catalog.
 *
 * `getDefaultModel(provider)` is the helper `/provider <id>` uses to
 * fill in a sensible model id when the user didn't supply one. The
 * defaults are intentionally pinned (one per provider, the cheap/fast
 * tier) — bump them intentionally, not by accident.
 */
import { describe, expect, it } from 'vitest';
import { getDefaultModel } from '../src/llm/model-catalog.js';

describe('getDefaultModel', () => {
  it('returns a non-empty string for every known provider', () => {
    // Pinned defaults — these exact strings appear in /provider
    // confirmation replies and in the system prompt when no model
    // is configured. Changing them is a user-visible decision.
    expect(getDefaultModel('anthropic')).toBe('claude-3-5-haiku-latest');
    expect(getDefaultModel('openai')).toBe('gpt-4o-mini');
    expect(getDefaultModel('google')).toBe('gemini-1.5-flash');
    expect(getDefaultModel('openrouter')).toBe('openai/gpt-4o-mini');
    expect(getDefaultModel('ollama')).toBe('llama3.2');
  });

  it('returns "" for an unknown provider (mirrors the factory)', () => {
    expect(getDefaultModel('nope')).toBe('');
    expect(getDefaultModel('')).toBe('');
    // Case-sensitive on purpose — the factory's switch is exact-match
    // too. A typo in onboarding would surface as a model-factory
    // throw, not a silent fallback to a different provider.
    expect(getDefaultModel('Anthropic')).toBe('');
  });
});
