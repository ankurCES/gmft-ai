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
 *      `execute` is a thin Zod-parse + `tool.run` wrapper. It does
 *      NOT consult the chokepoint — that's the loop's job, because
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
 * This split is awkward but it's the only way to keep both the
 * wrapper testable in isolation AND the loop able to emit events at
 * the right time. See `loop.ts` for the event-emission path.
 */

import type { z } from 'zod';
import type { Tool, ToolContext } from '../tools/types.js';

/**
 * Wrap each registered tool's `run` with Zod input/output validation.
 * The SDK calls this on every LLM-issued tool call. The wrapper does
 * NOT consult the chokepoint — see file-level comment.
 */
export function wrapToolsForSDK(
  tools: readonly Tool<z.ZodTypeAny, z.ZodTypeAny>[],
  ctx: ToolContext,
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
        const out = await t.run(parsed as never, ctx);
        return t.output.parse(out);
      },
    };
  }
  return wrapped;
}
