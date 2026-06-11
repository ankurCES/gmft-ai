import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendTurn, appendTurnRaw, readLog, redactSecrets, type Turn } from '../src/session/log.js';

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
    // v0.2.A.3: every new line is written with schemaVersion: 2.
    expect(turns).toEqual([
      { schemaVersion: 2, role: 'user', content: 'hi' },
      { schemaVersion: 2, role: 'assistant', content: 'hello' },
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

/**
 * v0.2.A.3 — schemaVersion 1↔2 migration.
 *
 * The pre-v0.2 log is JSONL where each line is `{role, content, meta?}`
 * with no `schemaVersion` and no `supervisor` field. v0.2.A+ writes
 * `schemaVersion: 2` on every new line and may include a
 * `supervisor: SupervisorTurnRecord` field.
 *
 * Read-time migration: `readLog` backfills `schemaVersion: 1` on
 * legacy lines that lack the field, so the parsed shape is uniform
 * for callers. The on-disk file is not rewritten.
 */
describe('session log schema migration (v1 ↔ v2)', () => {
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gmft-mig-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('writes schemaVersion: 2 on a new turn (v0.2.A+)', async () => {
    const p = join(dir, 'session.jsonl');
    const turn: Turn = {
      role: 'assistant',
      content: 'scan complete',
      supervisor: { fires: [{ kind: 'overclaim', quote: 'q', evidence: 'e', advice: 'a', targetEventId: 't' }] },
    };
    await appendTurn(p, turn);
    const text = await readFile(p, 'utf8');
    // schemaVersion: 2 written to disk
    expect(text).toMatch(/"schemaVersion":\s*2/);
    // supervisor.fires round-tripped (the overclaim fire's quote 'q' is harmless)
    expect(text).toMatch(/"kind":\s*"overclaim"/);
    // readLog returns the line with schemaVersion: 2
    const loaded = await readLog(p);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.schemaVersion).toBe(2);
    expect(loaded[0]?.supervisor?.fires).toHaveLength(1);
  });

  it('loads a v0.1 line (no schemaVersion) as schemaVersion: 1, supervisor: undefined', async () => {
    const p = join(dir, 'legacy.jsonl');
    // Hand-craft a v0.1-shaped line: no schemaVersion, no supervisor.
    writeFileSync(
      p,
      JSON.stringify({ role: 'user', content: 'hello' }) + '\n' +
        JSON.stringify({ role: 'assistant', content: 'hi' }) + '\n',
    );
    const loaded = await readLog(p);
    expect(loaded).toHaveLength(2);
    expect(loaded[0]?.schemaVersion).toBe(1);
    expect(loaded[0]?.supervisor).toBeUndefined();
    expect(loaded[0]?.content).toBe('hello');
    expect(loaded[1]?.schemaVersion).toBe(1);
    expect(loaded[1]?.supervisor).toBeUndefined();
  });

  it('loads a v0.1 line (schemaVersion: 1) as-is', async () => {
    const p = join(dir, 'session-v1.jsonl');
    writeFileSync(
      p,
      JSON.stringify({ schemaVersion: 1, role: 'user', content: 'a' }) + '\n' +
        JSON.stringify({ schemaVersion: 1, role: 'assistant', content: 'b' }) + '\n',
    );
    const loaded = await readLog(p);
    expect(loaded).toHaveLength(2);
    expect(loaded[0]?.schemaVersion).toBe(1);
    expect(loaded[1]?.schemaVersion).toBe(1);
  });

  it('loads a v0.2 line (schemaVersion: 2) with the supervisor field intact', async () => {
    const p = join(dir, 'session-v2.jsonl');
    const postmortem = 'WHAT WE TRIED: scan\nLEARNED: ports open\nMISSING: nothing\nNEXT STEP: enumerate';
    writeFileSync(
      p,
      JSON.stringify({
        schemaVersion: 2,
        role: 'assistant',
        content: 'scanned',
        supervisor: {
          fires: [{ kind: 'overclaim', quote: 'q', evidence: 'e', advice: 'a', targetEventId: 't' }],
          postmortem,
        },
      }) + '\n',
    );
    const loaded = await readLog(p);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.schemaVersion).toBe(2);
    expect(loaded[0]?.supervisor?.postmortem).toBe(postmortem);
    expect(loaded[0]?.supervisor?.fires).toHaveLength(1);
  });

  it('redacts a sk- secret in supervisor.postmortem on appendTurn', async () => {
    const p = join(dir, 'session-redact.jsonl');
    const secret = 'sk-abcdef0123456789abcdef0123456789';
    const turn: Turn = {
      role: 'assistant',
      content: 'work',
      supervisor: {
        fires: [],
        // An LLM-quoted user secret lands in the postmortem. The
        // string-level redactor must catch it on disk.
        postmortem: `The user leaked this key: ${secret}`,
      },
    };
    await appendTurn(p, turn);
    const text = await readFile(p, 'utf8');
    expect(text).not.toContain(secret);
    expect(text).toContain('[REDACTED]');
  });
});
