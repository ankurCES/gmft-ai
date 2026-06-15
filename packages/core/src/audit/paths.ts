/**
 * v0.3.C — Audit log path math.
 *
 * The audit log lives at `<configDir>/gmft/audit/audit.jsonl` and the
 * HMAC key at `<configDir>/gmft/audit/audit.key`. Both are under the
 * same `audit/` subdirectory of gmft's config dir so the user can
 * `chmod -R go-rwx ~/.config/gmft/audit/` once and be done.
 *
 * This file mirrors `session/paths.ts`: tiny, leaf, no fs side
 * effects. The writer (`./writer.ts`) and the key module (`./key.ts`)
 * own the mkdir/chmod/fsync; this file is just the path math.
 */

import { join } from 'node:path';
import { configDir } from '../config/config.js';

export const AUDIT_DIRNAME = 'audit';
export const AUDIT_LOG_FILENAME = 'audit.jsonl';
export const AUDIT_KEY_FILENAME = 'audit.key';

/** `<configDir>/gmft/audit` — the directory the writer creates on first run. */
export function auditDir(): string {
  return join(configDir(), 'gmft', AUDIT_DIRNAME);
}

/** `<configDir>/gmft/audit/audit.jsonl` — the HMAC-chained log. */
export function auditLogPath(): string {
  return join(auditDir(), AUDIT_LOG_FILENAME);
}

/** `<configDir>/gmft/audit/audit.key` — the HMAC key (mode 0600). */
export function auditKeyPath(): string {
  return join(auditDir(), AUDIT_KEY_FILENAME);
}
