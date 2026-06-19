/**
 * v0.4-A.2 — `judgePlanQuality` tests. See ADR-0015.
 *
 * 6 tests:
 *  - judgePlanQuality: returns 'sufficient' when GMFT_SUPERVISOR_JUDGE != true (NOOP)
 *  - judgePlanQuality: returns 'insufficient' when LLM responds with "VERDICT: insufficient — ..."
 *  - judgePlanQuality: returns 'sufficient' when LLM responds with "unclear" (locked decision #6)
 *  - judgePlanQuality: returns 'sufficient' on LLM error (try/catch degradation)
 *  - judgePlanQuality: returns 'sufficient' on LLM timeout (10s ceiling)
 *  - judgePlanQuality: handles case-insensitive + whitespace variants of "verdict: insufficient"
 *
 * The `ai` package is mocked at the module level via `vi.mock` so we
 * can control `generateText` deterministically (same pattern as
 * supervisor-postmortem.test.ts).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('ai', () => ({
  generateText: vi.fn(),
}));

import { generateText } from 'ai';
import { judgePlanQuality } from '../src/agent/supervisor-judge.js';
import type { LanguageModel } from 'ai';

const mockedGenerateText = vi.mocked(generateText);

const fakeModel = {} as unknown as LanguageModel;

const sampleInput = {
  recentToolCalls: [{ name: 'whois' }, { name: 'nmap_scan' }],
  findingsSummary: '2 recon-class tool call(s) earlier this turn',
  triggerTool: 'sqlmap',
  triggerTarget: 'http://example.com/login',
};

describe('judgePlanQuality (v0.4-A.2)', () => {
  beforeEach(() => {
    mockedGenerateText.mockReset();
    // Default OFF — the wrapper-level env-var check gates the call;
    // these tests confirm the in-function check is also a safety net.
    delete process.env.GMFT_SUPERVISOR_JUDGE;
  });

  afterEach(() => {
    delete process.env.GMFT_SUPERVISOR_JUDGE;
  });

  it('returns sufficient when GMFT_SUPERVISOR_JUDGE is unset (NOOP)', async () => {
    process.env.GMFT_SUPERVISOR_JUDGE = 'false';
    const result = await judgePlanQuality(sampleInput, fakeModel);
    expect(result.verdict).toBe('sufficient');
    expect(result.reason).toContain('judge disabled');
    // Confirm the LLM was NEVER called when env var is unset.
    expect(mockedGenerateText).not.toHaveBeenCalled();
  });

  it('returns insufficient when LLM responds with "VERDICT: insufficient — ..."', async () => {
    process.env.GMFT_SUPERVISOR_JUDGE = 'true';
    mockedGenerateText.mockResolvedValue({
      text: 'VERDICT: insufficient — no port scan preceded the sqlmap call.',
    } as never);
    const result = await judgePlanQuality(sampleInput, fakeModel);
    expect(result.verdict).toBe('insufficient');
    expect(result.reason).toContain('VERDICT: insufficient');
  });

  it('returns sufficient when LLM responds with "unclear" (locked decision #6)', async () => {
    process.env.GMFT_SUPERVISOR_JUDGE = 'true';
    mockedGenerateText.mockResolvedValue({
      text: 'unclear — the recon tools called do not obviously justify the target.',
    } as never);
    const result = await judgePlanQuality(sampleInput, fakeModel);
    expect(result.verdict).toBe('sufficient');
  });

  it('returns sufficient on LLM error (try/catch degradation)', async () => {
    process.env.GMFT_SUPERVISOR_JUDGE = 'true';
    mockedGenerateText.mockRejectedValue(new Error('provider 503'));
    const result = await judgePlanQuality(sampleInput, fakeModel);
    expect(result.verdict).toBe('sufficient');
    expect(result.reason).toContain('provider 503');
  });

  it('returns sufficient on LLM timeout (10s ceiling, never throws)', async () => {
    process.env.GMFT_SUPERVISOR_JUDGE = 'true';
    // Simulate a provider that never resolves within the timeout window.
    mockedGenerateText.mockImplementation(
      () => new Promise(() => { /* never resolves */ }) as never,
    );
    const result = await judgePlanQuality(sampleInput, fakeModel);
    expect(result.verdict).toBe('sufficient');
    expect(result.reason).toContain('timed out');
  }, 15_000);

  it('handles case-insensitive + whitespace variants of "verdict: insufficient"', async () => {
    process.env.GMFT_SUPERVISOR_JUDGE = 'true';
    // Variant: uppercase VERDICT with extra whitespace.
    mockedGenerateText.mockResolvedValue({
      text: 'VERDICT:   INSUFFICIENT    —  the agent skipped recon entirely.',
    } as never);
    const result = await judgePlanQuality(sampleInput, fakeModel);
    expect(result.verdict).toBe('insufficient');
  });
});
