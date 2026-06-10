import { appendFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

export interface Turn {
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  /** Optional metadata (token count, model id, etc.). Not redacted. */
  meta?: Record<string, unknown>;
}

/**
 * Appends a single turn to the JSONL log. Creates the file if it
 * doesn't exist. Each turn is a single line, newline-terminated.
 * The format is intentionally line-delimited JSON so a partial-write
 * crash loses at most one turn, not the whole log.
 */
export async function appendTurn(path: string, turn: Turn): Promise<void> {
  const line = JSON.stringify(turn) + '\n';
  await appendFile(path, line, 'utf8');
}

/**
 * Reads and parses the JSONL log. Returns `[]` if the file is missing.
 * Skips blank lines defensively (the file might be hand-edited).
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
 * Patterns:
 * - `Authorization: Bearer <token>` -> `Authorization: [REDACTED]`
 * - `apiKey=<value>` / `api_key=<value>` -> `<prefix>=[REDACTED]`
 * - `sk-ant-...`, `sk-or-...`, `AIza...` (provider key prefixes)
 *
 * String-level redaction, not JSON-aware. Runs on already-serialized
 * log lines (e.g. headers printed by debug logging).
 */
export function redactSecrets(line: string): string {
  return line
    .replace(/(authorization:\s*bearer\s+)[^\s,]+/gi, 'Authorization: [REDACTED]')
    .replace(/(\bapi[_-]?key\s*=\s*)[^\s,]+/gi, '$1[REDACTED]')
    .replace(/\bsk-ant-[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/\bsk-or-[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/\bAIza[A-Za-z0-9_-]+/g, '[REDACTED]');
}
