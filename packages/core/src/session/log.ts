import { appendFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

export interface Turn {
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  /** Optional metadata (token count, model id, etc.). Not redacted. */
  meta?: Record<string, unknown>;
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
 * Use {@link appendTurnRaw} to bypass redaction for tests or trusted
 * internal paths.
 */
export async function appendTurn(path: string, turn: Turn): Promise<void> {
  const line = JSON.stringify(turn) + '\n';
  const safe = redactSecrets(line);
  await appendFile(path, safe, 'utf8');
}

/**
 * Appends a turn without redaction. **Escapes the safety net** that
 * `appendTurn` provides. Use only for trusted internal paths — e.g.
 * tests that need to assert the on-disk form, or a hypothetical
 * future code path that writes pre-sanitized data.
 */
export async function appendTurnRaw(path: string, turn: Turn): Promise<void> {
  const line = JSON.stringify(turn) + '\n';
  await appendFile(path, line, 'utf8');
}

/**
 * Reads and parses the JSONL log. Returns `[]` if the file is missing.
 * Skips blank lines defensively (the file might be hand-edited).
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
    turns.push(JSON.parse(line) as Turn);
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
