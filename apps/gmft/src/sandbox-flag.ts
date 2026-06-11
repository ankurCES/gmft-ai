/**
 * v0.2.D — parse the `--sandbox` CLI flag. Valid values: `auto`,
 * `docker`, `host`. Anything else throws a clear error so the CLI
 * can exit with a useful message.
 *
 * Extracted from `cli.tsx` so it can be unit-tested without booting
 * the whole Ink runtime.
 */

export type SandboxFlag = 'auto' | 'docker' | 'host';

const SANDBOX_VALUES: ReadonlySet<SandboxFlag> = new Set(['auto', 'docker', 'host']);

export function parseSandboxFlag(raw: string | undefined): SandboxFlag {
  if (raw === undefined) return 'auto';
  if (SANDBOX_VALUES.has(raw as SandboxFlag)) return raw as SandboxFlag;
  throw new Error(
    `Invalid --sandbox value: "${raw}". Must be one of: auto, docker, host.`,
  );
}
