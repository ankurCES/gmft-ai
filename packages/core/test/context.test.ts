import { describe, it, expect } from 'vitest';
import { tokenEstimate, totalTokens, type ChatMessage } from '../src/agent/context.js';

describe('tokenEstimate', () => {
  it('returns 0 for empty string', () => {
    expect(tokenEstimate('')).toBe(0);
  });

  it('approximates 1 token per 4 chars (English)', () => {
    // 13 chars / 4 = 3.25 -> ceil = 4. Allow [3, 4] for future tuning.
    const r = tokenEstimate('Hello, world!');
    expect(r).toBeGreaterThanOrEqual(3);
    expect(r).toBeLessThanOrEqual(4);
  });

  it('handles long inputs exactly', () => {
    // 400 chars / 4 = 100 exactly.
    expect(tokenEstimate('a'.repeat(400))).toBe(100);
    // 401 chars -> ceil(401/4) = 101.
    expect(tokenEstimate('a'.repeat(401))).toBe(101);
  });
});

describe('totalTokens', () => {
  it('sums per-message token estimate + 4 overhead per message', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'hi' },         // ceil(2/4) = 1, +4 = 5
      { role: 'assistant', content: 'hello' }, // ceil(5/4) = 2, +4 = 6
    ];
    expect(totalTokens(msgs)).toBe(11);
  });

  it('returns 0 for empty array', () => {
    expect(totalTokens([])).toBe(0);
  });
});
