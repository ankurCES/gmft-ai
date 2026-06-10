/**
 * The agent turn loop. v0.1 phase 3 adds:
 *
 *   - `tools` / `chokepoint` / `onConfirmation` opts. When `tools` is
 *     empty or undefined, the loop falls back to phase 2 behavior
 *     (`streamText` with no tools, single-step text delta). The v0.1
 *     contract for that path is unchanged — existing `agent-loop.test.ts`
 *     cases continue to pass.
 *
 *   - `tool-call-request` / `tool-result` / `confirmation-needed` events
 *     in the `AgentEvent` union. The first is observability
 *     (the AI SDK already dispatches tool calls; we just re-emit them
 *     for the TUI / audit log). The `tool-result` is emitted either by
 *     the SDK's chunk (on success) or by us (on chokepoint deny /
 *     user-rejected confirmation, where we short-circuit). The
 *     `confirmation-needed` is emitted when the chokepoint says
 *     `confirm`; we then await the user's y/n via `onConfirmation`.
 *
 *   - `maxSteps` defaults to 5, configurable via opts. The AI SDK
 *     drives the multi-step loop; we just observe the chunks.
 *
 * Tool dispatch model:
 *   1. SDK emits a `tool-call` chunk (the LLM decided to call a tool).
 *   2. We consult the chokepoint with the parsed args.
 *      - `deny`     → emit a `tool-result` with `ok: false, reason`,
 *                      record the call in the SDK's tool-results map
 *                      so it doesn't crash on the missing result.
 *      - `confirm`  → emit a `confirmation-needed`, await
 *                      `onConfirmation` for y/n. Approved ⇒ let the
 *                      SDK's `execute` proceed. Denied ⇒ short-circuit
 *                      same as `deny`.
 *      - `allow`    → let the SDK's `execute` proceed.
 *   3. SDK's `execute` runs the tool. SDK emits a `tool-result` chunk
 *      that we re-emit as our `tool-result` event.
 *
 * The "let the SDK's execute proceed" is done by registering a
 * `Map<toolCallId, { decision, approved? }>` and only registering the
 * tool's `execute` in the tools record if it's pre-approved. The SDK
 * does the actual calling.
 */

import { streamText, type LanguageModel, type CoreMessage } from 'ai';
import type { z } from 'zod';
import type { ChatMessage } from './context.js';
import type { Tool, ToolContext } from '../tools/types.js';
import { wrapToolsForSDK } from './tool-dispatch.js';
import type { Chokepoint, ChokepointCall, Decision } from '../chokepoint/index.js';

// v0.1 phase 3 — extended union. The phase 2 variants are unchanged,
// so existing tests for `text-delta` / `done` / `error` still pass.
export type AgentEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'done'; text: string }
  | { type: 'error'; error: Error }
  | { type: 'tool-call-request'; id: string; name: string; args: Record<string, unknown> }
  | { type: 'tool-result'; id: string; name: string; ok: boolean; output?: unknown; reason?: string }
  | { type: 'confirmation-needed'; id: string; name: string; reason: string };

export interface RunTurnOpts {
  /** Pre-built `LanguageModel` from `createModel(...)`. */
  model: LanguageModel;
  /** System prompt. Use `buildSystemPrompt('agent', env)`. */
  system: string;
  /** Conversation history (user + assistant messages). Excludes system. */
  history: readonly ChatMessage[];
  /** Optional abort signal. Honored at the next event boundary. */
  signal?: AbortSignal;

  // --- v0.1 phase 3 (all optional) ---
  /** Tools to expose to the LLM. When empty/undefined, the loop runs in phase 2 mode. */
  tools?: readonly Tool<z.ZodTypeAny, z.ZodTypeAny>[];
  /** The chokepoint gate. Required iff `tools` is non-empty. */
  chokepoint?: Chokepoint;
  /**
   * Awaited when the chokepoint returns `confirm`. The TUI wires this
   * to a y/n prompt; tests can stub it with `async () => true|false`.
   * The `id` is unique per tool call; the TUI uses it to map the
   * user's y/n back to the right awaiting promise.
   */
  onConfirmation?: (call: { id: string; name: string; args: Record<string, unknown>; reason: string }) => Promise<boolean>;
  /** Per-tool-call context. Defaults to `process.cwd()` + `process.env`. */
  ctx?: ToolContext;
  /** Max tool-call steps. Default 5. Set to 1 to match phase 2 behavior exactly. */
  maxSteps?: number;
}

/**
 * Map our `ChatMessage` to the AI SDK's `CoreMessage`. v0.1 only emits
 * user/assistant messages; tool messages are dropped (the SDK
 * rebuilds them internally from the tool-call / tool-result stream).
 */
function toCoreMessages(history: readonly ChatMessage[]): CoreMessage[] {
  const out: CoreMessage[] = [];
  for (const m of history) {
    if (m.role === 'system') {
      out.push({ role: 'system', content: m.content });
    } else if (m.role === 'user') {
      out.push({ role: 'user', content: m.content });
    } else if (m.role === 'assistant') {
      out.push({ role: 'assistant', content: m.content });
    }
    // 'tool' is dropped; the SDK manages tool messages itself.
  }
  return out;
}

export async function* runTurn(opts: RunTurnOpts): AsyncIterable<AgentEvent> {
  const messages = toCoreMessages(opts.history);
  const hasTools = Array.isArray(opts.tools) && opts.tools.length > 0;

  let toolsRecord: ReturnType<typeof wrapToolsForSDK> | undefined;
  if (hasTools) {
    if (!opts.chokepoint) {
      yield {
        type: 'error',
        error: new Error('runTurn: tools provided without chokepoint — refusing to run'),
      };
      return;
    }
    const ctx: ToolContext = opts.ctx ?? {
      cwd: process.cwd(),
      env: process.env,
      cfg: { sandbox: { mode: 'host' } },
    };
    toolsRecord = wrapToolsForSDK(opts.tools!, ctx);
  }

  // Per-call chokepoint decisions, keyed by toolCallId. Populated when
  // we see a `tool-call` chunk, consumed by the `execute` wrapper to
  // decide whether to run or short-circuit. This is the "let the loop
  // emit events, let the SDK call execute" hand-off.
  const chokepointDecisions = new Map<string, { decision: Decision; id: string }>();

  // If we built a tools record, augment each tool's `execute` to consult
  // `chokepointDecisions` first. On `deny` or refused `confirm`, throw
  // (the SDK converts to a `tool-result` chunk). On `allow` or approved
  // `confirm`, call the underlying `execute` (which is the SDK wrapper
  // from `wrapToolsForSDK`).
  if (toolsRecord && opts.chokepoint) {
    const chokepoint = opts.chokepoint;
    const onConfirmation = opts.onConfirmation;
    const baseRecord = toolsRecord;
    const augmented: typeof toolsRecord = {};
    for (const [name, entry] of Object.entries(baseRecord)) {
      const inner = entry.execute;
      augmented[name] = {
        ...entry,
        execute: async (args: unknown): Promise<unknown> => {
          // The loop has already populated chokepointDecisions for this
          // tool call by the time the SDK invokes execute. If not, the
          // SDK called execute out of order — fail loud.
          // We don't have the toolCallId here (the SDK strips it from
          // the execute args), so we use a single-slot "current" pointer
          // set by the tool-call chunk handler.
          const current = currentToolCallSlot.get(name);
          if (!current) {
            throw new Error(`chokepoint wrapper: no current tool call for "${name}"`);
          }
          const { decision, id } = current;
          if (decision.kind === 'deny') {
            throw new Error(`chokepoint denied: ${decision.reason}`);
          }
          if (decision.kind === 'confirm') {
            // The loop has already awaited onConfirmation. If we got
            // here, the user approved. (If they denied, the loop
            // short-circuited the SDK's execute call by throwing a
            // tool-result into the message stream; we never get here.)
            void id;
            void onConfirmation;
          }
          return inner(args);
        },
      };
    }
    toolsRecord = augmented;
  }

  // The "current" tool call the SDK is about to execute. Set by the
  // `tool-call` chunk handler, read by the augmented `execute`. The
  // SDK processes one tool call at a time within a step, so a single
  // slot is sufficient.
  const currentToolCallSlot = new Map<string, { decision: Decision; id: string }>();
  if (toolsRecord) {
    void chokepointDecisions; // keep eslint quiet; not used in this revision
  }

  let fullText = '';
  try {
    const result = streamText({
      model: opts.model,
      system: opts.system,
      messages,
      abortSignal: opts.signal,
      maxSteps: hasTools ? (opts.maxSteps ?? 5) : 1,
      ...(toolsRecord ? { tools: toolsRecord as unknown as Parameters<typeof streamText>[0]['tools'] } : {}),
    });
    for await (const chunk of result.fullStream) {
      if (opts.signal?.aborted) break;

      if (chunk.type === 'text-delta') {
        fullText += chunk.textDelta;
        yield { type: 'text-delta', text: chunk.textDelta };
      } else if (chunk.type === 'error') {
        const err = chunk.error instanceof Error
          ? chunk.error
          : new Error(String(chunk.error));
        yield { type: 'error', error: err };
        return;
      } else if (chunk.type === 'tool-call') {
        // The SDK is about to invoke `execute`. Consult the chokepoint.
        const toolName = chunk.toolName;
        const toolCallId = chunk.toolCallId;
        const args = (chunk.args ?? {}) as Record<string, unknown>;

        // Find the tool to get its category + flags for the chokepoint call.
        const tool = opts.tools?.find((t) => t.name === toolName);
        const decision: Decision = (() => {
          if (!tool) {
            // Unknown tool — chokepoint denies by definition.
            return { kind: 'deny', reason: `unknown tool "${toolName}"` } as const;
          }
          // Zod-validate args (the SDK will re-validate; we do it here
          // for the chokepoint so it sees typed args, not `unknown`).
          let parsedArgs: Record<string, unknown>;
          try {
            parsedArgs = tool.input.parse(args) as Record<string, unknown>;
          } catch (err) {
            return {
              kind: 'deny',
              reason: `invalid args: ${err instanceof Error ? err.message : String(err)}`,
            } as const;
          }
          const chokepointCall: ChokepointCall = {
            tool: tool.name,
            category: tool.category,
            flags: tool.flags,
            args: parsedArgs,
          };
          return opts.chokepoint!.decide(chokepointCall);
        })();

        // Always emit the request event (so the TUI shows the LLM's intent).
        yield { type: 'tool-call-request', id: toolCallId, name: toolName, args };

        if (decision.kind === 'deny') {
          // Short-circuit: emit a tool-result and skip the SDK's execute.
          // The SDK's `streamText` would crash if execute threw and there
          // was no result; we synthesize one. This is a known limitation
          // of the AI SDK 4.3.19 multi-step flow with tools that fail.
          yield {
            type: 'tool-result',
            id: toolCallId,
            name: toolName,
            ok: false,
            reason: decision.reason,
          };
          currentToolCallSlot.set(toolName, { decision, id: toolCallId });
          continue;
        }

        if (decision.kind === 'confirm') {
          // Emit the confirmation-needed event and await the user's y/n.
          yield { type: 'confirmation-needed', id: toolCallId, name: toolName, reason: decision.reason };
          const approved = opts.onConfirmation
            ? await opts.onConfirmation({ id: toolCallId, name: toolName, args, reason: decision.reason })
            : false;
          if (!approved) {
            yield {
              type: 'tool-result',
              id: toolCallId,
              name: toolName,
              ok: false,
              reason: 'user denied confirmation',
            };
            // Set currentToolCallSlot so the SDK's execute short-circuits
            // (the augmented wrapper will throw "chokepoint denied").
            currentToolCallSlot.set(toolName, {
              decision: { kind: 'deny', reason: 'user denied confirmation' },
              id: toolCallId,
            });
            continue;
          }
        }

        // allow OR approved-confirm: let the SDK's execute proceed.
        currentToolCallSlot.set(toolName, { decision: { kind: 'allow' }, id: toolCallId });
      }
      // Other chunk types (reasoning, source, file, step-start, step-finish,
      // tool-call-streaming-start, tool-call-delta, tool-result-as-part-of-message,
      // response-metadata, finish) are observed but not surfaced as AgentEvents.
    }
    yield { type: 'done', text: fullText };
  } catch (err) {
    yield {
      type: 'error',
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
}
