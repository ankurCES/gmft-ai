/**
 * `attack_chain` — execute a sequence of tools as a single confirmed
 * operation. v0.1 phase 6's architectural centerpiece.
 *
 * Why a chain tool: most real attacks (nmap → nikto → nuclei → exploit)
 * are multi-step, and the chokepoint prompting the user per-step makes
 * the user lose the forest for the trees. The chain tool:
 *
 *   1. Asks the user to type `attack` once (covers the whole chain).
 *   2. Runs each step in sequence, with shared session findings.
 *   3. Stops on the first deny/error (default) or continues (optional).
 *   4. Emits `chain-*` events for the TUI's `ChainPane` to render.
 *
 * The chokepoint integration is handled by `runInner` — each step
 * recurses through `ctx.innerRunner`, which is a closure the executor
 * built around `runInner` with `suppressTypeToConfirm: true`. Per-step
 * destructive + target checks still fire; the chain's own
 * `typeToConfirm: 'attack'` covers the per-step elevated friction.
 *
 * Cap of 20 steps: mitigates the "LLM tricked into 20-step chain"
 * risk. A chain that needs > 20 steps is probably trying to do too
 * much; the user can re-invoke the chain.
 *
 * The output shape is consumed by the TUI's `ChainPane` (one row per
 * step with the right status badge) and by the `report_write` tool's
 * audit summary (chainId + totals + nested steps).
 */

import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { Tool, ToolContext } from '@gmft/core';

export const ChainStepInput = z.object({
  tool: z.string().min(1).describe('Tool name to call. Must be a registered tool (e.g. "nmap", "nikto").'),
  args: z.record(z.unknown()).describe('Args to forward to the step. Zod-validated by the step tool.'),
  name: z.string().min(1).max(64).optional().describe('Optional human-readable name for the step (UI + audit).'),
});
export type ChainStepInputT = z.infer<typeof ChainStepInput>;

export const AttackChainInput = z.object({
  steps: z.array(ChainStepInput).min(1).max(20).describe('Sequence of tool calls. Capped at 20.'),
  /**
   * When true (default), stop the chain on the first deny or error
   * and mark remaining steps as `skipped`. When false, continue past
   * failures (useful for "try every exploit" sweeps).
   */
  stopOnDeny: z.boolean().default(true).describe('Stop the chain on the first deny (default true).'),
});
export type AttackChainInputT = z.infer<typeof AttackChainInput>;

export const StepStatusSchema = z.enum(['ok', 'denied', 'erred', 'skipped']);
export type StepStatus = z.infer<typeof StepStatusSchema>;

export const ChainStepOutput = z.object({
  tool: z.string(),
  name: z.string().optional(),
  status: StepStatusSchema,
  findingCount: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  reason: z.string().optional(),
});
export type ChainStepOutputT = z.infer<typeof ChainStepOutput>;

export const ChainTotals = z.object({
  total: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  denied: z.number().int().nonnegative(),
  erred: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
});
export type ChainTotalsT = z.infer<typeof ChainTotals>;

export const AttackChainOutput = z.object({
  chainId: z.string(),
  steps: z.array(ChainStepOutput),
  totals: ChainTotals,
});
export type AttackChainOutputT = z.infer<typeof AttackChainOutput>;

/**
 * The chain's per-step events, surfaced via `ctx.emit`. The agent
 * loop translates these into the 4 new `AgentEvent` variants
 * (`chain-started`, `chain-step-started`, `chain-step-finished`,
 * `chain-finished`).
 */
export type ChainEvent =
  | { type: 'chain-started'; chainId: string; stepCount: number }
  | { type: 'chain-step-started'; chainId: string; stepIndex: number; tool: string; name?: string }
  | {
      type: 'chain-step-finished';
      chainId: string;
      stepIndex: number;
      status: StepStatus;
      durationMs: number;
      findingCount: number;
      reason?: string;
    }
  | {
      type: 'chain-finished';
      chainId: string;
      totalSteps: number;
      completed: number;
      denied: number;
      erred: number;
      skipped: number;
    };

export const ATTACK_CHAIN_TOOL: Tool<typeof AttackChainInput, typeof AttackChainOutput> = {
  name: 'attack_chain',
  category: 'binary',
  description:
    'Execute a sequence of tools as a single confirmed operation. The user types "attack" once to approve the whole chain; per-step destructive + target checks still fire. ' +
    'Capped at 20 steps. Each step is run via the chokepoint + dispatch pipeline; findings from each step are appended to the session findings.jsonl sidecar. ' +
    'Useful for attack chains like: nmap -> nikto -> nuclei -> exploit. By default, stops on the first deny/error (set stopOnDeny=false to continue).',
  input: AttackChainInput,
  output: AttackChainOutput,
  // The chain itself is destructive + elevated. The chain's own
  // typeToConfirm='attack' covers the per-step elevated friction
  // (runInner sets suppressTypeToConfirm: true on inner calls).
  flags: ['destructive', 'requiresElevation'],
  typeToConfirm: 'attack',
  async run(args: AttackChainInputT, ctx: ToolContext): Promise<AttackChainOutputT> {
    const chainId = randomUUID();
    const results: ChainStepOutputT[] = [];
    let completed = 0;
    let denied = 0;
    let erred = 0;
    let skipped = 0;

    const emit = (ev: ChainEvent): void => {
      // ctx.emit is the chain's hook for the agent loop. The loop
      // translates chain events into AgentEvent variants. Tools that
      // are invoked outside the agent loop (tests, REST) can pass a
      // ctx without `emit`; in that case the events are silent.
      const fn = (ctx as ToolContext & { emit?: (e: ChainEvent) => void }).emit;
      if (typeof fn === 'function') fn(ev);
    };

    emit({ type: 'chain-started', chainId, stepCount: args.steps.length });

    for (let i = 0; i < args.steps.length; i++) {
      const step = args.steps[i]!;
      emit({ type: 'chain-step-started', chainId, stepIndex: i, tool: step.tool, name: step.name });

      const start = Date.now();
      let result;
      try {
        if (!ctx.innerRunner) {
          // No executor wrapping this call (e.g. direct unit test).
          // We can't dispatch through the chokepoint, so we mark the
          // step as `erred` with a clear reason and stop.
          throw new Error('attack_chain: ctx.innerRunner is not available; the chain must be dispatched via runInner');
        }
        result = await ctx.innerRunner(step.tool, step.args, { suppressTypeToConfirm: true });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        const durationMs = Date.now() - start;
        emit({ type: 'chain-step-finished', chainId, stepIndex: i, status: 'erred', durationMs, findingCount: 0, reason });
        results.push({ tool: step.tool, name: step.name, status: 'erred', findingCount: 0, durationMs, reason });
        erred++;
        if (args.stopOnDeny) {
          markSkipped(args.steps, results, emit, chainId, i, skipped);
          skipped = countSkipped(results);
          break;
        }
        continue;
      }

      const durationMs = Date.now() - start;
      let status: StepStatus;
      let reason: string | undefined;
      if (!result.ok) {
        if (result.denied) {
          status = 'denied';
          reason = result.reason;
          denied++;
        } else {
          status = 'erred';
          reason = result.reason;
          erred++;
        }
      } else {
        status = 'ok';
        completed++;
      }
      const findingCount = result.findings?.length ?? 0;
      emit({ type: 'chain-step-finished', chainId, stepIndex: i, status, durationMs, findingCount, ...(reason ? { reason } : {}) });
      const out: ChainStepOutputT = { tool: step.tool, status, findingCount, durationMs };
      if (step.name !== undefined) out.name = step.name;
      if (reason !== undefined) out.reason = reason;
      results.push(out);

      if (args.stopOnDeny && status !== 'ok') {
        markSkipped(args.steps, results, emit, chainId, i, 0);
        skipped = countSkipped(results);
        break;
      }
    }

    emit({ type: 'chain-finished', chainId, totalSteps: args.steps.length, completed, denied, erred, skipped });

    return {
      chainId,
      steps: results,
      totals: {
        total: args.steps.length,
        completed,
        denied,
        erred,
        skipped,
      },
    };
  },
};

/**
 * Mark every remaining step as `skipped` and emit per-step events
 * for them. The `skipped` reason is "previous step failed" (since
 * that's the only reason a step is skipped in the v0.1 model).
 */
function markSkipped(
  steps: ReadonlyArray<ChainStepInputT>,
  results: ChainStepOutputT[],
  emit: (ev: ChainEvent) => void,
  chainId: string,
  failedIndex: number,
  _skippedStart: number,
): void {
  for (let j = failedIndex + 1; j < steps.length; j++) {
    const s = steps[j]!;
    emit({
      type: 'chain-step-finished',
      chainId,
      stepIndex: j,
      status: 'skipped',
      durationMs: 0,
      findingCount: 0,
      reason: 'previous step failed',
    });
    const out: ChainStepOutputT = { tool: s.tool, status: 'skipped', findingCount: 0, durationMs: 0, reason: 'previous step failed' };
    if (s.name !== undefined) out.name = s.name;
    results.push(out);
  }
}

function countSkipped(results: ReadonlyArray<ChainStepOutputT>): number {
  let n = 0;
  for (const r of results) if (r.status === 'skipped') n++;
  return n;
}
