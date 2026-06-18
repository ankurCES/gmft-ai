/**
 * v0.3.C — HMAC key management for the audit log.
 *
 * The audit chain is HMAC-SHA-256, not bare SHA-256, so the key is part of
 * the security model. We keep two copies:
 *
 *   1. On disk at `<audit-dir>/audit.key` (mode 0600, 32 random bytes hex).
 *      This is the writer's hot path — opening the file is one syscall,
 *      and we don't need to round-trip through a crypto library every event.
 *   2. Backed up to the existing SecretStore (envfile or keytar backend)
 *      under the key name `audit.hmac_key`. This is the recovery path:
 *      if the user moves machines, re-installs, or accidentally deletes
 *      `audit.key`, we can rebuild the chain verifier from the backup.
 *
 * The auto-backup is fire-and-forget on first generation. We do NOT block
 * the first event on a successful backup — if keytar is locked or the
 * envfile is unwritable, the disk key is still created and the chain
 * keeps working; verification just won't survive a disk-key-only
 * reinstall until the user fixes the secret store. The plan's Open
 * Question #2 resolved this: "HMAC key auto-backup: yes, default."
 *
 * The secret store reuse is in `packages/core/src/config/secrets.ts`
 * (the `createSecretStore` factory). The store's `set(key, value)` is
 * async because the keytar backend is async; the envfile backend is
 * sync-but-async-shaped.
 *
 * Test count: 2 (per v0.3.C plan §C.1.3)
 *   1. First-run: getOrCreateHmacKey generates 32 bytes, mode 0600, stable on re-read
 *   2. Backup round-trip: backup, delete disk key, getOrCreateHmacKey restores from store
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, openSync, closeSync, fsyncSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';

export const HMAC_KEY_FILENAME = 'audit.key';
/** Name under which the hex-encoded key is stored in the SecretStore. */
export const SECRET_KEY_NAME = 'audit.hmac_key';

/** 32 bytes = 256 bits, the natural HMAC-SHA-256 key size. */
const KEY_BYTES = 32;

export interface AuditKeyOpts {
  /** Directory holding the audit log + the key file. */
  auditDir: string;
  /**
   * Optional pre-existing key. When provided, the writer uses it
   * instead of generating one. Used by tests to inject a known key
   * for vector verification (the `types.test.ts` HMAC vector).
   */
  key?: Buffer;
}

/**
 * Returns the 32-byte HMAC key, creating the on-disk file if needed.
 * Idempotent: re-calls return the same key. The returned buffer is
 * safe to keep — the writer holds it for the lifetime of the process.
 *
 * The key is stored as 64 lowercase hex chars in the file. We use
 * hex (not raw bytes) so the file is text-friendly: `cat audit.key`
 * shows the secret, the file diffs cleanly in git (if it ever leaks
 * in), and the secret store can hold it as a plain string.
 */
export function getOrCreateHmacKey(opts: AuditKeyOpts): Buffer {
  const path = join(opts.auditDir, HMAC_KEY_FILENAME);
  if (opts.key) {
    return opts.key;
  }
  if (existsSync(path)) {
    const hex = readFileSync(path, 'utf8').trim();
    return Buffer.from(hex, 'hex');
  }
  // First-run generation. Same fsync+chmod pattern as secrets.ts:62-70
  // to avoid the kernel-reordering page-cache-flush-vs-inode-update bug.
  const key = randomBytes(KEY_BYTES);
  mkdirSync(opts.auditDir, { recursive: true });
  const fd = openSync(path, 'w');
  try {
    writeFileSync(fd, key.toString('hex') + '\n');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(path, 0o600);
  return key;
}

/**
 * Verifies the on-disk key file has mode 0600. Returns the mode bits
 * (e.g. `0o600`) so the writer's test can assert the exact value. The
 * `statSync` mode is the lower 9 bits of the `st_mode` field; the rest
 * is the file type. We mask with `0o777` to extract the permission bits.
 */
export function auditKeyMode(auditDir: string): number {
  return statSync(join(auditDir, HMAC_KEY_FILENAME)).mode & 0o777;
}

/**
 * Backup the key to the secret store. Fire-and-forget on the writer's
 * hot path — failures are non-fatal because the on-disk key is the
 * primary. We return the promise so the writer can `await` it once
 * after first generation (the writer's mutex serializes this).
 *
 * The SecretStore API is async even when the envfile backend is sync
 * (see secrets.ts:73). The interface is uniform across backends, which
 * is why we keep the async signature here.
 */
export async function backupHmacKey(key: Buffer, store: { set: (k: string, v: string) => Promise<void> }): Promise<void> {
  await store.set(SECRET_KEY_NAME, key.toString('hex'));
}

/**
 * Restore the key from the secret store. Returns null if the store
 * doesn't have it (first-run case, or the user has never had a
 * working backup). The writer should fall back to generating a new
 * key in that case — that's how a fresh install seeds the chain.
 */
export async function restoreHmacKey(
  store: { get: (k: string) => Promise<string | null> },
): Promise<Buffer | null> {
  const hex = await store.get(SECRET_KEY_NAME);
  if (!hex) return null;
  return Buffer.from(hex, 'hex');
}

/**
 * High-level convenience for the writer: get the key from disk, OR
 * restore from the store if the disk file is missing, OR generate a
 * new one and write it to disk. The store-restore branch also
 * re-writes the disk file so subsequent reads are local.
 */
export async function ensureHmacKey(
  auditDir: string,
  store: { get: (k: string) => Promise<string | null>; set: (k: string, v: string) => Promise<void> },
): Promise<{ key: Buffer; source: 'disk' | 'store' | 'generated' }> {
  const path = join(auditDir, HMAC_KEY_FILENAME);
  if (existsSync(path)) {
    return { key: getOrCreateHmacKey({ auditDir }), source: 'disk' };
  }
  const restored = await restoreHmacKey(store);
  if (restored) {
    // Rehydrate the on-disk file. The store is the source of truth;
    // the disk file is a hot-path cache. We must mkdir+write+chmod
    // the same way the first-run path does, so the file is present
    // for the next process. (If the user re-installs from a backup,
    // they need this to "just work".)
    mkdirSync(dirname(path), { recursive: true });
    const fd = openSync(path, 'w');
    try {
      writeFileSync(fd, restored.toString('hex') + '\n');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(path, 0o600);
    return { key: restored, source: 'store' };
  }
  return { key: getOrCreateHmacKey({ auditDir }), source: 'generated' };
}
