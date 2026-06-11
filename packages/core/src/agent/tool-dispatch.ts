/**
 * Tool-dispatch glue between the agent loop, the chokepoint, and the
 * AI SDK. Lives in its own file (not `loop.ts`) so it can be unit-tested
 * without dragging the AI SDK's `streamText` machinery into the test
 * graph.
 *
 * Architecture:
 *   1. The AI SDK's `streamText({ tools })` calls each tool's
 *      `execute(args)` on every LLM-issued tool call.
 *   2. `wrapToolsForSDK` builds the tools record for the SDK. Each
 *      `execute` is a thin Zod-parse + `runInner` wrapper when a
 *      `registry`+`chokepoint` are provided, or a Zod-parse + direct
 *      `tool.run` wrapper when not (the unit-test seam). The chokepoint
 *      decision is NOT consulted here — that's the loop's job, because
 *      the loop needs to emit `confirmation-needed` events and await
 *      the user's y/n response, which `execute` cannot do cleanly.
 *   3. The loop watches `tool-call` chunks in the SDK stream. When
 *      one arrives, it consults the chokepoint:
 *        - `deny`  → yields a `tool-result` event with `ok: false`
 *                     and short-circuits the SDK's `execute` call.
 *        - `confirm` → yields a `confirmation-needed` event, awaits
 *                     the user's y/n, then either lets `execute`
 *                     proceed (approved) or short-circuits (denied).
 *        - `allow` → lets `execute` proceed.
 *   4. The actual `execute` invocation happens inside the SDK's
 *      `streamText` machinery; we don't see it directly.
 *
 * v0.1 phase 6 — when `registry`+`chokepoint` are provided, the
 * `execute` wrapper routes through `runInner`, which:
 *   - Re-validates the args with Zod (the loop's chunk handler also
 *     validated, but the wrapper is the chokepoint's path so we
 *     validate defensively here too).
 *   - Builds a child ctx with `innerRunner` (so chain sub-tools can
 *     recurse) and `emit` (so chain events surface to the loop).
 *   - Extracts `findings` from the tool's output and appends to
 *     `opts.findingsStore` (when provided).
 *
 * The loop's chokepoint decision still gates whether `execute` is
 * even called — if the loop short-circuited, the augmented wrapper
 * throws and the SDK skips the call. If the loop approved, this
 * wrapper re-runs the chokepoint (idempotent: same args, same
 * decision) and dispatches.
 *
 * This split is awkward but it's the only way to keep both the
 * wrapper testable in isolation AND the loop able to emit events at
 * the right time. See `loop.ts` for the event-emission path.
 */

import type { z } from 'zod';
import type { Tool, ToolContext } from '../tools/types.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { Chokepoint } from '../chokepoint/index.js';
import type { FindingsStore } from '../findings/store.js';
import type { ExecuteOpts } from '../tools/executor.js';

/**
 * Wrap each registered tool's `run` with Zod input/output validation.
 * When `registry`+`chokepoint` are provided, also route through
 * `runInner` so the chokepoint integration + `innerRunner` +
 * `findingsStore` are honored. When they're omitted (the unit-test
 * seam), fall back to a direct `tool.run` call — the loop never
 * builds a tools record without the chokepoint, so this fallback
 * is dead code at runtime, only exercised by `tool-dispatch.test.ts`.
 */
export function wrapToolsForSDK(
  tools: readonly Tool<z.ZodTypeAny, z.ZodTypeAny>[],
  ctx: ToolContext,
  registry?: ToolRegistry,
  chokepoint?: Chokepoint,
  opts: ExecuteOpts & {
    /**
     * v0.1 phase 6 — forwarded to `runInner` for every tool call.
     * The chain tool needs `true` here so its per-step type prompt
     * is skipped (the chain's own `typeToConfirm: 'attack'` covers
     * the whole chain). Plain (non-chain) tool calls use the
     * default `false`.
     */
    suppressTypeToConfirm?: boolean;
    /**
     * v0.1 phase 6 — forwarded to `runInner` for every tool call.
     * When set, `runInner` reads the tool's `output.findings` (if
     * any) and appends each `Finding` to the store. The agent loop
     * threads the session's `FindingsStore` through here.
     */
    findingsStore?: FindingsStore;
  } = {},
): Record<
  string,
  { description: string; parameters: z.ZodTypeAny; execute: (args: unknown) => Promise<unknown> }
> {
  const wrapped: Record<
    string,
    { description: string; parameters: z.ZodTypeAny; execute: (args: unknown) => Promise<unknown> }
  > = {};
  for (const t of tools) {
    wrapped[t.name] = {
      description: t.description,
      parameters: t.input,
      execute: async (args: unknown): Promise<unknown> => {
        // Use `as never` for the parsed args — the Zod schema is the
        // tool's input, so the parse result matches the tool's I type.
        const parsed = t.input.parse(args) as Record<string, unknown>;
        if (!registry || !chokepoint) {
          // Thin-wrapper fallback (unit-test seam only). The runtime
          // path always passes registry+chokepoint, so this branch
          // is only exercised by `tool-dispatch.test.ts`.
          const out = await t.run(parsed as never, ctx);
          return t.output.parse(out);
        }
        // Route through `runInner` so the chokepoint + innerRunner +
        // findingsStore are honored. Imported lazily to keep the
        // thin-wrapper test from pulling in the executor's
        // findings-store / chokepoint-call graph.
        const { runInner } = await import('../tools/executor.js');
        const result = await runInner(t.name, parsed, registry, chokepoint, ctx, opts);
        if (!result.ok) {
          // Re-throw so the SDK's `execute` surfaces a `tool-result`
          // chunk with the error. The loop's tool-call chunk handler
          // already emitted a `tool-result` for short-circuited
          // calls, so this throw path is only hit for tools that
          // fail AFTER the chokepoint approved them.
          throw new Error(result.reason);
        }
        return result.output;
      },
    };
  }
  return wrapped;
}
