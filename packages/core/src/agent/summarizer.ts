/**
 * History summarization. v0.1: drop the oldest messages from a chat
 * history until the total token estimate fits under a budget. If a
 * `generateSummary` callback is provided, prepend a synthetic
 * `system` message summarizing the dropped chunk (the actual LLM call
 * to produce the summary lives in phase 2; v0.1 accepts a precomputed
 * string or skips the summary).
 *
 * Always keeps the last message. If a single message is over budget
 * the function returns it as-is and reports `summarized: false` (the
 * caller is expected to fail loud in that case).
 */

import type { ChatMessage } from './context.js';
import { totalTokens } from './context.js';

export interface SummarizeOpts {
  history: readonly ChatMessage[];
  /** Max total tokens allowed in the returned history. */
  budget: number;
  /**
   * Optional callback to summarize a dropped chunk. v0.1 callers usually
   * skip this; phase 2 wires a real LLM call here. The returned string
   * is prepended to the kept messages as a `system` role message.
   */
  generateSummary?: (chunk: readonly ChatMessage[]) => Promise<string>;
}

export interface SummarizeResult {
  history: ChatMessage[];
  /** True iff at least one message was dropped (i.e. budget triggered). */
  summarized: boolean;
  /** Total tokens of the returned history. */
  tokens: number;
}

export async function summarizeIfNeeded(opts: SummarizeOpts): Promise<SummarizeResult> {
  const { history, budget, generateSummary } = opts;

  if (history.length === 0) {
    return { history: [], summarized: false, tokens: 0 };
  }
  if (totalTokens(history) <= budget) {
    return {
      history: [...history],
      summarized: false,
      tokens: totalTokens(history),
    };
  }

  // Drop from the front until under budget. Always keep at least the
  // last message (don't return an empty list).
  const dropped: ChatMessage[] = [];
  let kept = [...history];
  while (kept.length > 1 && totalTokens(kept) > budget) {
    dropped.push(kept.shift()!);
  }

  let summary: string | null = null;
  if (generateSummary && dropped.length > 0) {
    summary = await generateSummary(dropped);
  }

  const final: ChatMessage[] = summary
    ? [{ role: 'system', content: `[Earlier summary] ${summary}` }, ...kept]
    : kept;
  return {
    history: final,
    summarized: dropped.length > 0,
    tokens: totalTokens(final),
  };
}
