/**
 * v0.3.B — `--scope <path>` loader.
 *
 * A scope file is a small JSON document that whitelists host targets
 * the chokepoint will allow for the current session. The shape is:
 *
 *   {
 *     "allow": ["scanme.nmap.org", "10.0.0.5", ...]
 *   }
 *
 * Each entry is matched verbatim against `args.target` by the
 * chokepoint's `checkTarget` rule (see `@gmft/core/chokepoint/rules.ts`).
 * CIDR expansion is a future v0.4 item; in v0.3.B the operator lists
 * each host explicitly.
 *
 * The loader is sync (the file is small — a few KB max) and throws a
 * `ScopeFileError` on any failure with a stable `code` field so the
 * CLI can map the error to a precise exit-code branch. Pure on the
 * happy path: no logging, no FS side effects beyond the read.
 *
 * Mirrors the `report-flag.ts` pattern: a small pure module with a
 * discriminated error type and unit tests that don't need to boot
 * the Ink runtime.
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

/** Same shape as `ChokepointEnv.allowlist` on `@gmft/core`. */
export type Allowlist = readonly string[];

/**
 * The validated, deduplicated allowlist. Returned to the caller
 * ready to pass through to `readChokepointEnv({ allowlist })`.
 */
export interface LoadedScope {
  /** Frozen, deduplicated list of allowed targets. */
  allow: Allowlist;
  /** Absolute path the scope file was loaded from (for logging). */
  source: string;
}

/**
 * Discriminated error. The `code` is stable so the CLI can branch
 * on it (currently the CLI just prints `message`; the code is
 * future-proofing for `--scope` errors that want different exit
 * codes).
 *
 * Codes:
 *   - `'ENOENT'`     — file does not exist
 *   - `'ENOTDIR'`    — a parent path component is not a directory
 *   - `'EISDIR'`     — the path is a directory, not a file
 *   - `'EMPTYPATH'`  — the path argument was empty
 *   - `'PARSE'`      — the file content is not valid JSON
 *   - `'SHAPE'`      — the JSON does not match the `{ allow: [...] }` shape
 *   - `'ENTRY'`      — at least one entry is malformed (illegal chars
 *                       or empty string)
 *   - `'IO'`         — any other read failure (EACCES, etc.)
 */
export type ScopeFileErrorCode =
  | 'ENOENT'
  | 'ENOTDIR'
  | 'EISDIR'
  | 'EMPTYPATH'
  | 'PARSE'
  | 'SHAPE'
  | 'ENTRY'
  | 'IO';

export class ScopeFileError extends Error {
  public readonly code: ScopeFileErrorCode;
  public readonly path: string;
  public constructor(code: ScopeFileErrorCode, path: string, message: string) {
    super(message);
    this.name = 'ScopeFileError';
    this.code = code;
    this.path = path;
  }
}

/**
 * v0.3.B — target format check. Mirrors `TARGET_RE` in
 * `@gmft/core/src/chokepoint/rules.ts` exactly. Letters, digits,
 * dot, underscore, dash. We intentionally do NOT share the
 * constant with `@gmft/core` because (a) the regex is one line
 * and (b) cross-package exports for a regex are noise.
 *
 * If the chokepoint's `TARGET_RE` ever changes, change this too.
 * A drift would manifest as a chokepoint that rejects a target
 * the scope loader accepted; easy to spot in integration tests.
 */
const SCOPE_TARGET_RE = /^[a-zA-Z0-9._-]+$/;

/**
 * Read + parse + validate a scope file. Sync on purpose: the file
 * is small and the CLI blocks on this at boot anyway. Throws a
 * `ScopeFileError` on any failure.
 *
 * @param requestedPath - The path from `--scope <path>`. Relative
 *   paths are resolved against `process.cwd()` (matches the
 *   chokepoint's behavior for the denylist file and the operator's
 *   intuitive expectation: "the path I typed on the CLI").
 * @param opts.fs - Injectable FS shims for tests. Defaults to
 *   `node:fs`. Both must be supplied together.
 */
export function loadScopeFile(
  requestedPath: string,
  opts: {
    fs?: { existsSync: typeof existsSync; statSync: typeof statSync; readFileSync: typeof readFileSync };
    cwd?: string;
  } = {},
): LoadedScope {
  const fs = opts.fs ?? { existsSync, statSync, readFileSync };
  const cwd = opts.cwd ?? process.cwd();

  if (typeof requestedPath !== 'string' || requestedPath.length === 0) {
    throw new ScopeFileError('EMPTYPATH', String(requestedPath), 'scope file path is empty');
  }

  // Resolve to an absolute path so the `source` field is unambiguous
  // and so any post-load "where did this come from?" log is honest.
  const abs = resolvePath(cwd, requestedPath);

  if (!fs.existsSync(abs)) {
    throw new ScopeFileError('ENOENT', abs, `scope file not found: ${abs}`);
  }
  let st;
  try {
    st = fs.statSync(abs);
  } catch (err) {
    throw new ScopeFileError('IO', abs, `scope file stat failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!st.isFile()) {
    if (st.isDirectory()) {
      throw new ScopeFileError('EISDIR', abs, `scope path is a directory, not a file: ${abs}`);
    }
    throw new ScopeFileError('IO', abs, `scope path is not a regular file: ${abs}`);
  }

  let raw: string;
  try {
    raw = fs.readFileSync(abs, 'utf8');
  } catch (err) {
    throw new ScopeFileError('IO', abs, `scope file read failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ScopeFileError('PARSE', abs, `scope file is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Shape check: top-level object with `allow: string[]`.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ScopeFileError('SHAPE', abs, 'scope file root must be a JSON object');
  }
  const obj = parsed as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(obj, 'allow')) {
    throw new ScopeFileError('SHAPE', abs, 'scope file must have an "allow" array (e.g. { "allow": ["scanme.nmap.org"] })');
  }
  const allow = obj.allow;
  if (!Array.isArray(allow)) {
    throw new ScopeFileError('SHAPE', abs, '"allow" must be an array of host strings');
  }

  // Per-entry validation + dedup. Preserve first-seen order so the
  // operator's authored ordering is reflected in the audit reason
  // ("3 entries listed", etc.) — order is otherwise not used by the
  // chokepoint but it's nice for humans reading the log.
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = 0; i < allow.length; i += 1) {
    const entry = allow[i];
    if (typeof entry !== 'string' || entry.length === 0) {
      throw new ScopeFileError('ENTRY', abs, `"allow"[${i}] must be a non-empty string`);
    }
    if (!SCOPE_TARGET_RE.test(entry)) {
      throw new ScopeFileError('ENTRY', abs, `"allow"[${i}] "${entry}" contains illegal characters (allowed: letters, digits, '.', '_', '-')`);
    }
    if (!seen.has(entry)) {
      seen.add(entry);
      out.push(entry);
    }
  }

  return { allow: Object.freeze(out), source: abs };
}
