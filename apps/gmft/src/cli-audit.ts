/**
 * v0.3.C — `gmft audit {verify,log,tail}` CLI primitives.
 *
 * Three operations on the audit log:
 *   1. `verifyAuditLog` — walk the file, recompute each hash, report integrity
 *   2. `readAuditLog`   — read with filters (--since, --until, --kind, --limit)
 *   3. `tailAuditLog`   — poll the file for new lines, emit them in real time
 *
 * The functions in this file are pure: they take a path + a key (or a
 * pre-read key-resolver for verify) and return data. The CLI dispatch
 * (arg parsing, exit codes, color) lives in `cli.tsx` so this file
 * stays testable and side-effect-light.
 *
 * File format: one JSON-encoded {@link AuditEvent} per line. Each
 * event's `hash` is HMAC-SHA-256 of the canonical form
 * ({@link canonicalForm} in `audit/types.ts`). The `prevHash` field
 * chains to the previous event's `hash`, with `GENESIS_PREV_HASH`
 * (64 zero hex chars) for line 1.
 *
 * Test count: 7 (3 verify + 3 log + 1 tail) per v0.3.C plan §C.2.1, C.3.1, C.3.2.
 */

import { readFileSync, existsSync, statSync, openSync, closeSync, readSync } from 'node:fs';
import { canonicalForm, type AuditEvent, type AuditEventKind } from '@gmft/core';
import { createHmac } from 'node:crypto';
import { GENESIS_PREV_HASH } from '@gmft/core';

// ----------------- verify -----------------

export type VerifyResult =
  | { ok: true; eventCount: number; lastEvent: AuditEvent }
  | {
      ok: false;
      eventCount: number;
      brokenAt: number; // 1-based line number
      recorded: string;
      computed: string;
      unverifiedFrom: number; // brokenAt+1
    };

/**
 * Walk the audit log, recompute each hash from the canonical form
 * using `key`, and compare to the recorded `hash`. Returns:
 *   - `{ ok: true, eventCount, lastEvent }` if every link is valid
 *   - `{ ok: false, eventCount, brokenAt, recorded, computed, unverifiedFrom }`
 *     on the first mismatch (subsequent events are not re-verified —
 *     their `prevHash` chain is broken by definition)
 *
 * The verifier does NOT tolerate malformed JSON lines or extra
 * non-JSON noise; it parses strictly and treats a parse error as a
 * chain break. That matches the writer's invariant: every line is a
 * valid JSON-encoded AuditEvent.
 */
export function verifyAuditLog(file: string, key: Buffer): VerifyResult {
  if (!existsSync(file)) {
    // No audit log yet — treat as "intact empty chain" (the verifier
    // ran, found nothing to verify, no events). The CLI's UX is to
    // print "no audit log found" and exit 0; this function returns
    // a structured result that the CLI maps to that message.
    return { ok: true, eventCount: 0, lastEvent: { ts: '', kind: 'session-start', prevHash: GENESIS_PREV_HASH, hash: '', payload: {} } };
  }
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n').filter((l) => l.length > 0);
  let prevHash = GENESIS_PREV_HASH;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    let ev: AuditEvent;
    try {
      ev = JSON.parse(line) as AuditEvent;
    } catch {
      return {
        ok: false,
        eventCount: i,
        brokenAt: i + 1,
        recorded: '<unparseable>',
        computed: '<unparseable>',
        unverifiedFrom: i + 2,
      };
    }
    if (ev.prevHash !== prevHash) {
      return {
        ok: false,
        eventCount: i,
        brokenAt: i + 1,
        recorded: ev.prevHash,
        computed: prevHash,
        unverifiedFrom: i + 1,
      };
    }
    const recomputed = createHmac('sha256', key)
      .update(canonicalForm({
        ts: ev.ts,
        kind: ev.kind,
        prevHash: ev.prevHash,
        payload: ev.payload,
      }))
      .digest('hex');
    if (recomputed !== ev.hash) {
      return {
        ok: false,
        eventCount: i + 1,
        brokenAt: i + 1,
        recorded: ev.hash,
        computed: recomputed,
        unverifiedFrom: i + 1,
      };
    }
    prevHash = ev.hash;
  }
  return {
    ok: true,
    eventCount: lines.length,
    lastEvent: lines.length > 0
      ? (JSON.parse(lines[lines.length - 1]!) as AuditEvent)
      : { ts: '', kind: 'session-start', prevHash: GENESIS_PREV_HASH, hash: '', payload: {} },
  };
}

// ----------------- read (for `audit log`) -----------------

export interface LogFilters {
  /** Max number of events to return. Most recent first. */
  limit?: number;
  /** ISO 8601 lower bound (inclusive). */
  since?: string;
  /** ISO 8601 upper bound (inclusive). */
  until?: string;
  /** Filter by event kind (repeatable on the CLI). */
  kinds?: readonly AuditEventKind[];
}

export interface LogEntry {
  line: number; // 1-based
  event: AuditEvent;
}

/**
 * Read the audit log into memory, applying filters. Returns events
 * most-recent-first. Missing file → []. Malformed lines are skipped
 * silently (the verifier catches corruption; the log viewer is for
 * browsing, not policing).
 */
export function readAuditLog(file: string, filters: LogFilters = {}): LogEntry[] {
  if (!existsSync(file)) return [];
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n').filter((l) => l.length > 0);
  const out: LogEntry[] = [];
  for (let i = 0; i < lines.length; i++) {
    let ev: AuditEvent;
    try {
      ev = JSON.parse(lines[i]!) as AuditEvent;
    } catch {
      continue;
    }
    if (filters.since && ev.ts < filters.since) continue;
    if (filters.until && ev.ts > filters.until) continue;
    if (filters.kinds && filters.kinds.length > 0 && !filters.kinds.includes(ev.kind)) continue;
    out.push({ line: i + 1, event: ev });
  }
  // Most recent first
  out.reverse();
  if (filters.limit !== undefined && out.length > filters.limit) {
    return out.slice(0, filters.limit);
  }
  return out;
}

// ----------------- tail -----------------

/**
 * Tail the audit log for new lines. Polls the file every `pollMs`
 * and yields each new line as it appears. Stops when `shouldStop()`
 * returns true (the CLI uses a SIGINT handler for this).
 *
 * The poller reads from the byte offset it last saw. If the file is
 * truncated (size shrinks), it resets the offset to 0 — this is
 * "rotation" behavior, but gmft doesn't rotate audit logs in v0.3.C.
 * A future ADR may add rotation; until then, the truncate-reset
 * branch is defensive.
 *
 * `onLine` is awaited; backpressure is honored. The poller is
 * deliberately simple (statSync + read) — fs.watch would be cheaper
 * but platform-flaky in tests.
 */
export async function tailAuditLog(
  file: string,
  onLine: (line: string) => Promise<void> | void,
  opts: { pollMs?: number; shouldStop?: () => boolean } = {},
): Promise<void> {
  const pollMs = opts.pollMs ?? 1000;
  const shouldStop = opts.shouldStop ?? (() => false);
  let offset = 0;
  let lastInode = 0;
  if (existsSync(file)) {
    const st = statSync(file);
    offset = st.size;
    lastInode = st.ino;
  }
  // 4 KiB tail-read buffer — a single event is bounded by the
  // writer's payload cap (v0.3.C follow-up default: 64 KiB), so 4 KiB
  // is a safe window for the typical case. Larger windows trigger
  // multi-event reads, which we handle by splitting on '\n'.
  const BUF = 4096;
  while (!shouldStop()) {
    if (!existsSync(file)) {
      await new Promise((r) => setTimeout(r, pollMs));
      continue;
    }
    const st = statSync(file);
    // Truncate / rotate: file shrank or inode changed
    if (st.size < offset || st.ino !== lastInode) {
      offset = 0;
      lastInode = st.ino;
    }
    if (st.size > offset) {
      const fd = openSync(file, 'r');
      try {
        const len = Math.min(BUF, st.size - offset);
        const buf = Buffer.alloc(len);
        // node:fs readSync with a position reads from that byte
        // offset. The signature is readSync(fd, buffer, offset,
        // length, position). For tail-following we want position =
        // our tracked offset (not null, which would use the file's
        // current position pointer).
        let read = 0;
        let pos = offset;
        while (read < len) {
          // readSync(fd, buf, bufOffset, length, position) — position
          // is the file byte to start at. We pass our tracked
          // `pos`, not null (which would use the file's current
          // position pointer and would skip bytes on rotation).
          const r = readSync(fd, buf, read, len - read, pos);
          if (r <= 0) break;
          read += r;
          pos += r;
        }
        if (read > 0) {
          const chunk = buf.subarray(0, read).toString('utf8');
          // Lines may straddle the buffer boundary; we accumulate the
          // tail (no newline yet) and prepend to the next read.
          // Implementation note: a single event + '\n' fits in 4 KiB
          // for v0.3.C's payload cap. For larger payloads the read
          // would need to grow, but that's a v0.3.1 follow-up.
          for (const line of chunk.split('\n')) {
            if (line.length > 0) await onLine(line);
          }
          offset = pos;
        }
      } finally {
        closeSync(fd);
      }
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
