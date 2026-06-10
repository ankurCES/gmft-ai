/**
 * Conversation-context types + a cheap token estimator. v0.1's `tokenEstimate`
 * is the chars/4 approximation (1 token ~ 4 chars of English text). It is
 * accurate enough to drive the v0.1 summarizer's "drop oldest when over
 * budget" path. Phase 2 swaps this for a real cl100k_base tiktoken, gated
 * behind a `GMFT_TIKTOKEN=1` env var.
 */

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** Optional timestamp (epoch ms). Used by the session-log replayer. */
  ts?: number;
}

/**
 * Estimate token count for a string. v0.1: 1 token ≈ 4 chars of English
 * text. The estimate is intentionally a ceiling (`Math.ceil`) so a tight
 * budget is enforced pessimistically. Tests assert the result is in
 * [chars/4 - 1, chars/4 + 1] for a known input.
 */
export function tokenEstimate(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Total tokens for a list of messages. Adds 4 tokens per message for
 * role/format overhead (matches OpenAI's `messages` accounting rule of
 * thumb: ~4 tokens per message for role + name + content headers).
 */
export function totalTokens(messages: readonly ChatMessage[]): number {
  let n = 0;
  for (const m of messages) {
    n += tokenEstimate(m.content) + 4;
  }
  return n;
}
