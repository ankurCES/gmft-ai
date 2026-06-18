/**
 * v0.3.C follow-up — Audit chain head reader.
 *
 * The StatusRail shows an "audit #N ✓" / "audit #N ✗ broken"
 * breadcrumb. The reader does NOT do a full chain verify
 * (that's `gmft audit verify`); it only inspects the last line
 * of the log to report a count + parse validity.
 *
 * Why "last line" and not "walk the chain":
 *   - The breadcrumb is a snapshot of the chain *head* — the
 *     tail-hash + count of events so far. It's read once at
 *     AgentApp mount and re-rendered; live tailing would be
 *     expensive and the AuditLogTab is the right place for
 *     that.
 *   - A full verify walks every line and recomputes every
 *     HMAC. Doing that on every StatusRail render would couple
 *     TUI latency to log size. The reader intentionally
 *     reports the count from the last parseable line and a
 *     `broken: true` flag if the last line doesn't parse —
 *     that's enough signal for the breadcrumb. Operators who
 *     suspect tampering should run `gmft audit verify` (which
 *     is in the CLI surface and walks the whole chain).
 *
 * Behavior:
 *   - File missing / empty → `{ count: 0, broken: false }`
 *     (no audit yet; the rail renders nothing because the
 *      AgentApp gate merges this into `auditChain?: ...`).
 *   - File has N parseable lines → `{ count: N, broken: false }`
 *   - Last line malformed → `{ count: N-1, broken: true }`
 *     (count excludes the bad line so the user can see "the
 *      last good line is N-1, and the Nth is broken").
 *   - Audit disabled (env var) → `{ count: 0, broken: false }`
 *     regardless of file state. Mirrors `makeAuditSink`'s
 *     behavior so the breadcrumb agrees with the decorator.
 *
 * The reader is sync because the StatusRail mount path is
 * sync (React `useEffect`). A 1 MB audit log is sub-ms to
 * read on a healthy disk; if the log grows to 100 MB this
 * becomes the right place to switch to a streaming tail.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { configDir } from '../config/config.js';
import { AUDIT_DIRNAME, AUDIT_LOG_FILENAME } from './paths.js';

export interface AuditChainHead {
  /** Number of well-formed events in the log. 0 when missing/empty. */
  count: number;
  /**
   * `true` if the last line of the file failed to parse. The
   * breadcrumb renders `#N ✗ broken` so the user knows the
   * tail is corrupt without forcing a full chain verify on
   * every TUI mount.
   */
  broken: boolean;
}

/**
 * Read the audit chain head from `<configDir>/gmft/audit/audit.jsonl`.
 * Honors `GMFT_DISABLE_AUDIT_LOG=true` (returns a zero head —
 * the rail renders nothing because `auditChain` is absent
 * downstream).
 */
export function readAuditChainHead(env: NodeJS.ProcessEnv = process.env): AuditChainHead {
  if (env.GMFT_DISABLE_AUDIT_LOG === 'true') {
    return { count: 0, broken: false };
  }
  const logPath = join(configDir(), 'gmft', AUDIT_DIRNAME, AUDIT_LOG_FILENAME);
  if (!existsSync(logPath)) {
    return { count: 0, broken: false };
  }
  let text: string;
  try {
    text = readFileSync(logPath, 'utf8');
  } catch {
    // EACCES, EISDIR, etc. — treat as broken (file present but unreadable).
    return { count: 0, broken: true };
  }
  const lines = text.split('\n').filter((l) => l.length > 0);
  if (lines.length === 0) return { count: 0, broken: false };
  // Walk forward from the start of the file. The hash chain is
  // append-only — the first malformed line breaks every later
  // verification, so we count the well-formed prefix and flag
  // broken iff the suffix isn't empty + well-formed.
  let count = 0;
  let broken = false;
  for (const line of lines) {
    try {
      // We don't need the full event shape — just enough to know
      // the line is JSON. The hash field is the minimum structural
      // invariant of an audit event (see types.ts).
      const obj = JSON.parse(line) as { hash?: unknown };
      if (typeof obj.hash !== 'string') {
        broken = true;
        break;
      }
      count++;
    } catch {
      broken = true;
      break;
    }
  }
  return { count, broken };
}
