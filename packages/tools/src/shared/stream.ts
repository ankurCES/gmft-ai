import { spawn } from 'node:child_process';

export interface SpawnStreamingOpts {
  /** Args to exec. No shell, no chaining. */
  argv: string[];
  /** Called for every stdout chunk. */
  onStdout: (chunk: string) => void;
  /** Called for every stderr chunk. */
  onStderr: (chunk: string) => void;
  /** Default 30s. */
  timeoutMs?: number;
  /** Working directory. */
  cwd?: string;
  /** Env override. Defaults to filtered process.env. */
  env?: NodeJS.ProcessEnv;
}

export interface SpawnStreamingResult {
  exitCode: number;
  durationMs: number;
}

/**
 * Spawn a child process and stream its stdout/stderr to the given
 * callbacks. Distinct from `run` in `./runner.ts` which buffers
 * stdout — this is for tools that produce a lot of output and the
 * caller wants to see it live (nuclei, nikto in phase 5; reserved
 * for those, not used by the 4 phase 4 tools which all use the
 * existing buffered `run`).
 */
export function spawnStreaming(opts: SpawnStreamingOpts): Promise<SpawnStreamingResult> {
  const { argv, onStdout, onStderr, timeoutMs = 30_000, cwd, env } = opts;
  if (argv.length === 0) {
    return Promise.reject(new Error('spawnStreaming called with empty argv'));
  }
  const [bin, ...rest] = argv;
  const start = Date.now();
  return new Promise<SpawnStreamingResult>((resolve, reject) => {
    const child = spawn(bin!, rest, {
      cwd,
      env: env ?? { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    child.stdout.on('data', (b: Buffer) => onStdout(b.toString()));
    child.stderr.on('data', (b: Buffer) => onStderr(b.toString()));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`spawnStreaming timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`spawnStreaming: ${bin} exited with code ${code}`));
        return;
      }
      resolve({ exitCode: code, durationMs: Date.now() - start });
    });
  });
}
