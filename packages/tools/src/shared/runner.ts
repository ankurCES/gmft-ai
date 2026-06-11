import { spawn } from 'node:child_process';
import { assertBinary, isPrereqCheckSkipped } from './prereq';
import { applyLandlock } from './landlock.js';
import { runnerCapabilities } from './capabilities.js';
import type { LandlockApplyOpts } from './landlock.js';

/**
 * Resolve a binary name to an absolute path. Currently only handles the
 * special case of `node` (maps to `process.execPath`) so the runner is
 * robust to PATH-less environments (e.g. CI runners where `node` is not
 * on the inherited PATH for child processes). All other binaries pass
 * through unchanged and rely on PATH lookup by the OS.
 */
function resolveBin(bin: string): string {
  if (bin === 'node' || bin === 'node.exe') {
    return process.execPath;
  }
  return bin;
}

export type RunnerMode = 'docker' | 'host' | 'host+landlock';

export interface RunOptions {
  /** Args to exec, e.g. ['echo', 'hello']. */
  argv: string[];
  /** If set, overrides the default image. */
  image?: string;
  /** If set, force host mode (e.g. from a tool that must escape the sandbox). */
  forceHost?: boolean;
  /** Working directory inside the sandbox. */
  cwd?: string;
  /** Env allowlist (keys) — anything else is dropped. */
  envAllowlist?: string[];
  /** Timeout in ms. Default 30s. */
  timeoutMs?: number;
  /**
   * Filesystem paths the child may READ. When set in host mode AND
   * landlock is available, the child runs under a landlock ruleset
   * that permits read access to these paths and nothing else.
   * When unset in host mode, landlock is not applied.
   */
  fsAllowRead?: string[];
  /** Filesystem paths the child may WRITE/append/truncate. See fsAllowRead. */
  fsAllowWrite?: string[];
  /** Filesystem paths the child may CREATE regular files in. See fsAllowRead. */
  fsAllowMakeReg?: string[];
}

export interface RunResult {
  mode: RunnerMode;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  /** True if the runner fell back from docker to host. */
  fellBack: boolean;
  /** True if landlock was applied for this run (host+landlock mode). */
  sandboxed?: boolean;
  /** Landlock ABI version (1-7) when sandboxed. Undefined otherwise. */
  landlockAbi?: number;
  /** Resolved allowlist that was enforced. Undefined when not sandboxed. */
  landlockPaths?: { read: string[]; write: string[]; makeReg: string[] };
}

const DEFAULT_IMAGE = process.env.GMFT_RUNNER_IMAGE ?? 'alpine:3.20';

/**
 * Pick the runner mode. Docker is preferred (per ADR 0003). If docker
 * is unavailable, fall back to host and warn loudly.
 */
export function pickRunnerMode(opts?: { forceHost?: boolean }): {
  mode: RunnerMode;
  fellBack: boolean;
} {
  if (opts?.forceHost) {
    return { mode: 'host', fellBack: false };
  }
  if (isPrereqCheckSkipped()) {
    return { mode: 'host', fellBack: false };
  }
  try {
    assertBinary('docker', 'install Docker or set GMFT_SKIP_PREREQ=1');
    return { mode: 'docker', fellBack: false };
  } catch (err) {
    console.warn(
      '[gmft/tools] docker not found — falling back to host spawn. ' +
        'Tools will run with your shell privileges. Set GMFT_SKIP_PREREQ=1 ' +
        'to silence this warning once you have docker installed.',
      err instanceof Error ? err.message : err,
    );
    return { mode: 'host', fellBack: true };
  }
}

/**
 * Run a command via the chosen runner. The argv is forwarded as-is
 * (no shell, no &&/;/| chaining). Env is filtered by the allowlist.
 */
export async function run(opts: RunOptions): Promise<RunResult> {
  const { mode, fellBack } = pickRunnerMode({ forceHost: opts.forceHost });
  const env = filterEnv(opts.envAllowlist);
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const start = Date.now();

  if (mode === 'docker') {
    return runDocker(opts.argv, opts.image ?? DEFAULT_IMAGE, opts.cwd, env, timeoutMs, fellBack, start);
  }
  // Host mode: decide whether to apply landlock. Landlock is only
  // applied when:
  //   - the host's landlock probe reports `available`, AND
  //   - the caller passed at least one fs allowlist (an empty
  //     allowlist would lock the child down entirely, blocking
  //     its own argv/libs).
  const caps = runnerCapabilities();
  const wantsLandlock = caps.landlock === 'available' && hasAnyAllowlist(opts);
  return runHost(
    opts.argv,
    opts.cwd,
    env,
    timeoutMs,
    fellBack,
    start,
    wantsLandlock
      ? {
          fsAllowRead: opts.fsAllowRead,
          fsAllowWrite: opts.fsAllowWrite,
          fsAllowMakeReg: opts.fsAllowMakeReg,
        }
      : null,
  );
}

function hasAnyAllowlist(opts: RunOptions): boolean {
  return (
    (opts.fsAllowRead?.length ?? 0) > 0 ||
    (opts.fsAllowWrite?.length ?? 0) > 0 ||
    (opts.fsAllowMakeReg?.length ?? 0) > 0
  );
}

function runDocker(
  argv: string[],
  image: string,
  cwd: string | undefined,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  fellBack: boolean,
  start: number,
): Promise<RunResult> {
  return new Promise<RunResult>((resolve, reject) => {
    const dockerArgs = ['run', '-i', '--rm', ...(cwd ? ['-w', cwd] : []), image, ...argv];
    const child = spawn('docker', dockerArgs, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b: Buffer) => (stdout += b.toString()));
    child.stderr.on('data', (b: Buffer) => (stderr += b.toString()));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`docker run timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        mode: 'docker',
        stdout,
        stderr,
        exitCode: code ?? -1,
        durationMs: Date.now() - start,
        fellBack,
      });
    });
  });
}

function runHost(
  argv: string[],
  cwd: string | undefined,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  fellBack: boolean,
  start: number,
  landlockOpts: LandlockApplyOpts | null,
): Promise<RunResult> {
  return new Promise<RunResult>((resolve, reject) => {
    if (argv.length === 0) {
      reject(new Error('runHost called with empty argv'));
      return;
    }
    const [rawBin, ...rest] = argv;
    const bin = resolveBin(rawBin!);
    // preExec runs between fork() and exec() in the child — perfect place
    // to apply landlock rules (kernel LSM, irreversible for the child).
    const preExec =
      landlockOpts !== null
        ? () => {
            try {
              applyLandlock(landlockOpts);
            } catch (err) {
              // Landlock apply failure is fatal for the child. Bail loudly
              // via process.exit — there's no exec to return to.
              process.stderr.write(
                `[gmft/tools] failed to apply landlock: ${err instanceof Error ? err.message : err}\n`,
              );
              process.exit(126);
            }
          }
        : undefined;
    const child = spawn(bin, rest, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      ...(preExec !== undefined ? { preExec } : {}),
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b: Buffer) => (stdout += b.toString()));
    child.stderr.on('data', (b: Buffer) => (stderr += b.toString()));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`host spawn timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const sandboxed = landlockOpts !== null;
      const caps = sandboxed ? runnerCapabilities() : null;
      resolve({
        mode: sandboxed ? 'host+landlock' : 'host',
        stdout,
        stderr,
        exitCode: code ?? -1,
        durationMs: Date.now() - start,
        fellBack,
        sandboxed,
        landlockAbi: sandboxed && caps?.landlockAbi != null ? caps.landlockAbi : undefined,
        landlockPaths: sandboxed
          ? {
              read: landlockOpts.fsAllowRead ?? [],
              write: landlockOpts.fsAllowWrite ?? [],
              makeReg: landlockOpts.fsAllowMakeReg ?? [],
            }
          : undefined,
      });
    });
  });
}

function filterEnv(allowlist: string[] | undefined): NodeJS.ProcessEnv {
  if (!allowlist || allowlist.length === 0) {
    // No allowlist = inherit everything. The tool's input schema is
    // responsible for declaring what env it needs.
    return { ...process.env };
  }
  const out: NodeJS.ProcessEnv = {};
  for (const k of allowlist) {
    if (process.env[k] !== undefined) {
      out[k] = process.env[k];
    }
  }
  return out;
}
