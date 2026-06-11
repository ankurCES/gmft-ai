/**
 * Read a "targets file" — one target per line, with `#`-prefixed
 * comments and blank lines ignored. The executor's
 * `executeWithScope` uses this to fan a tool out across many
 * targets in a single call.
 *
 * Caps (v0.1):
 *   - max 1 MB on disk
 *   - max 10,000 non-empty, non-comment lines
 *
 * Both caps throw before any execution so the caller sees a clear
 * error rather than a 10,000-iteration loop or a 1 GB read. They're
 * hard caps (not warnings) because the spec calls for them as a
 * safety property — a scope file is a trust boundary, and there's
 * no reason to let an attacker slip a giant list past the runner.
 *
 * Targets are returned in the order they appear in the file. Whitespace
 * is trimmed; an entirely-whitespace line counts as blank.
 */
import { promises as fs } from 'node:fs';

const MAX_BYTES = 1024 * 1024; // 1 MB
const MAX_LINES = 10_000;

export async function readTargetsFile(path: string): Promise<string[]> {
  const stat = await fs.stat(path);
  if (stat.size > MAX_BYTES) {
    throw new Error(`targets file too large: ${stat.size} bytes (max ${MAX_BYTES})`);
  }
  const content = await fs.readFile(path, 'utf-8');
  const lines = content
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
  if (lines.length > MAX_LINES) {
    throw new Error(`targets file has too many lines: ${lines.length} (max ${MAX_LINES})`);
  }
  return lines;
}
