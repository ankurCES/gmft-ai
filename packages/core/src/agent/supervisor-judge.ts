/**
 * v0.4-A.2 — LLM judge for plan quality. See ADR-0015.
 *
 * Runs at most once per turn, only when:
 *   - the env var GMFT_SUPERVISOR_JUDGE=true is set (operator opt-in;
 *     default OFF; set via env to avoid silent latency in production)
 *   - the tool is high-blast-radius (sqlmap or nuclei; see
 *     packages/core/src/agent/supervisor.ts HIGH_BLAST_RADIUS_TOOLS)
 *   - opts.judgeModel is provided (AgentApp does NOT wire a model in
 *     v0.4-A.2; that lands in v0.4-A.4)
 *
 * The judge is strictly advisory per ADR-0009. Even when the verdict
 * is 'insufficient', the tool call proceeds. The judge's fire is a
 * breadcrumb in the operator's view and a record in the audit log.
 *
 * Verdict semantics (locked decision #6 in ADR-0014):
 *   - 'sufficient' → don't fire (the agent's recon was adequate)
 *   - 'insufficient' → fire one plan-issue advice message
 *   - anything else (LLM error, timeout, parse miss, 'unclear',
 *     refusal, empty response) → 'sufficient' (don't fire)
 *     Operator trust > catch rate on ambiguous recon.
 */

import type { LanguageModel } from 'ai';
import { generateText } from 'ai';

export type JudgeVerdict = 'sufficient' | 'insufficient';

export interface JudgeInput {
  /** Recent tool-call names this turn (no args). Up to RULE_A_WINDOW. */
  recentToolCalls: ReadonlyArray<{ name: string }>;
  /** One-line summary of recon activity this turn (derived by wrapper). */
  findingsSummary: string;
  /** The tool that triggered the judge (sqlmap or nuclei). */
  triggerTool: string;
  /** The tool's target (e.g. url for sqlmap, target for nuclei). */
  triggerTarget: string;
}

export interface JudgeResult {
  verdict: JudgeVerdict;
  reason: string;
}

/** Hard ceiling on the LLM call. Matches the postmortem timeout. */
const JUDGE_TIMEOUT_MS = 10_000;

/**
 * Match the LLM's "verdict: insufficient" response (case-insensitive,
 * whitespace-tolerant, word-bounded). Per ADR-0015 §Verdict parser.
 */
const INSUFFICIENT_RE = /verdict\s*:\s*insufficient\b/i;

const PROMPT = (input: JudgeInput): string => `
You are auditing an offensive-security agent's tool-call sequence. The
agent is about to invoke the high-blast-radius tool \`${input.triggerTool}\`
against \`${input.triggerTarget}\`.

Recent tool calls this turn:
${input.recentToolCalls.map((c, i) => `${i + 1}. ${c.name}`).join('\n') || '(none)'}

Recon activity this turn:
${input.findingsSummary}

Question: was the agent's pre-attack recon SUFFICIENT to justify running
\`${input.triggerTool}\` against \`${input.triggerTarget}\`?

Respond with exactly one line, either:
  VERDICT: sufficient — <one-sentence reason>
  VERDICT: insufficient — <one-sentence reason>
`.trim();

/**
 * Runs the LLM judge. Returns:
 *   - `{ verdict: 'sufficient', reason }` for any non-insufficient outcome
 *     (env var unset, LLM error, timeout, parse miss, unclear, empty response)
 *   - `{ verdict: 'insufficient', reason }` only when the LLM responds with
 *     a `verdict: insufficient` line
 *
 * Never throws. The judge must NEVER silently block operators.
 */
export async function judgePlanQuality(
  input: JudgeInput,
  model: LanguageModel,
): Promise<JudgeResult> {
  // The wrapper checks GMFT_SUPERVISOR_JUDGE before calling this function,
  // but the env-var check is repeated here as a redundant safety net in
  // case future call sites skip the wrapper gate. See ADR-0015 §Env-var
  // gate placement.
  if (process.env.GMFT_SUPERVISOR_JUDGE !== 'true') {
    return {
      verdict: 'sufficient',
      reason: 'judge disabled (GMFT_SUPERVISOR_JUDGE != true)',
    };
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      generateText({ model, prompt: PROMPT(input), maxTokens: 256 }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`judge timed out after ${JUDGE_TIMEOUT_MS}ms`)),
          JUDGE_TIMEOUT_MS,
        );
      }),
    ]);
    const raw = result.text;
    if (INSUFFICIENT_RE.test(raw)) {
      return { verdict: 'insufficient', reason: raw.trim() };
    }
    return { verdict: 'sufficient', reason: raw.trim() };
  } catch (err) {
    return {
      verdict: 'sufficient',
      reason: `judge errored: ${(err as Error).message}`,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
