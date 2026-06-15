/**
 * Tests for the audit.jsonl writer. The writer is the on-disk primitive:
 * if it doesn't serialize concurrent appends, drop the chain link, or
 * set the right file mode, the verifier (Task 5) can't trust anything.
 *
 * Test count: 4 (per v0.3.C plan §C.1.2)
 *   1. append() first event: 1 line on disk, prevHash = GENESIS
 *   2. append() second event: prevHash = first event's hash, hashes chain
 *   3. 50 concurrent appends produce 50 sequential events with a valid chain
 *   4. file mode is 0600 after append()
 *
 * Note: tests use a fixed `now()` to make hashes deterministic, and
 * inject a known 32-byte key so the test can also recompute hashes
 * end-to-end (defense in depth — if `computeHash` or the writer's
 * call site drifts, this fails loudly).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AuditWriter,
  AUDIT_LOG_FILENAME,
} from '../src/audit/writer.js';
import { computeHash, GENESIS_PREV_HASH } from '../src/audit/types.js';

let dir = '';
let KEY: Buffer;
let clock: { t: number };
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gmft-audit-writer-'));
  KEY = Buffer.from('a'.repeat(64), 'hex'); // 32 bytes of 0xaa
  clock = { t: 1_700_000_000_000 }; // 2023-11-14T22:13:20.000Z
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Tests inject a fake `now` so ts is deterministic. The date string
 *  format follows `new Date(ms).toISOString()` — "2023-11-14T22:13:20.000Z" */
function tickIso() {
  return new Date(clock.t).toISOString();
}

describe('audit/writer — AuditWriter', () => {
  it('first append: 1 line, prevHash = GENESIS', async () => {
    const w = new AuditWriter({ auditDir: dir, key: KEY, now: tickIso });
    const ev = await w.append('session-start', { mode: 'interactive' });
    expect(ev.ts).toBe('2023-11-14T22:13:20.000Z');
    expect(ev.kind).toBe('session-start');
    expect(ev.prevHash).toBe(GENESIS_PREV_HASH);
    expect(ev.hash).toHaveLength(64);

    const lines = readFileSync(w.path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.ts).toBe(ev.ts);
    expect(parsed.hash).toBe(ev.hash);
  });

  it('second append: prevHash = first hash, chain link is correct', async () => {
    const w = new AuditWriter({ auditDir: dir, key: KEY, now: tickIso });
    const ev1 = await w.append('session-start', { mode: 'interactive' });
    clock.t += 1000;
    const ev2 = await w.append('tool-call', { tool: 'nmap_scan' });

    expect(ev2.prevHash).toBe(ev1.hash);

    // Recompute both hashes from the canonical form — if the writer
    // mutated the event before hashing, this fails.
    const re1 = computeHash(
      { ts: ev1.ts, kind: ev1.kind, prevHash: ev1.prevHash, payload: ev1.payload },
      KEY,
    );
    const re2 = computeHash(
      { ts: ev2.ts, kind: ev2.kind, prevHash: ev2.prevHash, payload: ev2.payload },
      KEY,
    );
    expect(re1).toBe(ev1.hash);
    expect(re2).toBe(ev2.hash);

    // Both lines are on disk
    const lines = readFileSync(w.path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
  });

  it('50 concurrent appends produce 50 sequential events with a valid chain', async () => {
    const w = new AuditWriter({ auditDir: dir, key: KEY, now: tickIso });
    const promises: Promise<unknown>[] = [];
    for (let i = 0; i < 50; i++) {
      clock.t += 1;
      promises.push(w.append('tool-result', { i }));
    }
    const events = await Promise.all(promises);
    expect(events).toHaveLength(50);

    // Every event's prevHash must equal the previous event's hash
    // (or GENESIS for the first).
    for (let i = 0; i < events.length; i++) {
      const ev = events[i] as { prevHash: string; hash: string };
      if (i === 0) {
        expect(ev.prevHash).toBe(GENESIS_PREV_HASH);
      } else {
        expect(ev.prevHash).toBe((events[i - 1] as { hash: string }).hash);
      }
    }

    // 50 lines on disk
    const lines = readFileSync(w.path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(50);
  });

  it('file mode is 0600 after first append', async () => {
    const w = new AuditWriter({ auditDir: dir, key: KEY, now: tickIso });
    await w.append('session-start', { mode: 'interactive' });
    const mode = statSync(join(dir, AUDIT_LOG_FILENAME)).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
