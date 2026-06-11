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
 *
 * v0.1 phase 6 — `runInner` is wired into the agent loop's tool path
 * via `wrapToolsForSDK` (which now routes through `runInner` when a
 * registry + chokepoint are provided). The chain tool needs
 * `ctx.innerRunner` populated so its sub-steps can recurse through
 * the chokepoint + findings pipeline, and `ctx.emit` so its lifecycle
 * events surface as `chain-*` `AgentEvent` variants.
 *
 * The `chainEventBuffer` is a per-turn array the `emit` callback
 * pushes into. The for-await loop drains the buffer at the start of
 * each iteration (before processing the next SDK chunk), so chain
 * events interleave correctly with `tool-call-request` /
 * `tool-result` / `text-delta` chunks in the order the chain tool
 * produced them. The buffer approach is simpler than making the
 * chain tool's `run` return a nested async iterable, and keeps
 * ordering deterministic.
 */

import { streamText, type LanguageModel, type CoreMessage } from 'ai';
import type { z } from 'zod';
import type { ChatMessage } from './context.js';
import type { Tool, ToolContext, ChainEvent } from '../tools/types.js';
import { wrapToolsForSDK } from './tool-dispatch.js';
import type { Chokepoint, ChokepointCall, Decision } from '../chokepoint/index.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { FindingsStore } from '../findings/store.js';

// v0.1 phase 3 — extended union. The phase 2 variants are unchanged,
// so existing tests for `text-delta` / `done` / `error` still pass.
//
// v0.1 phase 5 — `confirmation-needed` grows an optional `prompt` field
// that, when present, signals a `type-then-confirm` decision. The TUI
// uses `prompt` to render a literal-typing input instead of a y/n.
// The field is backward-compatible: tests / UI that only care about
// y/n can ignore it.
//
// v0.1 phase 6 — 4 new `chain-*` variants surface the attack_chain
// tool's per-step progress to the TUI / useAgent hook. The shape
// mirrors the chain tool's `ChainEvent` discriminated union (see
// `tools/types.ts`), plus a denormalized `totalSteps` on
// `chain-finished` for the hook's at-a-glance summary.
export type AgentEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'done'; text: string }
  | { type: 'error'; error: Error }
  | { type: 'tool-call-request'; id: string; name: string; args: Record<string, unknown> }
  | { type: 'tool-result'; id: string; name: string; ok: boolean; output?: unknown; reason?: string }
  | { type: 'confirmation-needed'; id: string; name: string; reason: string; prompt?: string }
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
  | {
      type: 'chain-finished';
      chainId: string;
      totalSteps: number;
      completed: number;
      denied: number;
      erred: number;
    };

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
   * v0.1 phase 6 — tool registry. Required iff `tools` is non-empty.
   * The agent loop uses it to resolve tool names → tools (for
   * chokepoint metadata) and to pass into `runInner` so chain
   * sub-steps can recurse.
   */
  registry?: ToolRegistry;
  /**
   * Awaited when the chokepoint returns `confirm` or
   * `type-then-confirm`. The TUI wires this to a y/n prompt (or
   * literal-typing input when `prompt` is present); tests can stub
   * it with `async () => true|false`. The `id` is unique per tool
   * call; the TUI uses it to map the user's answer back to the right
   * awaiting promise.
   */
  onConfirmation?: (call: { id: string; name: string; args: Record<string, unknown>; reason: string; prompt?: string }) => Promise<boolean>;
  /** Per-tool-call context. Defaults to `process.cwd()` + `process.env`. */
  ctx?: ToolContext;
  /** Max tool-call steps. Default 5. Set to 1 to match phase 2 behavior exactly. */
  maxSteps?: number;
  /**
   * v0.1 phase 6 — findings store for the session. When provided,
   * the loop's per-tool-call `runInner` passes it through so the
   * findings sidecar is updated by every tool that emits findings,
   * including chain sub-steps.
   */
  findingsStore?: FindingsStore;
  /**
   * v0.1 phase 6 — passed through to `runInner` for every tool call.
   * The chain tool needs `true` here so its per-step type prompt is
   * skipped (the chain's own `typeToConfirm: 'attack'` covers the
   * whole chain). Plain (non-chain) tool calls use the default `false`.
   */
  suppressTypeToConfirm?: boolean;
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

/**
 * v0.1 phase 6 — translate a chain tool's `ChainEvent` into the
 * loop's `chain-*` `AgentEvent` variants. The translation tracks
 * the chain's `stepCount` (announced in `chain-started`) so the
 * `chain-finished` variant can carry a denormalized `totalSteps`
 * for the hook's at-a-glance summary.
 *
 * The buffer is mutated in place: each drained event is shifted off
 * the front, so a slow consumer sees events in emission order and
 * no event is yielded twice.
 */
function* drainChainEvents(
  buffer: ChainEvent[],
): Generator<Extract<AgentEvent, { type: `chain-${string}` }>> {
  // Tracks the most recent `stepCount` from `chain-started` so we
  // can attach it to `chain-finished`. Reset to undefined on
  // `chain-finished` so a stale count can't leak to a later chain.
  let currentStepCount: number | undefined;
  while (buffer.length > 0) {
    const ev = buffer.shift()!;
    switch (ev.type) {
      case 'chain-started':
        currentStepCount = ev.stepCount;
        yield { type: 'chain-started', chainId: ev.chainId, stepCount: ev.stepCount };
        break;
      case 'chain-step-started':
        yield {
          type: 'chain-step-started',
          chainId: ev.chainId,
          stepIndex: ev.stepIndex,
          tool: ev.tool,
          ...(ev.name !== undefined ? { name: ev.name } : {}),
        };
        break;
      case 'chain-step-finished':
        yield {
          type: 'chain-step-finished',
          chainId: ev.chainId,
          stepIndex: ev.stepIndex,
          status: ev.status,
          durationMs: ev.durationMs,
          findingCount: ev.findingCount,
          ...(ev.reason !== undefined ? { reason: ev.reason } : {}),
        };
        break;
      case 'chain-finished':
        yield {
          type: 'chain-finished',
          chainId: ev.chainId,
          totalSteps: currentStepCount ?? 0,
          completed: ev.completed,
          denied: ev.denied,
          erred: ev.erred,
        };
        currentStepCount = undefined;
        break;
    }
  }
}

export async function* runTurn(opts: RunTurnOpts): AsyncIterable<AgentEvent> {
  const messages = toCoreMessages(opts.history);
  const hasTools = Array.isArray(opts.tools) && opts.tools.length > 0;

  // v0.1 phase 6 — buffer of chain events the chain tool emits via
  // `ctx.emit`. Drained at the start of each chunk-iteration so chain
  // events surface in order between SDK chunks. Cleared when the turn
  // ends (or errors) so a stale buffer can't leak to the next turn.
  const chainEventBuffer: ChainEvent[] = [];

  let toolsRecord: ReturnType<typeof wrapToolsForSDK> | undefined;
  if (hasTools) {
    if (!opts.chokepoint) {
      yield {
        type: 'error',
        error: new Error('runTurn: tools provided without chokepoint — refusing to run'),
      };
      return;
    }
    if (!opts.registry) {
      yield {
        type: 'error',
        error: new Error('runTurn: tools provided without registry — refusing to run'),
      };
      return;
    }
    const baseCtx: ToolContext = opts.ctx ?? {
      cwd: process.cwd(),
      env: process.env,
      cfg: { sandbox: { mode: 'host' } },
    };
    // v0.1 phase 6 — wrap the ctx with an `emit` that pushes to the
    // chain-event buffer. The chain tool's `run` calls
    // `ctx.emit(ev)` for each lifecycle milestone; we drain the
    // buffer in the for-await loop below and yield each event as a
    // `chain-*` `AgentEvent`. The buffer is captured by closure so
    // each turn has its own.
    const ctx: ToolContext = {
      ...baseCtx,
      emit: (ev: ChainEvent) => {
        chainEventBuffer.push(ev);
      },
    };
    toolsRecord = wrapToolsForSDK(opts.tools!, ctx, opts.registry, opts.chokepoint, {
      ...(opts.findingsStore ? { findingsStore: opts.findingsStore } : {}),
      ...(opts.suppressTypeToConfirm !== undefined
        ? { suppressTypeToConfirm: opts.suppressTypeToConfirm }
        : {}),
    });
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
          if (decision.kind === 'confirm' || decision.kind === 'type-then-confirm') {
            // The loop has already awaited onConfirmation. If we got
            // here, the user approved (typed the literal prompt for
            // `type-then-confirm`, or answered y for `confirm`).
            // (If they denied, the loop short-circuited the SDK's
            // execute call by throwing a tool-result into the message
            // stream; we never get here.)
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

      // v0.1 phase 6 — drain any chain events the chain tool's
      // `execute` pushed via `ctx.emit` since the last iteration.
      // The events fire *during* the SDK's `execute` invocation
      // (i.e. between the `tool-call` chunk and the `tool-result`
      // chunk), so they end up in the buffer before the next chunk
      // surfaces. Draining here surfaces them in the right position
      // in the event stream.
      for (const ev of drainChainEvents(chainEventBuffer)) {
        yield ev;
      }

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
            typeToConfirm: tool.typeToConfirm,
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

        if (decision.kind === 'confirm' || decision.kind === 'type-then-confirm') {
          // Emit the confirmation-needed event and await the user's
          // answer. For `type-then-confirm` we also pass the literal
          // `prompt` the user must type; the TUI uses it to render a
          // literal-typing input instead of a y/n.
          const prompt = decision.kind === 'type-then-confirm' ? decision.prompt : undefined;
          yield {
            type: 'confirmation-needed',
            id: toolCallId,
            name: toolName,
            reason: decision.reason,
            ...(prompt !== undefined ? { prompt } : {}),
          };
          const approved = opts.onConfirmation
            ? await opts.onConfirmation({
                id: toolCallId,
                name: toolName,
                args,
                reason: decision.reason,
                ...(prompt !== undefined ? { prompt } : {}),
              })
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
