/**
 * v0.4-B — `redactAdSecrets` post-execution pass for AD tool transcripts.
 *
 * ADR-0018 §D.5: a sibling redaction pass to the existing
 * `redactSecrets` (which covers API keys, SSH keys, env-var-shaped
 * secrets). The AD-specific pass covers material that lands in the
 * session transcript JSONL as a *side effect* of running the AD attack
 * tools (secretsdump / kerberoast / asreproast):
 *
 *   - NTLM hashes from `secretsdump` SAM output
 *     (e.g. `Administrator:500:aad3b435b51404ee...:8846f7e...:::`)
 *   - NTHASH lines from `secretsdump` lsass/NTDS.dit
 *     (e.g. `\ADMINISTRATOR:NTHASH:8846f7ea...`)
 *   - TGS hashes from `impacket-GetUserSPNs` (kerberoast)
 *     (e.g. `$krb5tgs$23$*user$realm$spn$*...`)
 *   - AS-REP hashes from `impacket-GetNPUsers` (asreproast)
 *     — see ADR §D.5 footnote about impacket version differences
 *     in the leading-`$` handling
 *
 * Conservative by design. False positives are acceptable; a missing
 * hash in the transcript is much worse than a correctly-redacted
 * one showing up as `<redacted:ntlm-hash>`.
 *
 * Wired into `session/log.ts#appendTurn` immediately after
 * `redactSecrets` (same call site, second pass). The audit-event
 * writer picks up the returned `redactedFields` array via the
 * `auditLogRedactedFields` helper exported below (so the audit
 * chain records *what kind* of secrets were scrubbed, not just
 * *that* something was scrubbed).
 *
 * NOT JSON-aware. Runs on the same already-serialized log line
 * that `redactSecrets` runs on. The replacement strings are
 * deliberately verbose (`<redacted:ntlm-hash>` rather than
 * `[REDACTED]`) so the operator can still tell, when reading
 * the log, which kind of material was scrubbed.
 */

export type AdRedactedField =
  | 'ntlm-hash'
  | 'lsass-nthash'
  | 'kerberos-tgs'
  | 'kerberos-asrep';

/**
 * Result of running `redactAdSecrets` against one already-serialized
 * log line.
 *
 * - `redactedText`     — the input with all AD-shaped secrets replaced.
 * - `redactedFields`   — the deduplicated, order-preserving list of
 *                        field kinds that were scrubbed. Empty if the
 *                        input had none. The audit-event writer reads
 *                        this and pushes it onto the event payload as
 *                        `redacted_fields: string[]` (additive — v0.4.0-A.1
 *                        audit-log wire format is preserved for non-AD
 *                        entries that have an empty array).
 *
 * The field-kind tags match the replacement token (both use the
 * `<redacted:ntlm-hash>` style) so an operator reading the log can
 * tell from `redactedFields` exactly which shapes were scrubbed
 * without diffing the input.
 */
export interface AdRedactionResult {
  redactedText: string;
  redactedFields: AdRedactedField[];
}

/**
 * Redacts AD-shaped credential material from a serialized log line.
 *
 * Pattern catalogue (per ADR-0018 §D.5):
 *
 *   | Pattern                                            | Source            | Field tag          |
 *   |----------------------------------------------------|-------------------|--------------------|
 *   | \b[\w.-]+:[0-9]+:aad3b435b51404eeaad3b435b51404ee:[0-9a-f]{32}::: | secretsdump SAM   | ntlm-hash          |
 *   | \\[\w.-]+:NTHASH:[0-9a-f]{32}                      | secretsdump lsass | lsass-nthash       |
 *   | \$krb5tgs\$23\$*[\w.-]+\$[\w.-]+\$[\w./+=$-]+      | kerberoast TGS    | kerberos-tgs       |
 *   | \$krb5asrep\$23\$[\w.-]+\$[\w./+=$-]+              | asreproast AS-REP | kerberos-asrep     |
 *   | [\w.-]+:[0-9]+:[0-9a-f]{32}:[0-9a-f]{32}:::       | generic SAM       | ntlm-hash          |
 *
 * Patterns are evaluated in the order listed. First match wins per
 * position; a later pattern never re-enters text that an earlier one
 * replaced. The list is deduplicated (Set semantics) before being
 * returned as `redactedFields`.
 *
 * String-level, not JSON-aware. The `meta` field of a `Turn` is not
 * redacted by this pass — it's structured machine data, not user-
 * pasted content (and redaction of it is the supervisor's job, not
 * the transcript's).
 *
 * The hash patterns are case-insensitive on the hex portions but the
 * impacket tool emits them as lowercase. We don't normalize case so
 * the regex matches what impacket emits in the wild; an operator
 * reading the log will see exactly the same lowercase hex bytes
 * (only the *replacement* token changes).
 */
export function redactAdSecrets(line: string): AdRedactionResult {
  const seen = new Set<AdRedactedField>();

  let out = line;

  // 1. secretsdump SAM — name:RID:aad3b... (empty LM):nthash:::
  // The literal `aad3b435b51404eeaad3b435b51404ee` is the empty-LM
  // hash sentinel impacket emits when there's no LM hash to record.
  // Match `:::` at the end (impacket's SAM line terminator) so we
  // don't accidentally match other `name:RID:hex:hex:` lines that
  // aren't SAM-format.
  out = out.replace(
    /\b[\w.-]+:[0-9]+:aad3b435b51404eeaad3b435b51404ee:[0-9a-f]{32}:::/gi,
    (m) => {
      seen.add('ntlm-hash');
      return m.replace(/:[0-9a-f]{32}:::$/i, ':<redacted:ntlm-hash>:::');
    },
  );

  // 2. secretsdump lsass / NTDS.dit NTHASH lines. Impacket emits
  // these as `\USER:NTHASH:8846f7ea...` when dumping lsass or
  // NTDS.dit hashes. The leading backslash is literal. Anchored to
  // the end of the line ($) so we don't match partial hex runs in
  // other contexts.
  out = out.replace(
    /\\[\w.-]+:NTHASH:[0-9a-f]{32}(?![0-9a-f])/gi,
    (m) => {
      seen.add('lsass-nthash');
      return m.replace(/:NTHASH:[0-9a-f]{32}$/i, ':NTHASH:<redacted:lsass-nthash>');
    },
  );

  // 3. kerberoast TGS — impacket-GetUserSPNs output. Format:
  //   $krb5tgs$23$*user$realm$spn*$salt$checksum$...
  // Impacket v0.12 emits the user wrapped in `*$` (literal asterisk
  // before the username, then `$`); older versions just emit
  // `user$realm` without the leading `*`. Both shapes are accepted
  // because `*` is in the user/realm/SPN character classes. The
  // trailing section (salt + checksum fields) is `[\w.*/+=$-]+`,
  // which is the same content set impacket emits for both versions.
  out = out.replace(
    /\$krb5tgs\$23\$*[\w.*-]+\$[\w.*-]+\$[\w.*/+=$-]+/g,
    (m) => {
      seen.add('kerberos-tgs');
      return '<redacted:kerberos-tgs>';
    },
  );

  // 4. asreproast AS-REP — impacket-GetNPUsers output. Format:
  //   $krb5asrep$23$user@realm:hash...
  // The user is sometimes wrapped in `*$` (impacket v0.12) and
  // sometimes not. Same character-class tolerance as the TGS regex.
  out = out.replace(
    /\$krb5asrep\$23\$*[\w.*-]+@[\w.*-]+:[\w.*/+$=]+/g,
    (m) => {
      seen.add('kerberos-asrep');
      return '<redacted:kerberos-asrep>';
    },
  );

  // 5. Generic SAM — name:RID:nthash:nthash::: (without the
  // `aad3b...` empty-LM sentinel). Catches secretsdump output
  // against hosts that DO have an LM hash recorded. Falls through
  // to the same `ntlm-hash` field tag as pattern #1.
  out = out.replace(
    /\b[\w.-]+:[0-9]+:[0-9a-f]{32}:[0-9a-f]{32}:::/gi,
    (m) => {
      // Already covered by pattern #1? Skip — that case already
      // replaced the line, so we won't see this pattern here for
      // the same input. The `seen` set tracks it for the audit.
      seen.add('ntlm-hash');
      return m.replace(/:[0-9a-f]{32}:[0-9a-f]{32}:::$/i, ':<redacted:ntlm-hash>:<redacted:ntlm-hash>:::');
    },
  );

  return {
    redactedText: out,
    redactedFields: Array.from(seen),
  };
}
