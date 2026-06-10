import { describe, it, expect } from 'vitest';
import { buildSystemPrompt, type PromptEnv } from '../src/llm/prompts.js';

const ENV: PromptEnv = {
  hostname: 'test-box',
  os: 'linux',
  sandboxMode: 'host',
  provider: 'anthropic',
  model: 'claude-3-5-sonnet-latest',
  username: 'tester',
};

describe('buildSystemPrompt', () => {
  it('agent prompt embeds safety + environment details', () => {
    const out = buildSystemPrompt('agent', ENV);
    expect(out).toContain('AUTHORIZED');          // safety #1
    expect(out).toContain('STOP and ask');         // safety #1 verbatim
    expect(out).toContain('exfiltrate');           // safety #2
    expect(out).toContain('destructive');          // safety #3
    expect(out).toContain('chokepoint');           // safety #4
    expect(out).toContain('denylist');             // safety #5
    expect(out).toContain('tester@test-box');      // env: user@host
    expect(out).toContain('linux');                // env: os
    expect(out).toContain('sandbox: host');        // env: sandbox
    expect(out).toContain('anthropic:claude-3-5-sonnet-latest'); // env: model
  });

  it('summarizer prompt is short and instructs compression', () => {
    const out = buildSystemPrompt('summarizer', ENV);
    expect(out).toContain('summarizer');
    expect(out).toContain('paragraph');
    expect(out.length).toBeLessThan(400);
  });
});
