/**
 * Tests for the `withAuditToolResult` decorator (v0.4-B.5).
 *
 * Test count: 4 (per v0.4-B plan §B.5)
 *   1. emits one tool-result event per yielded tool-result
 *   2. payload contains `redacted_fields` when AD hashes are present
 *      (secretsdump SAM → ntlm-hash; kerberoast TGS → kerberos-tgs);
 *      also covers the `output_redacted` field's redacted-string form
 *   3. non-tool-result events pass through unchanged AND do NOT trigger
 *      audit appends (text-delta, tool-call-request, done, error)
 *   4. truncation kicks in for outputs > MAX_TOOL_RESULT_OUTPUT_CHARS
 *
 * The fire-and-forget append is microtask-queued — the tests flush it
 * the same way `audit-supervisor.test.ts` does (Promise.resolve()
 * chained) so the assertions can read the captured calls synchronously
 * after the drain completes.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  withAuditToolResult,
  MAX_TOOL_RESULT_OUTPUT_CHARS,
} from '../src/audit/instrument.js';
import type { AuditSink } from '../src/audit/sink.js';
import type { AgentEvent } from '../src/agent/loop.js';

async function* fromArray<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item;
}

/** Drain an async iterable into an array, then flush the microtask queue
 * so any fire-and-forget `sink.append(...)` calls have landed in the
 * vi.fn() stub before the test inspects them. */
async function drainAndFlush(it: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of it) out.push(ev);
  // Three chained microtask flushes is the same pattern
  // `audit-supervisor.test.ts` uses — enough to drain any
  // `void sink.append(...).catch(...)` chain that the wrapper
  // emitted during the loop.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  return out;
}

describe('audit/instrument — withAuditToolResult (v0.4-B.5)', () => {
  it('emits one tool-result event per yielded tool-result', async () => {
    const append = vi.fn(async (_k: string, _p: Record<string, unknown>) => {});
    const sink: AuditSink = { append };

    const events: AgentEvent[] = [
      { type: 'text-delta', text: 'starting scan' },
      { type: 'tool-result', id: 'tr1', name: 'nmap_scan', ok: true, output: { hosts: 3 } },
      { type: 'tool-result', id: 'tr2', name: 'whois', ok: true, output: 'lookup complete' },
      { type: 'tool-result', id: 'tr3', name: 'sqlmap', ok: false, reason: 'user denied confirmation' },
      { type: 'done', text: 'turn complete' },
    ];

    const wrapped = withAuditToolResult(fromArray(events), sink);
    const out = await drainAndFlush(wrapped);

    // All 5 events must pass through in order, unchanged.
    expect(out).toHaveLength(5);
    expect(out.map((e) => e.type)).toEqual([
      'text-delta',
      'tool-result',
      'tool-result',
      'tool-result',
      'done',
    ]);

    // Exactly 3 audit appends (one per tool-result), all with kind
    // 'tool-result'.
    expect(append).toHaveBeenCalledTimes(3);
    for (const call of append.mock.calls) {
      expect(call[0]).toBe('tool-result');
    }

    // Inspect each payload.
    const p1 = append.mock.calls[0][1] as Record<string, unknown>;
    expect(p1.name).toBe('nmap_scan');
    expect(p1.ok).toBe(true);
    expect(p1.redacted_fields).toEqual([]);
    expect(p1.output_redacted).toBe('{"hosts":3}');

    const p2 = append.mock.calls[1][1] as Record<string, unknown>;
    expect(p2.name).toBe('whois');
    expect(p2.ok).toBe(true);
    expect(p2.redacted_fields).toEqual([]);
    expect(p2.output_redacted).toBe('"lookup complete"');

    const p3 = append.mock.calls[2][1] as Record<string, unknown>;
    expect(p3.name).toBe('sqlmap');
    expect(p3.ok).toBe(false);
    expect(p3.reason).toBe('user denied confirmation');
    expect(p3.redacted_fields).toEqual([]);
    // `output` was undefined on the deny path — `auditLogRedactedFields`
    // substitutes `''` so the audit payload's `output_redacted` is a
    // valid JSON string.
    expect(p3.output_redacted).toBe('');
  });

  it('payload contains redacted_fields when AD hashes are present', async () => {
    const append = vi.fn(async (_k: string, _p: Record<string, unknown>) => {});
    const sink: AuditSink = { append };

    // Realistic secretsdump SAM output: a single line matching pattern #1
    // (name:RID:aad3b... empty LM:nthash:::) plus a line matching pattern
    // #2 (lsass NTHASH).
    const secretsdumpOutput = [
      'Administrator:500:aad3b435b51404eeaad3b435b51404ee:8846f7eaee8fb27ad716cb6168e2d70c:::',
      '\\ADMINISTRATOR:NTHASH:8846f7eaee8fb27ad716cb6168e2d70c',
      '[*] Cleaning up...',
    ].join('\n');

    // Realistic kerberoast output (pattern #3).
    const kerberoastOutput =
      '$krb5tgs$23$*admin$CORP.LOCAL$*$M$spn1*$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa$bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

    const events: AgentEvent[] = [
      { type: 'tool-result', id: 'tr1', name: 'impacket_secretsdump', ok: true, output: secretsdumpOutput },
      { type: 'tool-result', id: 'tr2', name: 'impacket_GetUserSPNs', ok: true, output: kerberoastOutput },
    ];

    const wrapped = withAuditToolResult(fromArray(events), sink);
    await drainAndFlush(wrapped);

    expect(append).toHaveBeenCalledTimes(2);

    // Payload 1: secretsdump SAM match → `ntlm-hash`; lsass NTHASH match →
    // `lsass-nthash`. Both should be in `redacted_fields`.
    const p1 = append.mock.calls[0][1] as Record<string, unknown>;
    expect(p1.name).toBe('impacket_secretsdump');
    const rf1 = p1.redacted_fields as string[];
    expect(rf1).toContain('ntlm-hash');
    expect(rf1).toContain('lsass-nthash');
    // The redacted output string must contain the verbose replacement
    // tokens, NOT the raw hashes.
    const out1 = p1.output_redacted as string;
    expect(out1).toContain('<redacted:ntlm-hash>');
    expect(out1).toContain('<redacted:lsass-nthash>');
    expect(out1).not.toContain('8846f7eaee8fb27ad716cb6168e2d70c');

    // Payload 2: kerberoast TGS match → `kerberos-tgs`.
    const p2 = append.mock.calls[1][1] as Record<string, unknown>;
    expect(p2.name).toBe('impacket_GetUserSPNs');
    expect(p2.redacted_fields).toEqual(['kerberos-tgs']);
    expect(p2.output_redacted).toContain('<redacted:kerberos-tgs>');
    // The full TGS line is replaced wholesale — the raw salt + checksum
    // hex must not appear in the redacted output.
    expect(p2.output_redacted).not.toContain(
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    );
  });

  it('non-tool-result events pass through unchanged and do NOT trigger audit appends', async () => {
    const append = vi.fn(async (_k: string, _p: Record<string, unknown>) => {});
    const sink: AuditSink = { append };

    const events: AgentEvent[] = [
      { type: 'text-delta', text: 'starting recon' },
      { type: 'tool-call-request', id: 'c1', name: 'whois', args: { domain: 'example.com' } },
      { type: 'confirmation-needed', id: 'c2', name: 'sqlmap', reason: 'destructive tool' },
      { type: 'supervisor-fire', fire: { kind: 'plan-issue', severity: 'warn', text: 'high blast radius', advice: 'a', targetEventId: 'c1' }, targetEventId: 'c1' },
      { type: 'error', error: new Error('something broke') },
      { type: 'done', text: 'turn complete' },
    ];

    const wrapped = withAuditToolResult(fromArray(events), sink);
    const out = await drainAndFlush(wrapped);

    // All 6 events must pass through in order, unchanged.
    expect(out).toHaveLength(6);
    expect(out.map((e) => e.type)).toEqual([
      'text-delta',
      'tool-call-request',
      'confirmation-needed',
      'supervisor-fire',
      'error',
      'done',
    ]);

    // ZERO audit appends — `withAuditToolResult` only fires on
    // `tool-result` events. The supervisor wrapper (a sibling decorator,
    // not this one) handles `supervisor-fire`; the chokepoint wrapper
    // handles `chokepoint-decision` events that are not AgentEvents.
    expect(append).toHaveBeenCalledTimes(0);
  });

  it('truncates output_redacted for outputs > MAX_TOOL_RESULT_OUTPUT_CHARS', async () => {
    const append = vi.fn(async (_k: string, _p: Record<string, unknown>) => {});
    const sink: AuditSink = { append };

    // Build an output that's clearly larger than MAX_TOOL_RESULT_OUTPUT_CHARS.
    // Use a long string of safe ASCII so the test doesn't depend on
    // secretsdump or kerberoast shapes.
    const bigOutput = 'A'.repeat(MAX_TOOL_RESULT_OUTPUT_CHARS * 3);

    const events: AgentEvent[] = [
      { type: 'tool-result', id: 'tr1', name: 'noisy_tool', ok: true, output: bigOutput },
    ];

    const wrapped = withAuditToolResult(fromArray(events), sink);
    await drainAndFlush(wrapped);

    expect(append).toHaveBeenCalledTimes(1);
    const p1 = append.mock.calls[0][1] as Record<string, unknown>;
    const truncated = p1.output_redacted as string;
    // The truncation runs AFTER `auditLogRedactedFields` JSON-stringifies
    // the output. For a plain string, JSON.stringify adds opening +
    // closing quotes (so `bigOutput` becomes `"AAA...A"`). The cap
    // therefore applies to the JSON-stringified form, not the raw
    // input — that's the correct semantics because the audit payload
    // is always JSON-shaped and the on-disk form must be a valid
    // JSON string. So `truncated.length` is exactly
    // MAX_TOOL_RESULT_OUTPUT_CHARS, not MAX + 2.
    expect(truncated.length).toBe(MAX_TOOL_RESULT_OUTPUT_CHARS);
    // The truncated form starts with the opening quote of the JSON
    // string and is filled with `A`s; the closing quote is at index
    // MAX_TOOL_RESULT_OUTPUT_CHARS - 1 (the last char preserved).
    expect(truncated[0]).toBe('"');
    expect(truncated).toBe('"' + 'A'.repeat(MAX_TOOL_RESULT_OUTPUT_CHARS - 1));
    // No redaction on a pure-ASCII payload — `redacted_fields` is empty.
    expect(p1.redacted_fields).toEqual([]);
  });
});