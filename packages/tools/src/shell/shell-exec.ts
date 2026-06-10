import { z } from 'zod';
import type { Tool, ToolContext } from '@gmft/core';
import { run } from '../shared/runner';

export const ShellExecInput = z.object({
  argv: z.array(z.string()).min(1).describe('Args to execute. No shell, no chaining.'),
  cwd: z.string().optional().describe('Working directory (sandbox only).'),
  timeoutMs: z.number().int().positive().max(120_000).optional(),
  envAllowlist: z.array(z.string()).optional().describe('Env keys to forward to the child.'),
});

export const ShellExecOutput = z.object({
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number().int(),
  durationMs: z.number().int().nonnegative(),
  mode: z.enum(['docker', 'host']),
  fellBack: z.boolean(),
});

export type ShellExecInputT = z.infer<typeof ShellExecInput>;
export type ShellExecOutputT = z.infer<typeof ShellExecOutput>;

/** Chars that must NEVER appear in argv — these would imply shell chaining. */
const FORBIDDEN_CHARS = ['&', '|', ';', '`', '$', '\n', '\r', '>', '<'];

function assertSafeArgv(argv: string[]): void {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    for (const c of FORBIDDEN_CHARS) {
      if (a.includes(c)) {
        throw new Error(
          `shell_exec: forbidden character '${c}' in argv[${i}] — ` +
            `pass arguments as separate array entries, not a shell string`,
        );
      }
    }
  }
}

export const shellExecTool: Tool<typeof ShellExecInput, typeof ShellExecOutput> = {
  name: 'shell_exec',
  category: 'shell',
  description:
    'Run a single command in a sandboxed container (or on the host if docker is unavailable). ' +
    'Args are forwarded as-is; no shell is invoked. Destructive calls go through the chokepoint confirm gate.',
  input: ShellExecInput,
  output: ShellExecOutput,
  flags: ['destructive'],
  async run(input: ShellExecInputT, _ctx: ToolContext): Promise<ShellExecOutputT> {
    assertSafeArgv(input.argv);
    const r = await run({
      argv: input.argv,
      cwd: input.cwd,
      timeoutMs: input.timeoutMs,
      envAllowlist: input.envAllowlist,
    });
    return {
      stdout: r.stdout,
      stderr: r.stderr,
      exitCode: r.exitCode,
      durationMs: r.durationMs,
      mode: r.mode,
      fellBack: r.fellBack,
    };
  },
};
