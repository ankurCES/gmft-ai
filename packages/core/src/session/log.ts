import { appendFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { SupervisorTurnRecord } from '../agent/supervisor-types.js';
// v0.4-B — sibling redaction pass for AD-shaped credential material.
// See packages/core/src/transcript/redact-ad.ts (ADR-0018 §D.5).
import { redactAdSecrets } from '../transcript/redact-ad.js';

export type { AdRedactedField } from '../transcript/redact-ad.js';

export interface Turn {
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  /** Optional metadata (token count, model id, etc.). Not redacted. */
  meta?: Record<string, unknown>;
  /**
   * v0.2.A.3+ — schema version of this turn's on-disk shape.
   *
   *   - `1` (or absent): the v0.1 shape — `role` + `content` + optional
   *     `meta`. No supervisor data. This is the default for any line
   *     read from a log written before v0.2.
   *   - `2`: the v0.2.A+ shape. May include `supervisor: SupervisorTurnRecord`
   *     (the supervisor's fires + postmortem for this turn).
   *
   * Writers (v0.2.A+) MUST set `schemaVersion: 2`. Readers MUST
   * tolerate lines with or without the field — older logs and older
   * turns inside a newer log are both v1.
   */
  schemaVersion?: 1 | 2;
  /**
   * v0.2.A.3+ — the supervisor's record for this turn (fires +
   * postmortem). Absent on v0.1 turns and on v0.2 turns where the
   * supervisor was opted out (e.g. no model configured). Secret
   * redaction is applied to the postmortem text and the per-fire
   * `quote` strings on disk via the same `redactSecrets` pass that
   * scrubs user content — see `appendTurn` below.
   */
  supervisor?: SupervisorTurnRecord;
  /**
   * v0.2.D+ — the runner mode the host resolved to for this turn.
   *
   *   - `'docker'`         — tool ran inside a Docker container.
   *   - `'host+landlock'`  — tool ran on the host under landlock.
   *   - `'host'`           — tool ran on the host without landlock
   *                          (operator opt-in via
   *                          `GMFT_ALLOW_UNSANDBOXED_DESTRUCTIVE`).
   *   - `'unsandboxed'`    — reserved for the case where the
   *                          chokepoint *denied* a destructive call
   *                          on the host; the operator-facing log
   *                          still records the runner mode that
   *                          *would* have applied. The audit log
   *                          also writes a separate entry for the
   *                          deny decision.
   *
   * Optional so v0.1 + v0.2.A logs (which lack the field)
   * deserialize cleanly. Populated by the agent loop at the moment
   * the tool is dispatched; the value flows from
   * `pickRunnerMode()` in `@gmft/tools`.
   */
  runnerMode?: 'docker' | 'host' | 'host+landlock' | 'unsandboxed';
}

/**
 * Appends a single turn to the JSONL log, **scrubbing well-known
 * secret shapes from the serialized line before writing**.
 *
 * Wire-time redaction: anything the user pastes into chat (a pasted
 * `sk-...` key, a `curl -H "Authorization: Bearer ..."` line, a
 * `{"apiKey": "..."}` config snippet) is rewritten to `[REDACTED]`
 * on disk. This keeps the log safe to `cat`, `grep`, ship to CI
 * artifacts, paste into bug reports, etc.
 *
 * v0.2.A.3 also redacts the `supervisor.postmortem` and
 * `supervisor.fires[].quote` fields — they may contain LLM-quoted
 * user text or pasted snippets, so they go through the same
 * `redactSecrets` pass.
 *
 * v0.4-B also runs `redactAdSecrets` (sibling pass, ADR-0018 §D.5) on
 * the same serialized line. `redactAdSecrets` covers NTLM hashes,
 * lsass NTHASH lines, kerberoast TGS hashes, and asreproast AS-REP
 * hashes — all shapes that `secretsdump` / `kerberoast` / `asreproast`
 * emit to stdout and that an unaudited transcript would otherwise
 * leak. The function returns the field kinds that were scrubbed so
 * the caller (audit-event writer) can record
 * `redacted_fields: string[]` in the audit event payload.
 *
 * Use {@link appendTurnRaw} to bypass redaction for tests or trusted
 * internal paths.
 */
export async function appendTurn(
  path: string,
  turn: Turn,
): Promise<{ redactedFields: import('../transcript/redact-ad.js').AdRedactedField[] }> {
  // v0.2.A+ always writes schemaVersion: 2 (the supervisor field is
  // optional, but the schema marker is mandatory on new lines so a
  // reader can identify which version produced this line).
  const toWrite: Turn = { schemaVersion: 2, ...turn };
  const line = JSON.stringify(toWrite) + '\n';
  // Pass 1: general secret shapes (sk-..., Authorization: Bearer,
  // JSON-shaped apiKey, env-shaped key=value). Established in v0.1.5g.
  const safe = redactSecrets(line);
  // Pass 2: AD-shaped credential material (secretsdump SAM,
  // lsass NTHASH, kerberoast TGS, asreproast AS-REP). Established
  // in v0.4-B (ADR-0018 §D.5). Runs on the already-redacted line so
  // the two passes compose — `redactSecrets` runs first, then
  // `redactAdSecrets` matches against the (already secret-stripped)
  // line. The order matters: `redactSecrets` would not match AD
  // shapes (the hash regexes don't look like API keys), and
  // `redactAdSecrets` would not match general secret shapes (the
  // patterns are tuned for hash formats). Both passes are pure
  // string-level, so composing them is safe.
  const { redactedText, redactedFields } = redactAdSecrets(safe);
  await appendFile(path, redactedText, 'utf8');
  return { redactedFields };
}

/**
 * Appends a turn without redaction. **Escapes the safety net** that
 * `appendTurn` provides. Use only for trusted internal paths — e.g.
 * tests that need to assert the on-disk form, or a hypothetical
 * future code path that writes pre-sanitized data.
 */
export async function appendTurnRaw(path: string, turn: Turn): Promise<void> {
  const toWrite: Turn = { schemaVersion: 2, ...turn };
  const line = JSON.stringify(toWrite) + '\n';
  await appendFile(path, line, 'utf8');
}

/**
 * Reads and parses the JSONL log. Returns `[]` if the file is missing.
 * Skips blank lines defensively (the file might be hand-edited).
 *
 * v0.2.A.3 migration: every parsed `Turn` is normalized so that
 * `schemaVersion` is set — `1` for v0.1 lines (no `schemaVersion`
 * field, no `supervisor` field), `2` for v0.2 lines. This is a
 * read-time migration; the file on disk is not rewritten.
 *
 * Note: the on-disk form is already redacted by {@link appendTurn}, so
 * any secrets pasted in chat appear as `[REDACTED]` in the parsed
 * turns too. This is intentional — the alternative is keeping
 * secrets on disk.
 */
export async function readLog(path: string): Promise<Turn[]> {
  if (!existsSync(path)) return [];
  const text = await readFile(path, 'utf8');
  const turns: Turn[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const parsed = JSON.parse(line) as Turn;
    // Read-time migration: backfill schemaVersion for v0.1 lines.
    // A v0.1 line has no schemaVersion field and no supervisor field.
    // We don't mutate the parsed object — we copy + backfill so
    // callers see a uniform shape.
    if (parsed.schemaVersion === undefined) {
      turns.push({ ...parsed, schemaVersion: 1 });
    } else {
      turns.push(parsed);
    }
  }
  return turns;
}

/**
 * Redacts well-known secret shapes from a single log line. Conservative
 * by design — false positives are fine (we'd rather over-redact than leak).
 *
 * Patterns (in evaluation order; first match wins per position):
 *  1. `Authorization: Bearer <token>` -> `Authorization: [REDACTED]`
 *  2. JSON-shaped: `"apiKey": "..."` / `"api_key": "..."` / `"token": "..."` / `"secret": "..."`
 *  3. env-shaped: `apiKey=...` / `api_key=...` / `token=...` / `secret=...`
 *  4. provider prefixes: `sk-ant-...`, `sk-or-...`, `AIza...`, bare `sk-` (20+ chars)
 *
 * String-level redaction, not JSON-aware. Runs on already-serialized
 * log lines. The `meta` field of a `Turn` is not redacted — it's
 * structured machine data, not user-pasted content.
 */
export function redactSecrets(line: string): string {
  return line
    // 1. Authorization: Bearer <token>
    .replace(/(authorization:\s*bearer\s+)[^\s,;"\\]+/gi, 'Authorization: [REDACTED]')
    // 2. JSON-shaped: "apiKey": "..." (tolerates escaped quotes inside the value)
    .replace(
      /"(?:api[_-]?key|token|secret)"\s*:\s*"[^"\\]*(?:\\.[^"\\]*)*"/gi,
      (m) => m.replace(/:\s*"[^"\\]*(?:\\.[^"\\]*)*"/, ': "[REDACTED]"'),
    )
    // 3. env-shaped: apiKey=... / token=... / secret=...
    .replace(/(\b(?:api[_-]?key|token|secret)\s*=\s*)[^\s,;"\\]+/gi, '$1[REDACTED]')
    // 4. provider prefixes
    .replace(/\bsk-ant-[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/\bsk-or-[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/\bAIza[A-Za-z0-9_-]+/g, '[REDACTED]')
    // bare `sk-` followed by 20+ chars catches OpenAI keys (48+ chars)
    // without over-matching English words like `sk-test` (7 chars)
    .replace(/\bsk-[A-Za-z0-9]{20,}/g, '[REDACTED]');
}
