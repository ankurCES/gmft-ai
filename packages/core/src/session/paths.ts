/**
 * Session log paths.
 *
 * Sessions are stored as JSONL files under `${configDir()}/gmft/sessions/`.
 * A "current session" pointer file (single line: the id) records which
 * session is active. There is no automatic rotation; the id is chosen
 * by the caller (`SessionStore.start(id?)`).
 *
 * This file is intentionally tiny — it just owns the path math. The fs
 * side effects (mkdir, read, write) live in `apps/gmft/src/session/store.ts`
 * so the core package stays a leaf with no platform-specific behavior.
 */

import { join } from 'node:path';
import { configDir } from '../config/config.js';

export const SESSIONS_DIRNAME = 'sessions';
export const CURRENT_SESSION_ID_FILENAME = 'current-session-id';

/**
 * Directory holding all session JSONL files + the current-session pointer.
 * XDG-aware via {@link configDir} — honors `XDG_CONFIG_HOME` if set.
 */
export function sessionDir(): string {
  return join(configDir(), 'gmft', SESSIONS_DIRNAME);
}

/**
 * Path to a specific session's JSONL log. The id is treated as an opaque
 * string (no path-traversal check — callers must pass ids they themselves
 * generated). The store's `start()` method returns a sanitized id.
 */
export function sessionPath(id: string): string {
  return join(sessionDir(), `${id}.jsonl`);
}

/**
 * Path to the JSONL log of the "current" session. This is just a stable
 * name — when the user runs `/session new`, the store swaps which id
 * the current pointer refers to, and new appends land in the new file.
 */
export function currentSessionPath(): string {
  return join(sessionDir(), 'current.jsonl');
}

/**
 * Path to the file holding the id of the current session. Plain text,
 * one line, no trailing newline requirement (we re-write the whole file
 * on change). Empty file == no current session.
 */
export function currentSessionIdPath(): string {
  return join(sessionDir(), CURRENT_SESSION_ID_FILENAME);
}
