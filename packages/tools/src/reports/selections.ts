/**
 * Selection sidecar for the FindingsTab.
 *
 * The operator's per-finding checkboxes are stored in a sidecar
 * file at `${baseDir}/${sessionId}.selections.json` (the same
 * directory as `{sessionId}.jsonl`, the canonical findings log).
 *
 * Shape: `{ checkedIds: string[] }`. The "unchecked" finding ids are
 * implicit (any finding whose id is NOT in the array is unchecked).
 *
 * Why a sidecar and not an extra field on each finding? The findings
 * log is append-only + line-delimited; modifying a finding to flip
 * a checkbox would rewrite history. A sidecar is a separate file
 * the TUI owns; the `report_write` tool reads it as a read-only
 * overlay at report-generation time.
 *
 * This module is pure file I/O. It deliberately does NOT import
 * React — the TUI's autosave is just a debounce around `writeSelections`.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface Selections {
  checkedIds: string[];
}

/**
 * Read the sidecar for a session. Returns `null` when the file is
 * missing (no operator interaction yet) or malformed (the TUI
 * probably crashed mid-write — degrade gracefully, the operator
 * can re-check).
 */
export function readSelections(baseDir: string, sessionId: string): Selections | null {
  const path = join(baseDir, `${sessionId}.selections.json`);
  if (!existsSync(path)) return null;
  try {
    const text = readFileSync(path, 'utf8');
    const parsed = JSON.parse(text) as unknown;
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'checkedIds' in parsed &&
      Array.isArray((parsed as { checkedIds: unknown }).checkedIds) &&
      (parsed as { checkedIds: unknown[] }).checkedIds.every((x) => typeof x === 'string')
    ) {
      return { checkedIds: (parsed as { checkedIds: string[] }).checkedIds };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Write the sidecar for a session. The file is JSON with a single
 * `checkedIds` array. Writes are atomic-ish: we write to a temp
 * path then rename, so a crash mid-write doesn't leave a half-file
 * that `readSelections` would reject. (We do this in two steps
 * instead of using `fs.rename` directly to avoid the EXDEV error
 * on cross-device tmp dirs; `writeFileSync` is simple enough that
 * the failure mode is "no sidecar" which `readSelections` handles.)
 */
export function writeSelections(
  baseDir: string,
  sessionId: string,
  selections: Selections,
): void {
  const path = join(baseDir, `${sessionId}.selections.json`);
  mkdirSync(dirname(path), { recursive: true });
  const text = JSON.stringify({ checkedIds: selections.checkedIds }, null, 2) + '\n';
  writeFileSync(path, text, { encoding: 'utf8', mode: 0o644 });
}
