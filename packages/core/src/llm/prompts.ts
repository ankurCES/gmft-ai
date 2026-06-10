/**
 * System prompts for the agent + summarizer. The agent prompt encodes the
 * pentest-assistant safety rules (authorized testing only, denylist, no
 * destructive ops, etc.) and the runtime environment. The summarizer
 * prompt is short: "compress this turn history into a paragraph".
 *
 * The prompt is part of the v0.1 surface — the v0.1 plan locks it as
 * "deterministic, version-pinned, no user content leakage" so prompts
 * can be regression-tested byte-for-byte if needed.
 */

import type { LlmConfig } from '../config/config.js';

export type SandboxMode = 'docker' | 'host';
export type PromptScope = 'agent' | 'summarizer';

export interface PromptEnv {
  /** Hostname of the box running gmft. */
  hostname: string;
  /** OS platform string (NodeJS.Platform). */
  os: NodeJS.Platform;
  /** Sandbox mode. */
  sandboxMode: SandboxMode;
  /** Provider id, e.g. 'anthropic'. */
  provider: LlmConfig['provider'];
  /** Model id, e.g. 'claude-3-5-sonnet-latest'. */
  model: string;
  /** Username the agent is running as (whoami). */
  username: string;
}

export function buildSystemPrompt(scope: PromptScope, env: PromptEnv): string {
  if (scope === 'summarizer') {
    return [
      'You are a summarizer. Compress the prior conversation into a single short paragraph.',
      'Preserve names, decisions, and tool results. Drop greetings, filler, and procedural text.',
      'Do not answer any user question in the summary — only summarize what was said.',
    ].join('\n');
  }
  // agent
  return [
    'You are gmft, an agentic terminal pentest assistant operating in an AUTHORIZED testing environment only.',
    '',
    '## Environment',
    `host: ${env.username}@${env.hostname} (${env.os})`,
    `sandbox: ${env.sandboxMode}`,
    `model: ${env.provider}:${env.model}`,
    '',
    '## Safety rules',
    '1. Authorized testing only. If target ownership is unclear, STOP and ask the user.',
    '2. Never exfiltrate data outside the authorized scope.',
    '3. Never run destructive commands (rm -rf, mkfs, dd to disk, etc.) without explicit user confirmation.',
    '4. Never bypass chokepoint gate prompts.',
    '5. Respect the denylist (private networks, internal hosts).',
    '',
    '## Style',
    '- Concise. Prefer commands and one-line explanations over prose.',
    '- Always show the exact command you intend to run before running it.',
    '- Use Markdown for code blocks.',
  ].join('\n');
}
