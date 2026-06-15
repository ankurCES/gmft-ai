/**
 * Tests for audit HMAC key management. The key is the security
 * primitive — if it leaks the chain is forgeable; if it's lost the
 * chain is unverifiable. These tests guard the lifecycle.
 *
 * Test count: 2 (per v0.3.C plan §C.1.3)
 *   1. First-run: getOrCreateHmacKey generates a 32-byte key, file mode 0600,
 *      re-call returns the same key
 *   2. Backup round-trip: backup, delete disk file, ensureHmacKey restores
 *      from the secret store
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getOrCreateHmacKey,
  auditKeyMode,
  HMAC_KEY_FILENAME,
  backupHmacKey,
  ensureHmacKey,
  SECRET_KEY_NAME,
} from '../src/audit/key.js';

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gmft-audit-key-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A minimal in-memory SecretStore for tests, matching the subset of
 *  the production SecretStore interface that key.ts depends on. */
function memoryStore() {
  const m = new Map<string, string>();
  return {
    async get(k: string) { return m.get(k) ?? null; },
    async set(k: string, v: string) { m.set(k, v); },
  };
}

describe('audit/key — getOrCreateHmacKey', () => {
  it('first-run generates a 32-byte key, writes file mode 0600, re-call is stable', () => {
    const path = join(dir, HMAC_KEY_FILENAME);
    expect(existsSync(path)).toBe(false);

    const key1 = getOrCreateHmacKey({ auditDir: dir });
    expect(key1).toHaveLength(32);
    expect(auditKeyMode(dir)).toBe(0o600);

    // File on disk is the hex form, 64 chars + trailing newline
    const onDisk = readFileSync(path, 'utf8');
    expect(onDisk.trim()).toBe(key1.toString('hex'));
    expect(onDisk.trim()).toHaveLength(64);

    // Re-call returns the same key (not a new one)
    const key2 = getOrCreateHmacKey({ auditDir: dir });
    expect(key2.equals(key1)).toBe(true);
  });

  it('backup round-trip: delete disk file, ensureHmacKey restores from store', async () => {
    const path = join(dir, HMAC_KEY_FILENAME);
    const store = memoryStore();

    // First-run: getOrCreateHmacKey generates a key
    const key1 = getOrCreateHmacKey({ auditDir: dir });
    expect(existsSync(path)).toBe(true);

    // Backup to the (in-memory) secret store
    await backupHmacKey(key1, store);
    expect(await store.get(SECRET_KEY_NAME)).toBe(key1.toString('hex'));

    // Simulate "user deleted audit.key by accident" — nuke the disk file
    rmSync(path);
    expect(existsSync(path)).toBe(false);

    // ensureHmacKey should restore from the store and rehydrate the disk file
    const restored = await ensureHmacKey(dir, store);
    expect(restored.source).toBe('store');
    expect(restored.key.equals(key1)).toBe(true);
    expect(existsSync(path)).toBe(true);
    expect(auditKeyMode(dir)).toBe(0o600);
    expect(readFileSync(path, 'utf8').trim()).toBe(key1.toString('hex'));
  });
});
