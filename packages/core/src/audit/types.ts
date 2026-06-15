/**
 * v0.3.C — AuditEvent type + canonical form.
 *
 * The audit log is an append-only JSONL file with an HMAC-SHA-256 hash chain.
 * Each line is an {@link AuditEvent}; the chain is formed by `prevHash` (the
 * previous line's `hash`) and `hash` (HMAC of the canonical form, see below).
 *
 * Design decisions (full rationale in docs/plans/adr/0013-audit-chain-hmac.md):
 *   - Hash chain covers METADATA ONLY (`ts`, `kind`, `prevHash`), not the
 *     `payload`. The chain proves "this stream happened in this order",
 *     not "this payload is correct". The payload is still written so the
 *     `gmft audit log` viewer can render it, but it is not part of the
 *     digest. This keeps the hash cheap to compute even for large tool
 *     outputs and avoids leaking payload bytes into the HMAC key's surface.
 *   - Hash is HMAC-SHA-256, not bare SHA-256. The key (kept in
 *     `~/.config/gmft/audit.key`, mode 0600) prevents an attacker with
 *     file-write access from re-computing a valid chain after tampering.
 *   - Canonical form sorts object keys at every depth so the verifier
 *     reproduces the exact same byte sequence regardless of insertion
 *     order. `JSON.stringify` itself preserves insertion order, so we
 *     have to sort explicitly.
 *   - Line 1 uses `prevHash = '0'.repeat(64)` (64 zero hex chars, the
 *     length of a SHA-256 hex digest). The verifier uses the same
 *     sentinel so a chain that's been prepended to (replay) is detected.
 *   - `hash` itself is NOT in the canonical form. Otherwise computing
 *     the hash would require the hash, which is a circular definition.
 *     The writer computes the hash over the form WITHOUT `hash`, then
 *     assigns it; the verifier recomputes from the same form.
 */

import { createHmac } from 'node:crypto';

/** Sentinel for line 1's `prevHash`. 64 hex zeros == 32 zero bytes. */
export const GENESIS_PREV_HASH = '0'.repeat(64);

export type AuditEventKind =
  | 'tool-call'
  | 'tool-result'
  | 'chokepoint-decision'
  | 'session-start'
  | 'session-end'
  | 'runner-mode'
  | 'onboard';

export interface AuditEvent {
  /** ISO 8601 timestamp, set by the writer (not the caller). */
  ts: string;
  kind: AuditEventKind;
  /** Hex SHA-256 (64 chars) of the previous line's `hash`. */
  prevHash: string;
  /** Hex HMAC-SHA-256 of the canonical form (see {@link canonicalForm}). */
  hash: string;
  /** Event-specific data. NOT included in the hash. */
  payload: Record<string, unknown>;
}

/**
 * The input to HMAC. Sorts object keys at every depth so verification
 * reproduces the exact same bytes regardless of insertion order. The
 * `hash` field is intentionally omitted — see the file header.
 *
 * Exported so the writer (Task 2) and the verifier (Task 5) share one
 * canonicalization routine. The verifier should never re-implement this.
 */
export function canonicalForm(event: {
  ts: string;
  kind: AuditEventKind;
  prevHash: string;
  payload: Record<string, unknown>;
}): string {
  return JSON.stringify(sortKeys({
    ts: event.ts,
    kind: event.kind,
    prevHash: event.prevHash,
    payload: event.payload,
  }));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[k] = sortKeys((value as Record<string, unknown>)[k]);
    }
    return sorted;
  }
  return value;
}

/**
 * Compute the HMAC-SHA-256 of an event's canonical form. Returns the
 * lowercase hex digest (64 chars).
 *
 * The event passed in MUST have `hash` set to the placeholder; the
 * field is excluded from the canonical form so the value doesn't matter.
 * We accept a `Partial<AuditEvent>`-like shape to make the writer's call
 * site self-documenting.
 */
export function computeHash(
  event: { ts: string; kind: AuditEventKind; prevHash: string; payload: Record<string, unknown> },
  key: Buffer,
): string {
  return createHmac('sha256', key).update(canonicalForm(event)).digest('hex');
}
