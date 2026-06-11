/**
 * v0.2.A.3 — `generatePostmortem` tests.
 *
 * 5 tests:
 *  - happy path: structured 4-section postmortem from a real LLM response
 *  - quiet-turn shortcut: empty fires => QUIET_FALLBACK, no LLM call
 *  - timeout: never throws, returns error message
 *  - LLM throws: never throws, returns error message
 *  - truncation: 20k-char turnText is sliced to <= 4000 chars in the prompt
 *
 * The `ai` package is mocked at the module level via `vi.mock` so we
 * can control `generateText` deterministically. vitest hoists
 * `vi.mock` above all imports, which is what we need for the
 * `generateText` import in `supervisor-postmortem.ts` to see the mock.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the `ai` SDK before importing the SUT. The `generateText`
// implementation is overridden per-test via `vi.mocked(...).mock...`.
vi.mock('ai', () => ({
  generateText: vi.fn(),
}));

import { generateText } from 'ai';
import { generatePostmortem } from '../src/agent/supervisor-postmortem.js';
import type { SupervisorFireRecord } from '../src/agent/supervisor-types.js';
import type { LanguageModel } from 'ai';

const mockedGenerateText = vi.mocked(generateText);

const fire = (
  kind: SupervisorFireRecord['kind'],
  partial: Partial<SupervisorFireRecord> = {},
): SupervisorFireRecord => ({
  kind,
  advice: 'a',
  targetEventId: 't',
  ...(partial as object),
}) as SupervisorFireRecord;

const fakeModel = {} as unknown as LanguageModel;

beforeEach(() => {
  mockedGenerateText.mockReset();
});

describe('generatePostmortem', () => {
  it('returns a 4-section postmortem (WHAT / LEARNED / MISSING / NEXT) for a turn with fires', async () => {
    const fires: SupervisorFireRecord[] = [
      fire('loop-detected', { tool: 'nmap_scan', count: 5, recent: ['nmap_scan'] }),
      fire('overclaim', { quote: 'Scan is complete', evidence: 'no findings' }),
    ];
    mockedGenerateText.mockResolvedValue({
      text:
        'WHAT WE TRIED: ran nmap_scan 5 times.\n' +
        'LEARNED: no findings.\n' +
        'MISSING: a different tool.\n' +
        'NEXT STEP: try nuclei.',
    } as never);

    const result = await generatePostmortem({
      fires,
      model: fakeModel,
      turnText: 'Scanning...',
      timeoutMs: 1000,
    });
    expect(result.body).toMatch(/WHAT WE TRIED/);
    expect(result.body).toMatch(/LEARNED/);
    expect(result.body).toMatch(/MISSING/);
    expect(result.body).toMatch(/NEXT STEP/);
    expect(result.error).toBeUndefined();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('returns a fallback "quiet turn" postmortem when fires is empty (no LLM call)', async () => {
    const result = await generatePostmortem({
      fires: [],
      model: fakeModel,
      turnText: 'Did some recon.',
      timeoutMs: 100,
    });
    expect(result.body).toMatch(/quiet turn/);
    expect(result.body).toMatch(/recon was productive/);
    expect(result.error).toBeUndefined();
    // The quiet-turn shortcut must NOT call the LLM.
    expect(mockedGenerateText).not.toHaveBeenCalled();
  });

  it('returns a postmortemError (never throws) when the LLM call times out', async () => {
    // generateText never resolves within the timeout window.
    mockedGenerateText.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ text: 'late' } as never), 5000)),
    );
    const result = await generatePostmortem({
      fires: [fire('overclaim', { quote: 'q', evidence: 'e' })],
      model: fakeModel,
      turnText: 't',
      timeoutMs: 50, // 50ms timeout
    });
    expect(result.error).toMatch(/timeout/i);
    expect(result.body).toBe('');
  });

  it('returns a postmortemError (never throws) when the LLM call throws', async () => {
    mockedGenerateText.mockRejectedValue(new Error('API down'));
    const result = await generatePostmortem({
      fires: [fire('overclaim', { quote: 'q', evidence: 'e' })],
      model: fakeModel,
      turnText: 't',
      timeoutMs: 1000,
    });
    expect(result.error).toMatch(/API down/);
    expect(result.body).toBe('');
  });

  it('truncates long turnText to ~4000 chars before sending to the LLM', async () => {
    const longText = 'a'.repeat(20_000);
    let capturedPrompt = '';
    mockedGenerateText.mockImplementation((opts: { prompt: string }) => {
      capturedPrompt = opts.prompt;
      return Promise.resolve({
        text: 'WHAT: x\nLEARNED: y\nMISSING: z\nNEXT: w',
      } as never);
    });
    await generatePostmortem({
      fires: [fire('overclaim', { quote: 'q', evidence: 'e' })],
      model: fakeModel,
      turnText: longText,
      timeoutMs: 1000,
    });
    // The turnText section in the prompt sits between two `"""` markers
    // as `"""\n<turnText>\n"""`. So the slice between the two markers
    // is 2 chars longer than the turnText itself (leading \n + trailing
    // \n). We just check the bounds.
    const idx = capturedPrompt.indexOf('"""');
    const start = idx + 3;
    const end = capturedPrompt.indexOf('"""', start);
    const embeddedTurnText = capturedPrompt.slice(start, end);
    expect(embeddedTurnText.length).toBeLessThanOrEqual(4002);
    expect(embeddedTurnText.replace(/\n/g, '').length).toBe(4000);
  });
});
