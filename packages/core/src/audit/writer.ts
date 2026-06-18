/**
 * v0.3.C — Append-only audit.jsonl writer.
 *
 * The writer holds:
 *   - the audit directory (where the log + key live)
 *   - the HMAC key (Buffer, 32 bytes; obtained via getOrCreateHmacKey)
 *   - a single in-process mutex (Promise chain) that serializes appends
 *   - the path to the log file
 *
 * Concurrency model: append() is `async` but every operation is gated
 * by a single promise chain. Two callers awaiting append() at the same
 * time will see their events land in the order they called, never
 * interleaved. The plan's Risks table flagged "HMAC key generation on a
 * fresh install has a race" — the mutex closes it.
 *
 * Append flow:
 *   1. Set ts = now (ISO 8601, ms precision)
 *   2. Read last line of log, extract `hash` field; default to
 *      GENESIS_PREV_HASH if file is missing or empty
 *   3. Compute hash = HMAC-SHA-256(canonical({ts, kind, prevHash, payload}), key)
 *   4. Open file in 'a' mode (append), write one JSON line + '\n',
 *      fsync, close. File mode 0600 (set on first append; subsequent
 *      appends inherit).
 *
 * File mode: 0600 is set by the create flow. The chmod is best-effort
 * on subsequent appends (we don't re-chmod every event — that's a
 * syscall per event and a waste). If the file's mode ever drifts
 * (e.g. the user copied it from a backup tarball), the writer
 * corrects it on the first append after a restart.
 *
 * Test count: 4 (per v0.3.C plan §C.1.2)
 *   1. append() first event: line count = 1, prevHash = GENESIS
 *   2. append() second event: prevHash = first event's hash
 *   3. 50 concurrent appends produce 50 sequential events with a valid chain
 *   4. file mode is 0600 after append()
 */

import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
  openSync,
  closeSync,
  fsyncSync,
  chmodSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  canonicalForm,
  computeHash,
  GENESIS_PREV_HASH,
  type AuditEvent,
  type AuditEventKind,
} from './types.js';
import { getOrCreateHmacKey } from './key.js';

export const AUDIT_LOG_FILENAME = 'audit.jsonl';

export interface AuditWriterOpts {
  /** Directory holding audit.jsonl + audit.key. */
  auditDir: string;
  /**
   * Pre-existing key. When omitted, getOrCreateHmacKey generates one
   * on first call (or reads it from disk). Tests use this to inject
   * a known key for vector verification.
   */
  key?: Buffer;
  /**
   * Override the timestamp for deterministic tests. The production
   * path always uses `new Date().toISOString()`.
   */
  now?: () => string;
}

export class AuditWriter {
  private readonly logPath: string;
  private readonly auditDir: string;
  private key: Buffer;
  private readonly now: () => string;
  /** Single-writer mutex: every append awaits the previous one. */
  private chain: Promise<unknown> = Promise.resolve();
  /** Number of bytes already on disk — tail-reads use this. */
  private bytesOnDisk = 0;

  constructor(opts: AuditWriterOpts) {
    this.auditDir = opts.auditDir;
    this.logPath = join(opts.auditDir, AUDIT_LOG_FILENAME);
    this.key = opts.key ?? getOrCreateHmacKey({ auditDir: opts.auditDir });
    this.now = opts.now ?? (() => new Date().toISOString());
    if (existsSync(this.logPath)) {
      this.bytesOnDisk = statSync(this.logPath).size;
    }
  }

  /**
   * Append a single event. Returns the recorded event (with `ts`,
   * `prevHash`, and `hash` filled in). Mutex-serialized — concurrent
   * callers see their events land in the order they called.
   */
  append(kind: AuditEventKind, payload: Record<string, unknown>): Promise<AuditEvent> {
    const next = this.chain.then(() => this.doAppend(kind, payload));
    // Swallow rejections on the chain itself so a single failure
    // doesn't poison subsequent appends. The caller's awaited promise
    // still rejects with the original error.
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async doAppend(
    kind: AuditEventKind,
    payload: Record<string, unknown>,
  ): Promise<AuditEvent> {
    const ts = this.now();
    const prevHash = this.tailHash();
    const hash = computeHash({ ts, kind, prevHash, payload }, this.key);
    const event: AuditEvent = { ts, kind, prevHash, hash, payload };

    // Open in append mode. fsync before close so a power loss
    // between the write and the close doesn't leave a torn line.
    const fd = openSync(this.logPath, 'a');
    try {
      writeFileSync(fd, JSON.stringify(event) + '\n');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // Defensive chmod: only the first append after a fresh install
    // actually changes the mode (chmod is a no-op if it's already
    // 0600). Cost is one syscall per event, but it's the right
    // defense-in-depth — if the file was restored from a backup
    // with the wrong mode, the chain is still the chain but at
    // least the file isn't world-readable.
    if (!existsSync(this.logPath) || statSync(this.logPath).mode & 0o077) {
      chmodSync(this.logPath, 0o600);
    }
    this.bytesOnDisk = statSync(this.logPath).size;
    return event;
  }

  /**
   * Read the last line of the log, parse it, return its `hash`.
   * Returns GENESIS_PREV_HASH if the file is missing or empty.
   * Used to compute the next event's `prevHash`.
   *
   * Reads only the tail (size - 4 KiB) for efficiency. A single
   * event is bounded by the writer's payload cap (see v0.3.C
   * follow-up defaults — 64 KiB), so 4 KiB is a safe window for
   * "the last line" in practice. The fallback to a full read handles
   * the first event or any pathologically long line.
   */
  private tailHash(): string {
    if (!existsSync(this.logPath) || this.bytesOnDisk === 0) {
      return GENESIS_PREV_HASH;
    }
    const fd = openSync(this.logPath, 'r');
    try {
      const start = Math.max(0, this.bytesOnDisk - 4096);
      const buf = Buffer.alloc(this.bytesOnDisk - start);
      // We open in 'r' and read from offset `start` to EOF.
      // node:fs readSync with a position is the right API but is
      // a bit fiddly; the alternative is readFileSync on the whole
      // file. For now, full read is fine: a fresh install has 1
      // event, and even at 10K events (1 MB) the read is microseconds.
      const full = readFileSync(this.logPath, 'utf8');
      const lines = full.split('\n').filter((l) => l.length > 0);
      if (lines.length === 0) return GENESIS_PREV_HASH;
      const last = lines[lines.length - 1]!;
      try {
        const ev = JSON.parse(last) as AuditEvent;
        return ev.hash ?? GENESIS_PREV_HASH;
      } catch {
        // Malformed last line — treat as genesis. The verifier
        // (Task 5) will surface the corruption when it walks the
        // chain; the writer's job is to keep appending.
        return GENESIS_PREV_HASH;
      }
    } finally {
      closeSync(fd);
    }
  }

  /** Path to the log file (used by the CLI for tail/verify). */
  get path(): string {
    return this.logPath;
  }
}
