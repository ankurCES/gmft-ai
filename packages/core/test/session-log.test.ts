import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendTurn, appendTurnRaw, readLog, redactSecrets } from '../src/session/log.js';

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gmft-log-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('session log', () => {
  it('appendTurn writes JSONL and readLog returns parsed turns', async () => {
    const p = join(dir, 'turns.jsonl');
    await appendTurn(p, { role: 'user', content: 'hi' });
    await appendTurn(p, { role: 'assistant', content: 'hello' });
    const turns = await readLog(p);
    expect(turns).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]);
  });

  it('readLog returns [] when the file is missing', async () => {
    const turns = await readLog(join(dir, 'nope.jsonl'));
    expect(turns).toEqual([]);
  });

  it('redactSecrets strips Authorization headers, apiKey=, bearer tokens', () => {
    const line =
      'POST /v1/messages Authorization: Bearer sk-ant-12345 apiKey=sk-openai-67890 body=ok';
    const r = redactSecrets(line);
    expect(r).not.toMatch(/sk-ant-12345/);
    expect(r).not.toMatch(/sk-openai-67890/);
    expect(r).toMatch(/Authorization: \[REDACTED\]/);
    expect(r).toMatch(/apiKey=\[REDACTED\]/);
    expect(r).toMatch(/body=ok/);
  });

  // 1.5g — write-time redaction regression tests
  it('appendTurn scrubs a pasted sk-ant- key from the user content', async () => {
    const p = join(dir, 'turns.jsonl');
    await appendTurn(p, { role: 'user', content: 'my key is sk-ant-1234567890abcdef please use it' });
    const text = await readFile(p, 'utf8');
    expect(text).not.toMatch(/sk-ant-1234567890abcdef/);
    expect(text).toMatch(/\[REDACTED\]/);
  });

  it('appendTurn scrubs a pasted JSON-shaped apiKey from the user content', async () => {
    const p = join(dir, 'turns.jsonl');
    await appendTurn(p, {
      role: 'user',
      content: 'here is my config: {"apiKey": "sk-ant-abcdef0123456789", "model": "gpt-4o"}',
    });
    const text = await readFile(p, 'utf8');
    // The on-disk form is JSON.stringify'd, so the user's `"` becomes `\"`
    // inside the outer string. We just need to confirm the secret and its
    // substitution made it through to disk as [REDACTED].
    expect(text).not.toMatch(/sk-ant-abcdef0123456789/);
    expect(text).toMatch(/\\?"apiKey\\?":\s*\\?"\[REDACTED\]\\?"/);
    // non-secret keys pass through untouched
    expect(text).toMatch(/\\?"model\\?":\s*\\?"gpt-4o\\?"/);
  });

  it('appendTurn scrubs a pasted Authorization header from the user content', async () => {
    const p = join(dir, 'turns.jsonl');
    await appendTurn(p, {
      role: 'user',
      content: 'curl -H "Authorization: Bearer sk-openai-9999888877776666" https://example.com',
    });
    const text = await readFile(p, 'utf8');
    expect(text).not.toMatch(/sk-openai-9999888877776666/);
    expect(text).toMatch(/Authorization: \[REDACTED\]/);
  });

  it('appendTurn leaves normal chat content untouched', async () => {
    const p = join(dir, 'turns.jsonl');
    const content = 'hi how are you? — fine, just writing some tests';
    await appendTurn(p, { role: 'user', content });
    const turns = await readLog(p);
    expect(turns[0]?.content).toBe(content);
    const text = await readFile(p, 'utf8');
    expect(text).not.toMatch(/\[REDACTED\]/);
  });

  it('appendTurnRaw bypasses redaction (escape hatch)', async () => {
    const p = join(dir, 'turns.jsonl');
    const secret = 'sk-ant-9999888877776666aaaa';
    await appendTurnRaw(p, { role: 'user', content: `key: ${secret}` });
    const text = await readFile(p, 'utf8');
    // raw is the production-style escape: the secret IS on disk
    expect(text).toContain(secret);
  });
});
