/**
 * v0.2.A.3 — `generatePostmortem`: end-of-turn postmortem generator.
 *
 * Runs ONE small LLM call after the agent loop emits a `done` event.
 * The prompt is fixed (4 sections: WHAT WE TRIED / LEARNED / MISSING /
 * NEXT STEP), the LLM has a hard 10s timeout, and the function NEVER
 * throws — a timeout or API error returns `{ body: '', error: '...' }`
 * so the wrapper can hand a well-formed record to the session log even
 * on partial failure.
 *
 * A turn with zero fires gets a hardcoded "quiet turn" fallback without
 * ever calling the LLM. That's the common case (~80% of turns are
 * routine) and saves a network round-trip.
 *
 * Design notes:
 *
 *   - The prompt truncates `turnText` to 4000 chars before sending. A
 *     long agent turn can produce 50k+ chars of streaming text; the
 *     LLM only needs the shape of the turn, not the verbatim
 *     transcript, to write a useful postmortem.
 *
 *   - The `model` parameter is the same model the agent is using. The
 *     supervisor deliberately does NOT route to a different model —
 *     the call is small (≤200 output tokens) and the cost of an extra
 *     provider in the loop outweighs the marginal quality bump.
 *
 *   - `Promise.race` with a setTimeout-rejected promise is the
 *     idiomatic zero-deps timeout. We don't use `AbortSignal` because
 *     the underlying `generateText` may not honor it across providers
 *     and we want a hard, predictable ceiling.
 */

import { generateText, type LanguageModel } from 'ai';
import type { SupervisorFireRecord } from './supervisor-types.js';

export interface GeneratePostmortemOpts {
  /** Fires recorded during the turn, in order. May be empty. */
  fires: readonly SupervisorFireRecord[];
  /** The language model to call. Same provider as the agent loop. */
  model: LanguageModel;
  /** Accumulated turn text (from text-delta events). Truncated to 4000 chars. */
  turnText: string;
  /** Hard timeout for the LLM call. Defaults to 10_000ms. */
  timeoutMs?: number;
}

export interface PostmortemResult {
  /** The 4-section postmortem body, or '' if the call failed. */
  body: string;
  /** Error message if the call failed; absent on success. */
  error?: string;
  /** Wall-clock duration of the call (or skip-to-fallback time), in ms. */
  durationMs: number;
}

/**
 * The fixed prompt template. The LLM is told to write exactly 4
 * sections in a fixed order so the TUI can parse them with a simple
 * regex.
 */
const PROMPT_TEMPLATE = (turnText: string, firesJson: string): string => `You are a multi-agent supervisor writing a brief, factual postmortem of a single agent turn.

TURN TEXT (truncated to 4000 chars):
"""
${turnText.slice(0, 4000)}
"""

SUPERVISOR FIRES THIS TURN (JSON):
${firesJson}

Write exactly 4 sections, 3-5 sentences total, no more than 200 words:

WHAT WE TRIED: <one sentence naming the main action the agent took>
LEARNED: <one sentence describing what was learned or confirmed>
MISSING: <one sentence describing what was missing — gaps, denied calls, failed tools>
NEXT STEP: <one sentence naming the most valuable next step the agent could take>

If fires is empty, write "WHAT WE TRIED: a quiet turn" and the rest of the sections should be brief.
`;

/**
 * The hardcoded fallback for a turn with zero fires. We don't call the
 * LLM at all in this case — the postmortem is mechanical.
 */
const QUIET_FALLBACK =
  'WHAT WE TRIED: a quiet turn.\n' +
  'LEARNED: the recon was productive.\n' +
  'MISSING: nothing critical.\n' +
  'NEXT STEP: continue with the next phase of the engagement.';

/**
 * Generate a postmortem for one agent turn. Never throws.
 *
 * Returns `{ body, durationMs }` on success, or
 * `{ body: '', error: '...', durationMs }` on timeout / LLM error.
 * Returns the `QUIET_FALLBACK` body without calling the LLM when
 * `fires` is empty.
 */
export async function generatePostmortem(opts: GeneratePostmortemOpts): Promise<PostmortemResult> {
  const start = Date.now();
  const timeoutMs = opts.timeoutMs ?? 10_000;

  // Empty-fires shortcut: skip the LLM call entirely. This is the
  // common case and saves a network round-trip per turn.
  if (opts.fires.length === 0) {
    return {
      body: QUIET_FALLBACK,
      durationMs: Date.now() - start,
    };
  }

  const prompt = PROMPT_TEMPLATE(opts.turnText, JSON.stringify(opts.fires, null, 2));

  try {
    const result = await Promise.race([
      generateText({ model: opts.model, prompt, maxTokens: 300 }),
      new Promise<{ text: '' }>((_, reject) =>
        setTimeout(() => reject(new Error(`postmortem timeout after ${timeoutMs}ms`)), timeoutMs),
      ),
    ]);
    return {
      body: result.text,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      body: '',
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - start,
    };
  }
}
