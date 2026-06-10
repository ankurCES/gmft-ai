/**
 * The single chokepoint + dispatch path. Every tool invocation
 * — from the agent loop, from a test, from a future REST/gRPC
 * surface — funnels through `execute(call, ctx, chokepoint, registry)`.
 *
 * Steps:
 *   1. Look up the tool in the registry. Unknown tool ⇒ deny.
 *   2. Validate `args` against the tool's Zod input schema.
 *   3. Ask the chokepoint for a `Decision`.
 *      - `deny`        ⇒ return `{ ok: false, reason, decision }`
 *      - `confirm`     ⇒ call `opts.onConfirmation(call)`. If it
 *                         resolves `false`, return denial.
 *      - `allow`       ⇒ run `tool.run(parsed.data, ctx)`.
 *   4. Validate the runner's output against the tool's Zod output schema.
 *   5. Return `{ ok: true, output, decision }`.
 *
 * The executor does *not* retry on tool failure; the LLM sees the
 * error via the `tool-result` event and decides what to do next.
 */

import type { z } from 'zod';
import type { ToolRegistry } from './registry.js';
import type { ToolContext } from './types.js';
import type { Chokepoint, ChokepointCall, Decision } from '../chokepoint/index.js';

export interface ExecuteCall {
  name: string;
  args: Record<string, unknown>;
}

export type ExecuteResult =
  | { ok: true; output: unknown; decision: Decision }
  | { ok: false; reason: string; decision: Decision };

export interface ExecuteOpts {
  /**
   * Handler for `confirm` decisions. If absent, a confirm-required call
   * is denied with a clear reason ("no handler provided"). The agent
   * loop wires this to a `Map<id, resolver>` in `useAgent`; tests
   * can pass a stub that resolves `true` or `false` directly.
   */
  onConfirmation?: (call: ExecuteCall) => Promise<boolean>;
}

export async function execute(
  call: ExecuteCall,
  ctx: ToolContext,
  chokepoint: Chokepoint,
  registry: ToolRegistry,
  opts: ExecuteOpts = {},
): Promise<ExecuteResult> {
  const tool = registry.get(call.name);
  if (!tool) {
    return {
      ok: false,
      reason: `unknown tool "${call.name}"`,
      decision: { kind: 'deny', reason: 'unknown tool' },
    };
  }

  // 1. Zod-validate the args
  const parsed = tool.input.safeParse(call.args);
  if (!parsed.success) {
    return {
      ok: false,
      reason: `invalid args for "${call.name}": ${parsed.error.message}`,
      decision: { kind: 'deny', reason: 'invalid args' },
    };
  }

  // 2. Chokepoint
  const chokepointCall: ChokepointCall = {
    tool: tool.name,
    category: tool.category,
    flags: tool.flags,
    args: parsed.data,
  };
  const decision = chokepoint.decide(chokepointCall);

  if (decision.kind === 'deny') {
    return { ok: false, reason: decision.reason, decision };
  }
  if (decision.kind === 'confirm') {
    if (!opts.onConfirmation) {
      return {
        ok: false,
        reason: `tool "${tool.name}" needs confirmation but no handler provided`,
        decision,
      };
    }
    const approved = await opts.onConfirmation(call);
    if (!approved) {
      return { ok: false, reason: 'user denied confirmation', decision };
    }
  }

  // 3. Run the tool. The `as unknown as z.infer<O>` is safe because
  //    the registry enforced `output instanceof z.ZodObject`.
  try {
    const output = await tool.run(parsed.data, ctx);
    const validated = tool.output.parse(output);
    return { ok: true, output: validated, decision };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
      decision,
    };
  }
}
