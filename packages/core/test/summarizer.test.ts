import { describe, it, expect } from 'vitest';
import { summarizeIfNeeded } from '../src/agent/summarizer.js';
import type { ChatMessage } from '../src/agent/context.js';

function msg(content: string): ChatMessage {
  return { role: 'user', content };
}

describe('summarizeIfNeeded', () => {
  it('no-ops when history fits the budget', async () => {
    const history: ChatMessage[] = [msg('hi'), msg('hello back')];
    const r = await summarizeIfNeeded({ history, budget: 1000 });
    expect(r.summarized).toBe(false);
    expect(r.history).toEqual(history);
    expect(r.tokens).toBeLessThan(1000);
  });

  it('returns empty result for empty history', async () => {
    const r = await summarizeIfNeeded({ history: [], budget: 100 });
    expect(r.history).toEqual([]);
    expect(r.summarized).toBe(false);
    expect(r.tokens).toBe(0);
  });

  it('truncates from the front until under budget', async () => {
    // 50 messages of 100 chars each → ~50 * (25+4) = 1450 tokens
    const big: ChatMessage[] = Array.from({ length: 50 }, () => msg('a'.repeat(100)));
    const r = await summarizeIfNeeded({ history: big, budget: 200 });
    expect(r.summarized).toBe(true);
    expect(r.history.length).toBeLessThan(big.length);
    expect(r.tokens).toBeLessThanOrEqual(200);
  });

  it('prepends a synthetic system summary when generateSummary is provided', async () => {
    const big: ChatMessage[] = Array.from({ length: 20 }, () => msg('a'.repeat(100)));
    const r = await summarizeIfNeeded({
      history: big,
      budget: 200,
      generateSummary: async (dropped) => {
        // The callback should see the dropped messages.
        expect(dropped.length).toBeGreaterThan(0);
        return 'prior context (20 msgs)';
      },
    });
    expect(r.summarized).toBe(true);
    expect(r.history[0].role).toBe('system');
    expect(r.history[0].content).toBe('[Earlier summary] prior context (20 msgs)');
  });

  it('always keeps the last message even if it alone exceeds the budget', async () => {
    const huge: ChatMessage[] = [msg('a'.repeat(40)), msg('b'.repeat(40))];
    // Budget smaller than the last message alone: we still return the last message.
    const r = await summarizeIfNeeded({ history: huge, budget: 4 });
    expect(r.history.length).toBe(1);
    expect(r.history[0].content).toBe('b'.repeat(40));
    // summarized=true because the loop had to drop something.
    expect(r.summarized).toBe(true);
  });
});
