import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendTurn, readLog, redactSecrets } from '../src/session/log.js';

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
});
