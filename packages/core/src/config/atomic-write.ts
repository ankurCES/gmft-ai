import {
  writeFileSync,
  renameSync,
  openSync,
  fsyncSync,
  closeSync,
  unlinkSync,
} from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * Write `text` to `path` atomically by writing to a sibling temp file in
 * the same directory, fsync-ing it, then renaming it over the target.
 *
 * Why this matters: a naive `writeFileSync` truncates the target before
 * the new bytes land. If the process is killed (ENOSPC, OOM, SIGKILL)
 * mid-write, the user is left with an empty or partial config file —
 * `loadConfig` will then throw and the previous good config is lost.
 *
 * The rename approach guarantees that `path` either points at the old
 * file (if anything fails before the rename) or the new file (after).
 * The temp file lives in the same directory so `rename` is atomic
 * (not cross-device).
 *
 * Failure modes:
 * - open/write/fsync/rename throws → original file is untouched, temp is
 *   cleaned up, the error propagates.
 * - close throws after a successful fsync → temp is cleaned up, the
 *   error propagates; the original is still untouched.
 */
export function atomicWriteFileSync(path: string, text: string): void {
  const dir = dirname(path);
  const name = basename(path);
  // 16 random hex chars keep collisions effectively zero in a single dir
  const tmp = join(dir, `.${name}.${randomBytes(16).toString('hex')}.tmp`);

  let fd: number | undefined;
  try {
    fd = openSync(tmp, 'w');
    writeFileSync(fd, text);
    // Make sure the bytes are on disk before the rename becomes visible.
    // Without fsync, a power loss after rename can still leave an empty
    // file. This is the standard "write-temp-fsync-rename-fsync" pattern
    // used by git, sqlite, and most editor save logic.
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
  } catch (err) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* ignore double-close */
      }
    }
    // Best-effort cleanup of the temp on any failure
    try {
      unlinkSync(tmp);
    } catch {
      /* temp may not exist if open failed; that's fine */
    }
    throw err;
  }
}
