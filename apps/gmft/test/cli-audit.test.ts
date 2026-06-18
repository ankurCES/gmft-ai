/**
 * v0.3.C — `cli-audit.ts` primitive tests.
 *
 * Covers the three read-side operations on the audit log:
 *   1. `verifyAuditLog` — integrity check (intact, broken-hash, wrong key)
 *   2. `readAuditLog`   — filter + limit (default, kind filter, limit)
 *   3. `tailAuditLog`   — follow mode (new line appears)
 *
 * Logs are constructed with the real `AuditWriter` so the file format
 * matches what production writes. The verifier is checked against a
 * known-good chain, a tampered chain (one event's `hash` field
 * replaced with garbage), and a valid chain checked with a *wrong*
 * key (which should break every event's recomputed hash).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { AuditWriter, type AuditEvent } from '@gmft/core';
import { verifyAuditLog, readAuditLog, tailAuditLog } from '../src/cli-audit.js';

function scratchDir(): string {
  return mkdtempSync(join(tmpdir(), 'gmft-cli-audit-'));
}

async function makeWriter(dir: string, key?: Buffer): Promise<AuditWriter> {
  return new AuditWriter({ auditDir: dir, key: key ?? randomBytes(32) });
}

describe('verifyAuditLog', () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('returns ok=true for an intact hash chain', async () => {
    dir = scratchDir();
    const key = randomBytes(32);
    const w = await makeWriter(dir, key);
    await w.append('session-start', { session: 'a' });
    await w.append('tool-decision', { tool: 'nmap', decision: 'allow' });
    await w.append('session-end', { session: 'a' });

    const r = verifyAuditLog(join(dir, 'audit.jsonl'), key);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.eventCount).toBe(3);
      expect(r.lastEvent.kind).toBe('session-end');
    }
  });

  it('returns ok=false when an event hash is tampered', async () => {
    dir = scratchDir();
    const key = randomBytes(32);
    const w = await makeWriter(dir, key);
    await w.append('session-start', { session: 'a' });
    await w.append('tool-decision', { tool: 'nmap', decision: 'allow' });
    await w.append('session-end', { session: 'a' });

    // Tamper line 2: rewrite the `hash` field with a wrong value
    // (and also rewrite the `prevHash` so the chain check passes
    // there — the recomputed-hash check is what should catch it).
    const logPath = join(dir, 'audit.jsonl');
    const lines = readFileSync(logPath, 'utf8').split('\n').filter((l) => l.length > 0);
    const ev2 = JSON.parse(lines[1]!) as AuditEvent;
    const ev2Tampered = { ...ev2, hash: 'a'.repeat(64) };
    lines[1] = JSON.stringify(ev2Tampered);
    writeFileSync(logPath, lines.join('\n') + '\n');

    const r = verifyAuditLog(logPath, key);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.brokenAt).toBe(2);
      expect(r.recorded).toBe('a'.repeat(64));
      expect(r.computed).not.toBe('a'.repeat(64));
      // The verifier counts `eventCount` on the failure branch as
      // the number of the broken line (i.e. how many lines it
      // touched before it bailed — including the broken one). That
      // matches `brokenAt`.
      expect(r.eventCount).toBe(2);
    }
  });

  it('returns ok=false when the key is wrong (every hash mismatches)', async () => {
    dir = scratchDir();
    const goodKey = randomBytes(32);
    const badKey = randomBytes(32);
    const w = await makeWriter(dir, goodKey);
    await w.append('session-start', { session: 'a' });
    await w.append('tool-decision', { tool: 'nmap', decision: 'allow' });

    const r = verifyAuditLog(join(dir, 'audit.jsonl'), badKey);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // First line is the one that breaks (its `prevHash` matches
      // GENESIS, so the chain check passes; its `hash` doesn't
      // recompute).
      expect(r.brokenAt).toBe(1);
    }
  });
});

describe('readAuditLog', () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('returns all events most-recent-first with no filters', async () => {
    dir = scratchDir();
    const key = randomBytes(32);
    const w = await makeWriter(dir, key);
    await w.append('session-start', { session: 'a' });
    await w.append('tool-decision', { tool: 'nmap', decision: 'allow' });
    await w.append('session-end', { session: 'a' });

    const rows = readAuditLog(join(dir, 'audit.jsonl'));
    expect(rows).toHaveLength(3);
    expect(rows[0]!.event.kind).toBe('session-end');
    expect(rows[1]!.event.kind).toBe('tool-decision');
    expect(rows[2]!.event.kind).toBe('session-start');
    // Lines are 1-based in the result
    expect(rows[0]!.line).toBe(3);
    expect(rows[2]!.line).toBe(1);
  });

  it('filters by event kind', async () => {
    dir = scratchDir();
    const key = randomBytes(32);
    const w = await makeWriter(dir, key);
    await w.append('session-start', { session: 'a' });
    await w.append('tool-decision', { tool: 'nmap', decision: 'allow' });
    await w.append('tool-decision', { tool: 'gobuster', decision: 'deny' });
    await w.append('session-end', { session: 'a' });

    const rows = readAuditLog(join(dir, 'audit.jsonl'), {
      kinds: ['tool-decision'],
    });
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r.event.kind).toBe('tool-decision');
  });

  it('applies limit after reverse-sort (most recent N)', async () => {
    dir = scratchDir();
    const key = randomBytes(32);
    const w = await makeWriter(dir, key);
    for (let i = 0; i < 5; i++) {
      await w.append('session-start', { session: `s${i}` });
    }
    const rows = readAuditLog(join(dir, 'audit.jsonl'), { limit: 2 });
    expect(rows).toHaveLength(2);
    // The last two appended are most-recent → should be the first two
    // in the result. The payload.session distinguishes them.
    expect((rows[0]!.event.payload as { session: string }).session).toBe('s4');
    expect((rows[1]!.event.payload as { session: string }).session).toBe('s3');
  });
});

describe('tailAuditLog', () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('emits new lines as they are appended', async () => {
    dir = scratchDir();
    const key = randomBytes(32);
    const w = await makeWriter(dir, key);
    const logPath = join(dir, 'audit.jsonl');

    const seen: string[] = [];
    let stop = false;
    // Start the tailer *before* the first append. The tailer
    // initializes `offset = st.size` at construction time, so any
    // bytes already on disk at that point are skipped — that's the
    // expected tail-following behavior (only show me *new* lines).
    const tailer = tailAuditLog(
      logPath,
      (line) => {
        seen.push(line);
      },
      { pollMs: 25, shouldStop: () => stop },
    );
    // Give the tailer a tick to enter its loop
    await new Promise((r) => setTimeout(r, 30));
    // Append two events; the tailer should pick both up across
    // subsequent polls.
    await w.append('session-start', { session: 'a' });
    await w.append('session-end', { session: 'a' });
    // Wait long enough for at least one more poll to drain the new bytes
    await new Promise((r) => setTimeout(r, 100));
    stop = true;
    await tailer;

    expect(seen).toHaveLength(2);
    // Both lines should be valid JSON
    for (const s of seen) {
      expect(() => JSON.parse(s) as unknown).not.toThrow();
    }
    // Order is the on-disk order: session-start, then session-end
    const parsed = seen.map((s) => JSON.parse(s) as AuditEvent);
    expect(parsed[0]!.kind).toBe('session-start');
    expect(parsed[1]!.kind).toBe('session-end');
  });
});
