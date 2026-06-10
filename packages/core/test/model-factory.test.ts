import { describe, it, expect } from 'vitest';
import { createModel, type CreateModelOpts } from '../src/llm/model-factory.js';

describe('createModel', () => {
  it('returns an anthropic LanguageModel when provider=anthropic', () => {
    const m = createModel({
      provider: 'anthropic',
      model: 'claude-3-5-sonnet-latest',
      apiKey: 'sk-test',
    });
    expect(m.modelId).toContain('claude-3-5-sonnet');
    expect(m.provider).toBe('anthropic.messages');
  });

  it('returns an openai LanguageModel when provider=openai', () => {
    const m = createModel({
      provider: 'openai',
      model: 'gpt-4o-mini',
      apiKey: 'sk-test',
    });
    expect(m.modelId).toBe('gpt-4o-mini');
    expect(m.provider).toBe('openai.chat');
  });

  it('returns a google LanguageModel when provider=google', () => {
    const m = createModel({
      provider: 'google',
      model: 'gemini-1.5-flash',
      apiKey: 'sk-test',
    });
    expect(m.modelId).toBe('gemini-1.5-flash');
    expect(m.provider).toContain('google');
  });

  it('returns an openai-compatible LanguageModel for ollama with empty apiKey', () => {
    const m = createModel({
      provider: 'ollama',
      model: 'llama3',
      apiKey: '',
      endpoint: 'http://localhost:11434/v1',
    });
    expect(m.modelId).toBe('llama3');
    // openai-compatible models are tagged with the provider `name` we set.
    expect(m.provider).toBe('ollama.chat');
  });

  it('throws when openrouter is requested without endpoint', () => {
    const opts: CreateModelOpts = {
      provider: 'openrouter',
      model: 'anthropic/claude-3.5-sonnet',
      apiKey: 'sk-test',
    };
    expect(() => createModel(opts)).toThrow(/openrouter/);
  });
});
