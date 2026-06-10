import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from 'undici';
import { anthropic } from '../src/llm/providers/anthropic.js';

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
