/**
 * The agent turn loop. v0.1 has no tools (chokepoint lands in phase 3),
 * so a turn is a single `streamText` call: stream the model's reply,
 * yield `text-delta` events as they arrive, end with a `done` event
 * carrying the full text. Errors (network, validation, abort) become
 * a single `error` event.
 *
 * Phase 2 (v0.1 plan) extends this with `maxSteps > 1` and a `tools`
 * registry, plus a chokepoint callback for confirmable actions. The
 * v0.1 contract is intentionally narrow: every event is one of
 * `text-delta`, `done`, `error` — and exactly one of `done`/`error`
 * is the last event in a successful/failed turn.
 */

import { streamText, type LanguageModel, type CoreMessage } from 'ai';
import type { ChatMessage } from './context.js';

export type AgentEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'done'; text: string }
  | { type: 'error'; error: Error };

export interface RunTurnOpts {
  /** Pre-built `LanguageModel` from `createModel(...)`. */
  model: LanguageModel;
  /** System prompt. Use `buildSystemPrompt('agent', env)`. */
  system: string;
  /** Conversation history (user + assistant messages). Excludes system. */
  history: readonly ChatMessage[];
  /** Optional abort signal. Honored at the next event boundary. */
  signal?: AbortSignal;
}

/**
 * Map our `ChatMessage` to the AI SDK's `CoreMessage`. v0.1 only emits
 * user/assistant messages; tool messages are ignored (no tool loop yet).
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
    // 'tool' is dropped in v0.1.
  }
  return out;
}

export async function* runTurn(opts: RunTurnOpts): AsyncIterable<AgentEvent> {
  const messages = toCoreMessages(opts.history);
  let fullText = '';
  try {
    const result = streamText({
      model: opts.model,
      system: opts.system,
      messages,
      abortSignal: opts.signal,
      maxSteps: 1,
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
      }
      // Other chunk types (reasoning, tool-call, finish, error, source,
      // file, response-metadata) are ignored in v0.1.
    }
    yield { type: 'done', text: fullText };
  } catch (err) {
    yield {
      type: 'error',
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
}
