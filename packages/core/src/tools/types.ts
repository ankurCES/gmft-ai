/**
 * The `Tool<I,O>` interface. v0.1's first tool (`shell_exec`) and all
 * subsequent tools conform to this shape. The registry validates
 * names, categories, and Zod schemas; the executor validates args
 * and dispatches the chokepoint check.
 *
 * v0.1 categories map to the v0.1 plan §3 tool catalog. New categories
 * are added in later phases — the `binary/` slot exists in the enum
 * for phase 5's security tools (nmap, nikto, gobuster, etc.) but has
 * no registered tools yet.
 */

import type { z } from 'zod';

export type ToolCategory =
  | 'shell'   // run commands (sandboxed or host)
  | 'http'    // make HTTP requests
  | 'file'    // read/write local files
  | 'search'  // search code/content
  | 'recon'   // network recon (nmap-style, future)
  | 'binary'  // invoke a security tool binary
  | 'note';   // scratchpad / no side effects

export const TOOL_CATEGORIES: readonly ToolCategory[] = [
  'shell',
  'http',
  'file',
  'search',
  'recon',
  'binary',
  'note',
];

/**
 * A tool is a pure descriptor + a runner. The `run` function is
 * synchronous-from-the-LLM's-perspective: it returns a Promise that
 * resolves with a Zod-validatable output. The executor is responsible
 * for chokepoint checks; the tool is not.
 *
 * Flags recognized by the chokepoint:
 *   - `'destructive'`     — always Confirm
 *   - `'targetRequired'`  — args.target must pass format + denylist
 *   - `'requiresElevation'` — env-var opt-in
 */
export interface Tool<I extends z.ZodTypeAny, O extends z.ZodTypeAny> {
  name: string;
  category: ToolCategory;
  description: string;
  /** Zod schema for the input. Must be `z.object(...)`. */
  input: I;
  /** Zod schema for the output. Must be `z.object(...)`. */
  output: O;
  flags: readonly string[];
  /**
   * If set, the chokepoint returns a `type-then-confirm` decision with
   * this literal as the prompt. The TUI's <ApprovalPrompt> shows a
   * text input that the user must type the literal into before the
   * confirm button is enabled. Use for high-friction destructive
   * tools (wifi attacks, network implants).
   */
  typeToConfirm?: string;
  run(args: z.infer<I>, ctx: ToolContext): Promise<z.infer<O>>;
}

/** Per-call context the runner injects. */
export interface ToolContext {
  cwd: string;
  env: NodeJS.ProcessEnv;
  cfg: { sandbox: { mode: 'docker' | 'host'; defaultImage?: string } };
}
