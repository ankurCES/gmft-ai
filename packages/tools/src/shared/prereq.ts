import { spawnSync } from 'node:child_process';

/**
 * Asserts that a binary is present and executable on the host. Returns the
 * resolved path on success, or throws an Error with a clear remediation
 * message on failure.
 */
export function assertBinary(name: string, installHint?: string): string {
  const which = process.platform === 'win32' ? 'where' : 'which';
  const r = spawnSync(which, [name], { encoding: 'utf-8' });
  if (r.status !== 0) {
    const hint = installHint ? ` (${installHint})` : '';
    throw new Error(
      `Required binary not found: ${name}${hint}. ` +
        `Install it or set GMFT_SKIP_PREREQ=1 to bypass (not recommended).`,
    );
  }
  // `which` may emit multiple paths (e.g. aliases). Take the first.
  const first = r.stdout.split('\n')[0]?.trim();
  if (!first) {
    throw new Error(`Could not resolve path for ${name}`);
  }
  return first;
}

/** True when the caller has asked us to skip prereq checks. */
export function isPrereqCheckSkipped(): boolean {
  return process.env.GMFT_SKIP_PREREQ === '1';
}
