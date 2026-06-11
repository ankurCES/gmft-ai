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

/**
 * v0.1 phase 6 — `InnerRunner` is the seam the `attack_chain` tool
 * uses to recurse into the chokepoint + dispatch pipeline for each of
 * its sub-steps. The executor constructs the closure; the chain tool
 * just calls it.
 *
 * Returned shape mirrors `ExecuteResult` from `./executor.js` but is
 * declared here (structurally) to avoid a `types.ts ↔ executor.ts`
 * import cycle.
 */
export interface InnerRunnerResult {
  ok: boolean;
  output?: unknown;
  reason?: string;
  /** True when the chokepoint denied (or user rejected confirmation). */
  denied?: boolean;
  /** Set when the tool runner threw. */
  error?: string;
  /** Findings extracted from the tool's output (auto-appended to the store). */
  findings?: readonly import('../findings/index.js').Finding[];
  /** Per-step result status, for the attack_chain state machine. */
  status?: 'ok' | 'denied' | 'erred' | 'skipped';
}

export type InnerRunner = (
  tool: string,
  args: Record<string, unknown>,
  opts?: { suppressTypeToConfirm?: boolean },
) => Promise<InnerRunnerResult>;

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
  /**
   * v0.1 phase 6 — opt-in flag that says "this tool accepts a path
   * to a targets file in `args.target`, and the executor's
   * `executeWithScope` should fan it out across the file's lines."
   *
   * When false (the default) the tool only accepts a single target
   * in `args.target` and rejects a path-shaped target. The chokepoint
   * doesn't read this flag — it's a tool-side contract that
   * `executeWithScope` consults before fanning out.
   */
  targetsFromFile?: boolean;
  run(args: z.infer<I>, ctx: ToolContext): Promise<z.infer<O>>;
}

/**
 * v0.1 phase 6 — events the `attack_chain` tool emits as it runs.
 * The tool's `run` calls `ctx.emit(ev)` for each of its lifecycle
 * milestones; the agent loop translates these into the 4 `chain-*`
 * `AgentEvent` variants and yields them on the `runTurn` async
 * iterable. The shape here is the chain tool's emission format —
 * the loop's `AgentEvent` shape mirrors it (plus a denormalized
 * `totalSteps` on `chain-finished` for the at-a-glance hook summary).
 */
export type ChainEvent =
  | { type: 'chain-started'; chainId: string; stepCount: number }
  | { type: 'chain-step-started'; chainId: string; stepIndex: number; tool: string; name?: string }
  | {
      type: 'chain-step-finished';
      chainId: string;
      stepIndex: number;
      status: 'ok' | 'denied' | 'erred' | 'skipped';
      durationMs: number;
      findingCount: number;
      reason?: string;
    }
  | { type: 'chain-finished'; chainId: string; completed: number; denied: number; erred: number };

/** Per-call context the runner injects. */
export interface ToolContext {
  cwd: string;
  env: NodeJS.ProcessEnv;
  cfg: { sandbox: { mode: 'docker' | 'host'; defaultImage?: string } };
  /**
   * v0.1 phase 6 — optional inner runner. Set by `runInner` (executor)
   * when dispatching a tool that orchestrates sub-tools (the only such
   * tool today is `attack_chain`). Calling this recurses through the
   * chokepoint + audit pipeline with the per-call state (findings
   * store, confirmation handler) preserved.
   *
   * Tools that don't need it (most) simply ignore it. The field is
   * optional so the existing tools (nmap, nikto, etc.) keep working
   * unchanged.
   */
  innerRunner?: InnerRunner;
  /**
   * v0.1 phase 6 — optional event sink. The `attack_chain` tool calls
   * `ctx.emit(ev)` for each lifecycle milestone as it runs. The agent
   * loop provides an emitter that buffers events and yields them as
   * `chain-*` `AgentEvent` variants before the next SDK chunk
   * surfaces. The buffer approach keeps event ordering deterministic
   * (chain events interleave with `tool-result` chunks in the right
   * place) without forcing the chain tool to know about the loop's
   * async-iterable protocol.
   *
   * Tools that don't emit (most) simply ignore it. The field is
   * optional so existing tools keep working unchanged.
   */
  emit?: (event: ChainEvent) => void;
}
