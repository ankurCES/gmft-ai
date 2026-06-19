/**
 * v0.4-B — Tests for the `redactAdSecrets` post-execution pass.
 *
 * ADR-0018 §D.5: 5 regex patterns + 4 field tags. The library function
 * runs on an already-serialized log line (same input as `redactSecrets`)
 * and returns `{ redactedText, redactedFields }`.
 *
 * What we cover here:
 *  1. Each of the 5 patterns matches the expected impacket output shape.
 *  2. Each pattern returns the right `redactedFields` tag.
 *  3. Multiple hashes in the same line all get scrubbed (no early exit).
 *  4. `appendTurn` runs the AD pass after `redactSecrets` and the
 *     returned `redactedFields` array is what the audit-event writer
 *     consumes (additive — see also `audit-log-redacted-fields.test.ts`).
 *  5. Idempotency: running `redactAdSecrets` twice produces the same
 *     output as running it once (so a `readLog → writeLog` round-trip
 *     stays clean).
 *  6. Non-AD text is passed through unchanged (no over-redaction of
 *     regular prose, code samples, or other tool output).
 */

import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  redactAdSecrets,
  appendTurn,
  type Turn,
} from '../src/index.js';

describe('redactAdSecrets — pattern catalogue (ADR-0018 §D.5)', () => {
  it('redacts the secretsdump SAM line (empty LM + nthash)', () => {
    // Real impacket secretsdump output (against `CORP\\Administrator`):
    //   CORP\Administrator:500:aad3b435b51404eeaad3b435b51404ee:8846f7eaee8fb117ad06bdd830b7586c:::
    const { redactedText, redactedFields } = redactAdSecrets(
      'CORP\\Administrator:500:aad3b435b51404eeaad3b435b51404ee:8846f7eaee8fb117ad06bdd830b7586c:::',
    );
    expect(redactedText).toBe('CORP\\Administrator:500:aad3b435b51404eeaad3b435b51404ee:<redacted:ntlm-hash>:::');
    expect(redactedFields).toEqual(['ntlm-hash']);
  });

  it('redacts the secretsdump lsass NTHASH line', () => {
    // Real impacket secretsdump lsass output:
    //   \ADMINISTRATOR:NTHASH:8846f7eaee8fb117ad06bdd830b7586c
    const { redactedText, redactedFields } = redactAdSecrets(
      '\\ADMINISTRATOR:NTHASH:8846f7eaee8fb117ad06bdd830b7586c',
    );
    expect(redactedText).toBe('\\ADMINISTRATOR:NTHASH:<redacted:lsass-nthash>');
    expect(redactedFields).toEqual(['lsass-nthash']);
  });

  it('redacts the kerberoast TGS hash (impacket v0.12 with leading $)', () => {
    // Real impacket-GetUserSPNs output (impacket v0.12):
    //   $krb5tgs$23$*user$CORP.LOCAL$http/web$*$abc123$def456$ghi789$jkl012$mno345$pqr678$stu901
    const { redactedText, redactedFields } = redactAdSecrets(
      '$krb5tgs$23$*user$CORP.LOCAL$http/web$*$abc123$def456$ghi789$jkl012$mno345$pqr678$stu901',
    );
    expect(redactedText).toBe('<redacted:kerberos-tgs>');
    expect(redactedFields).toEqual(['kerberos-tgs']);
  });

  it('redacts the asreproast AS-REP hash', () => {
    // Real impacket-GetNPUsers output:
    //   $krb5asrep$23$user@CORP.LOCAL:abc123$def456$ghi789$jkl012$mno345
    const { redactedText, redactedFields } = redactAdSecrets(
      '$krb5asrep$23$user@CORP.LOCAL:abc123$def456$ghi789$jkl012$mno345',
    );
    expect(redactedText).toBe('<redacted:kerberos-asrep>');
    expect(redactedFields).toEqual(['kerberos-asrep']);
  });

  it('redacts the generic SAM line (LM + nthash, no aad3b sentinel)', () => {
    // Real impacket output against hosts that DO have an LM hash
    // recorded. The empty-LM sentinel is absent; pattern #5 catches
    // both halves and tags them both as ntlm-hash.
    const { redactedText, redactedFields } = redactAdSecrets(
      'CORP\\jdoe:1001:8846f7eaee8fb117ad06bdd830b7586c:8846f7eaee8fb117ad06bdd830b7586c:::',
    );
    expect(redactedText).toBe(
      'CORP\\jdoe:1001:<redacted:ntlm-hash>:<redacted:ntlm-hash>:::',
    );
    expect(redactedFields).toEqual(['ntlm-hash']);
  });

  it('passes non-AD text through unchanged', () => {
    const { redactedText, redactedFields } = redactAdSecrets(
      'The quick brown fox jumps over the lazy dog. 127.0.0.1 is loopback.',
    );
    expect(redactedText).toBe('The quick brown fox jumps over the lazy dog. 127.0.0.1 is loopback.');
    expect(redactedFields).toEqual([]);
  });

  it('redacts multiple AD hashes in the same line and dedups the field tags', () => {
    // A typical `secretsdump` run emits dozens of SAM lines in one
    // tool result. The redact pass must scrub every one and return
    // exactly one 'ntlm-hash' tag (Set semantics), not one tag per
    // match.
    const line = [
      'CORP\\Administrator:500:aad3b435b51404eeaad3b435b51404ee:8846f7eaee8fb117ad06bdd830b7586c:::',
      'CORP\\jdoe:1001:aad3b435b51404eeaad3b435b51404ee:deadbeefdeadbeefdeadbeefdeadbeef:::',
      'CORP\\asmith:1002:aad3b435b51404eeaad3b435b51404ee:cafebabecafebabecafebabecafebabe:::',
    ].join('\n');
    const { redactedText, redactedFields } = redactAdSecrets(line);
    expect(redactedText).not.toMatch(/8846f7eaee8fb117ad06bdd830b7586c/);
    expect(redactedText).not.toMatch(/deadbeefdeadbeefdeadbeefdeadbeef/);
    expect(redactedText).not.toMatch(/cafebabecafebabecafebabecafebabe/);
    expect(redactedText.match(/<redacted:ntlm-hash>/g)?.length).toBe(3);
    expect(redactedFields).toEqual(['ntlm-hash']);
  });

  it('does not redact bare hex strings of the wrong length (NTLM hashes are exactly 32 hex chars)', () => {
    // 16 hex chars (NT/LM-old) and 64 hex chars (SHA-256) must NOT
    // match the SAM pattern. This guards against future pattern
    // tweaks that over-match.
    const { redactedText, redactedFields } = redactAdSecrets(
      'short:deadbeefdeadbeef and long:abc123abc123abc123abc123abc123abc123abc123abc123abc123abc123abc1',
    );
    expect(redactedText).toBe('short:deadbeefdeadbeef and long:abc123abc123abc123abc123abc123abc123abc123abc123abc123abc123abc1');
    expect(redactedFields).toEqual([]);
  });

  it('is idempotent on the redactedText: redact(redact(x)).redactedText === redact(x).redactedText', () => {
    // Idempotency contract: re-running the pass on an already-
    // redacted line must produce the same `redactedText` (no further
    // replacements). `redactedFields` on the second pass is empty,
    // because the function reports what it just scrubbed, not the
    // cumulative-replaced-set. The empty `redactedFields` on the
    // second pass is the correct behavior for a diff-reporting
    // function — call sites that need to accumulate the set (e.g.
    // a multi-line reducer) should union the per-call arrays.
    const x = 'CORP\\Administrator:500:aad3b435b51404eeaad3b435b51404ee:8846f7eaee8fb117ad06bdd830b7586c:::\n\\ADMIN:NTHASH:8846f7eaee8fb117ad06bdd830b7586c';
    const once = redactAdSecrets(x);
    const twice = redactAdSecrets(once.redactedText);
    expect(twice.redactedText).toBe(once.redactedText);
    expect(twice.redactedFields).toEqual([]); // no further scrubbing on already-redacted line
  });

  it('is case-insensitive on the hex portions', () => {
    // Impacket emits lowercase hex, but if a tool upstream
    // upper-cases it, the redact pass must still catch it.
    const { redactedText, redactedFields } = redactAdSecrets(
      'CORP\\Administrator:500:AAD3B435B51404EEAAD3B435B51404EE:8846F7EAEE8FB117AD06BDD830B7586C:::',
    );
    expect(redactedText).toBe('CORP\\Administrator:500:AAD3B435B51404EEAAD3B435B51404EE:<redacted:ntlm-hash>:::');
    expect(redactedFields).toEqual(['ntlm-hash']);
  });
});

describe('redactAdSecrets — composition with redactSecrets (appendTurn)', () => {
  it('appendTurn scrubs AD hashes AND api keys on the same line', async () => {
    // The composition contract: a turn that contains BOTH a pasted
    // `sk-ant-...` key AND a secretsdump SAM line (e.g. an operator
    // pastes an impacket example) gets both redactions on the same
    // pass.
    const dir = await mkdtemp(join(tmpdir(), 'gmft-redact-ad-'));
    const logPath = join(dir, 'session.jsonl');
    const turn: Turn = {
      role: 'tool',
      content:
        'sample line: CORP\\admin:500:aad3b435b51404eeaad3b435b51404ee:8846f7eaee8fb117ad06bdd830b7586c:::\n' +
        'paste: sk-ant-1234567890abcdefghij',
    };
    try {
      const { redactedFields } = await appendTurn(logPath, turn);
      // AD pass tags the SAM line. The sk-ant tag is owned by
      // redactSecrets and is not exposed in redactedFields (that
      // array is AD-specific by design — the audit-log shape stays
      // additive and AD-only).
      expect(redactedFields).toEqual(['ntlm-hash']);

      const onDisk = await readFile(logPath, 'utf8');
      expect(onDisk).not.toMatch(/8846f7eaee8fb117ad06bdd830b7586c/);
      expect(onDisk).not.toMatch(/sk-ant-1234567890abcdefghij/);
      expect(onDisk).toContain('<redacted:ntlm-hash>');
      expect(onDisk).toContain('[REDACTED]');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('appendTurn returns an empty redactedFields array for a non-AD turn', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gmft-redact-ad-'));
    const logPath = join(dir, 'session.jsonl');
    try {
      const { redactedFields } = await appendTurn(logPath, {
        role: 'user',
        content: 'hello world',
      });
      expect(redactedFields).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('appendTurn surfaces kerberoast + secretsdump fields when both appear in one turn', async () => {
    // A single tool-result turn can contain hashes from multiple AD
    // tools (e.g. when an operator runs a chained kerberoast →
    // secretsdump sequence). The redact pass must report both field
    // tags.
    const dir = await mkdtemp(join(tmpdir(), 'gmft-redact-ad-'));
    const logPath = join(dir, 'session.jsonl');
    const turn: Turn = {
      role: 'tool',
      content: [
        'TGS: $krb5tgs$23$*svc$CORP.LOCAL$http/web$*$abc123$def456$ghi789$jkl012$mno345$pqr678$stu901',
        'SAM: CORP\\svc:1110:aad3b435b51404eeaad3b435b51404ee:deadbeefdeadbeefdeadbeefdeadbeef:::',
      ].join('\n'),
    };
    try {
      const { redactedFields } = await appendTurn(logPath, turn);
      expect(redactedFields).toContain('kerberos-tgs');
      expect(redactedFields).toContain('ntlm-hash');
      expect(redactedFields.length).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
