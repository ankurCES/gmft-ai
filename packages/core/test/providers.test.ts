import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from 'undici';
import { anthropic } from '../src/llm/providers/anthropic.js';
import { openai } from '../src/llm/providers/openai.js';
import { google } from '../src/llm/providers/google.js';
import { openrouter } from '../src/llm/providers/openrouter.js';
import { ollama } from '../src/llm/providers/ollama.js';

let mock: MockAgent;
let realDispatcher: ReturnType<typeof getGlobalDispatcher>;

beforeEach(() => {
  mock = new MockAgent();
  mock.disableNetConnect();
  setGlobalDispatcher(mock);
  realDispatcher = getGlobalDispatcher();
});
afterEach(async () => {
  await mock.close();
  setGlobalDispatcher(realDispatcher);
});

describe('anthropic.validate', () => {
  const pool = () => mock.get('https://api.anthropic.com');

  it('returns ok:true when the API responds 200', async () => {
    pool()
      .intercept({ path: '/v1/messages', method: 'POST' })
      .reply(200, {
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        model: 'claude-3-5-haiku-latest',
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    const r = await anthropic.validate('sk-ant-test');
    expect(r.ok).toBe(true);
  });

  it('returns invalid_key when the API responds 401', async () => {
    pool()
      .intercept({ path: '/v1/messages', method: 'POST' })
      .reply(401, {
        type: 'error',
        error: { type: 'authentication_error', message: 'invalid x-api-key' },
      });
    const r = await anthropic.validate('sk-ant-bad');
    expect(r).toEqual({ ok: false, reason: 'invalid_key' });
  });

  it('returns network when the API responds 500', async () => {
    pool()
      .intercept({ path: '/v1/messages', method: 'POST' })
      .reply(500, {
        type: 'error',
        error: { type: 'api_error', message: 'server error' },
      });
    const r = await anthropic.validate('sk-ant-test');
    expect(r).toEqual({ ok: false, reason: 'network' });
  });
});

describe('openai.validate', () => {
  const pool = () => mock.get('https://api.openai.com');
  it('ok on 200', async () => {
    pool()
      .intercept({ path: '/v1/models', method: 'GET' })
      .reply(200, { data: [] });
    expect((await openai.validate('sk-test')).ok).toBe(true);
  });
  it('invalid_key on 401', async () => {
    pool()
      .intercept({ path: '/v1/models', method: 'GET' })
      .reply(401, { error: { message: 'invalid' } });
    expect(await openai.validate('sk-bad')).toEqual({ ok: false, reason: 'invalid_key' });
  });
  it('network on 5xx', async () => {
    pool()
      .intercept({ path: '/v1/models', method: 'GET' })
      .reply(500, {});
    expect(await openai.validate('sk-test')).toEqual({ ok: false, reason: 'network' });
  });
});

describe('google.validate', () => {
  const pool = () => mock.get('https://generativelanguage.googleapis.com');
  it('ok on 200', async () => {
    pool()
      .intercept({ path: /^\/v1beta\/models\?key=sk-test$/, method: 'GET' })
      .reply(200, { models: [] });
    expect((await google.validate('sk-test')).ok).toBe(true);
  });
  it('invalid_key on 403', async () => {
    pool()
      .intercept({ path: /^\/v1beta\/models\?key=sk-bad$/, method: 'GET' })
      .reply(403, { error: { message: 'forbidden' } });
    expect(await google.validate('sk-bad')).toEqual({ ok: false, reason: 'invalid_key' });
  });
});

describe('openrouter.validate', () => {
  const pool = () => mock.get('https://openrouter.ai');
  it('ok on 200', async () => {
    pool()
      .intercept({ path: '/api/v1/auth/key', method: 'GET' })
      .reply(200, { data: { label: 'k' } });
    expect((await openrouter.validate('sk-or-test')).ok).toBe(true);
  });
  it('invalid_key on 401', async () => {
    pool()
      .intercept({ path: '/api/v1/auth/key', method: 'GET' })
      .reply(401, {});
    expect(await openrouter.validate('sk-or-bad')).toEqual({ ok: false, reason: 'invalid_key' });
  });
});

describe('ollama.validate', () => {
  const pool = () => mock.get('http://localhost:11434');
  it('ok on 200 from /api/tags', async () => {
    pool()
      .intercept({ path: '/api/tags', method: 'GET' })
      .reply(200, { models: [] });
    expect((await ollama.validate('', 'http://localhost:11434')).ok).toBe(true);
  });
  it('network on 503', async () => {
    pool()
      .intercept({ path: '/api/tags', method: 'GET' })
      .reply(503, {});
    expect(await ollama.validate('', 'http://localhost:11434')).toEqual({
      ok: false,
      reason: 'network',
    });
  });
});
