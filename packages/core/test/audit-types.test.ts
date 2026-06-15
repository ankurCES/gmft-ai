/**
 * Tests for the audit canonical form + hash computation. The hash chain
 * is the security primitive of v0.3.C — if `canonicalForm` is not stable
 * or `computeHash` is not deterministic, the verifier can't detect
 * tampering. These tests are the contract.
 *
 * Test count: 3 (per v0.3.C plan §C.1.1)
 *   1. canonical() is stable across payload key-order permutations
 *   2. computeHash() for a known input matches a hand-computed vector
 *   3. chain semantics: line 2's prevHash equals line 1's hash
 */

import { describe, it, expect } from 'vitest';
import {
  canonicalForm,
  computeHash,
  GENESIS_PREV_HASH,
  type AuditEventKind,
} from '../src/audit/types.js';

describe('audit/types — canonical form', () => {
  it('produces stable output regardless of payload key order', () => {
    const base = {
      ts: '2026-06-17T19:23:45.123Z',
      kind: 'tool-call' as AuditEventKind,
      prevHash: GENESIS_PREV_HASH,
      payload: { tool: 'rustscan_scan', target: '10.0.0.1', flags: ['destructive'] } as Record<string, unknown>,
    };
    // Same logical event, payload keys inserted in different order
    const reordered = {
      ...base,
      payload: { flags: ['destructive'], target: '10.0.0.1', tool: 'rustscan_scan' },
    };
    expect(canonicalForm(base)).toBe(canonicalForm(reordered));
  });

  it('recurses into nested objects and arrays when sorting', () => {
    const a = canonicalForm({
      ts: '2026-06-17T00:00:00.000Z',
      kind: 'tool-result' as AuditEventKind,
      prevHash: GENESIS_PREV_HASH,
      payload: {
        outer: { z: 1, a: { y: 2, b: 3 } },
        list: [{ q: 4, p: 5 }, { n: 6 }],
      },
    });
    const b = canonicalForm({
      ts: '2026-06-17T00:00:00.000Z',
      kind: 'tool-result' as AuditEventKind,
      prevHash: GENESIS_PREV_HASH,
      payload: {
        list: [{ p: 5, q: 4 }, { n: 6 }],
        outer: { a: { b: 3, y: 2 }, z: 1 },
      },
    });
    expect(a).toBe(b);
  });
});

describe('audit/types — computeHash + chain', () => {
  // Deterministic test key — 32 zero bytes. Real keys are random; for
  // vector tests, "the key" is the seed of the digest, not a secret.
  const KEY = Buffer.alloc(32, 0);

  it('computeHash matches a hand-computed HMAC-SHA-256 vector', () => {
    // Hand-computed once with:
    //   node -e 'console.log(require("crypto").createHmac("sha256", Buffer.alloc(32,0)).update("<canonical>").digest("hex"))'
    // The canonical form for this event is:
    //   {"kind":"tool-call","payload":{"target":"10.0.0.1","tool":"rustscan_scan"},"prevHash":"000…0","ts":"2026-06-17T00:00:00.000Z"}
    const hash = computeHash(
      {
        ts: '2026-06-17T00:00:00.000Z',
        kind: 'tool-call',
        prevHash: GENESIS_PREV_HASH,
        payload: { tool: 'rustscan_scan', target: '10.0.0.1' },
      },
      KEY,
    );
    // Pre-computed via:
    //   node -e 'const c=require("crypto");const evt={ts:"2026-06-17T00:00:00.000Z",kind:"tool-call",prevHash:"0".repeat(64),payload:{tool:"rustscan_scan",target:"10.0.0.1"}};function sortKeys(v){if(Array.isArray(v))return v.map(sortKeys);if(v!==null&&typeof v==="object"){const s={};for(const k of Object.keys(v).sort())s[k]=sortKeys(v[k]);return s;}return v;}const canonical=JSON.stringify(sortKeys({ts:evt.ts,kind:evt.kind,prevHash:evt.prevHash,payload:evt.payload}));console.log(c.createHmac("sha256",Buffer.alloc(32,0)).update(canonical).digest("hex"))'
    // canonical = {"kind":"tool-call","payload":{"target":"10.0.0.1","tool":"rustscan_scan"},"prevHash":"000…0","ts":"2026-06-17T00:00:00.000Z"}
    // If canonicalForm or HMAC semantics change, this test fails loudly.
    expect(hash).toBe('6cd6b39852ab4ec4fa26ce150f7eb79589f5fdfdae65750499d1dab9096238e0');
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('line 2 prevHash equals line 1 hash (chain semantics)', () => {
    const ev1 = {
      ts: '2026-06-17T00:00:00.000Z',
      kind: 'session-start' as AuditEventKind,
      prevHash: GENESIS_PREV_HASH,
      payload: { mode: 'interactive' },
    };
    const hash1 = computeHash(ev1, KEY);

    const ev2 = {
      ts: '2026-06-17T00:00:01.000Z',
      kind: 'tool-call' as AuditEventKind,
      prevHash: hash1, // ← the chain link
      payload: { tool: 'nmap_scan' },
    };
    const hash2 = computeHash(ev2, KEY);

    expect(ev2.prevHash).toBe(hash1);
    expect(hash1).not.toBe(hash2);
    // And tampering with ev1's payload changes hash1 but not hash2
    // (because hash2 is keyed off ev2 only — the chain link is the
    // explicit prevHash, not a transitive recompute). That's the
    // verifier's job (Task 5), not ours here. We only assert the
    // link is correct.
  });
});
