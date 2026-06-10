import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FindingsStore, type Finding } from '../src/findings/store.js';

const sampleFinding: Finding = {
  id: '01HZX5K9P3Y8V2M4F6T8B0N7QC',
  tool: 'nmap',
  target: 'scanme.nmap.org',
  severity: 'medium',
  title: 'Open port 22/tcp (ssh)',
  description: 'SSH service exposed',
  evidence: '22/tcp open ssh OpenSSH 6.6.1p1',
  ts: 1700000000000,
};

describe('FindingsStore', () => {
  let dir: string;
  let store: FindingsStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gmft-findings-'));
    store = new FindingsStore({ sessionId: 'test-session', baseDir: dir });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('append + list roundtrips in memory', async () => {
    await store.append(sampleFinding);
    expect(store.list()).toEqual([sampleFinding]);
  });

  it('persists to JSONL on disk', async () => {
    await store.append(sampleFinding);
    const path = join(dir, 'test-session.jsonl');
    expect(existsSync(path)).toBe(true);
    const text = readFileSync(path, 'utf8');
    expect(text.endsWith('\n')).toBe(true); // trailing newline (read_line rule)
    const parsed = JSON.parse(text.trim());
    expect(parsed).toEqual(sampleFinding);
  });

  it('redacts secret-shaped values in evidence', async () => {
    await store.append({
      ...sampleFinding,
      evidence: 'curl -H "Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz1234567890" https://x',
    });
    const text = readFileSync(join(dir, 'test-session.jsonl'), 'utf8');
    expect(text).toContain('Authorization: [REDACTED]');
    expect(text).not.toContain('sk-abcdefghijklmnopqrstuvwxyz');
  });

  it('list() reloads from disk if baseDir is set on a fresh instance', async () => {
    await store.append(sampleFinding);
    const store2 = new FindingsStore({ sessionId: 'test-session', baseDir: dir });
    expect(store2.list()).toEqual([sampleFinding]);
  });

  it('list() returns [] when file does not exist', () => {
    expect(store.list()).toEqual([]);
  });
});
