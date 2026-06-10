/**
 * Thin wrapper around `App` that wires a real LLM `onSubmit`. v0.1 has
 * no tools (chokepoint lands in phase 3), so a turn is a single
 * `streamText` call. Streaming deltas are accumulated into the final
 * assistant message and returned to `App` once the stream completes.
 *
 * The App is unaware of the LLM — it just calls `onSubmit(text)` and
 * expects a `Message | null` back. That keeps the TUI layer testable
 * with a stub `onSubmit` (see `app-e2e.test.tsx`) and the LLM layer
 * testable with a stub App (see `useAgent.test.tsx`).
 *
 * Slash commands (1.5e) are handled by the App's `handleSubmit` (the
 * stub `/help` and `/clear` branches were already there in 1.5d). The
 * full slash dispatcher lands in `apps/gmft/src/session/commands.ts`
 * and is wired in by `cli.tsx` via the App's `onSubmit` prop — AgentApp
 * is only invoked for non-slash inputs.
 *
 * Persistence: AgentApp accepts an `onTurnComplete` callback. After
 * every LLM turn, the final user+assistant pair is forwarded so the
 * SessionStore can append to the JSONL log. The CLI installs that
 * callback; tests don't need it.
 */

import { useCallback, useMemo } from 'react';
import {
  buildSystemPrompt,
  createModel,
  runTurn,
  type ChatMessage,
  type CreateModelOpts,
  type PromptEnv,
} from '@gmft/core';
import { App, type AppProps } from './App.js';
import type { Message as Msg } from './ui/components/Message.js';

export interface AgentAppProps extends Omit<AppProps, 'onSubmit'> {
  /** LLM model + auth material (from config + secret store). */
  model: CreateModelOpts;
  /** Environment metadata for the system prompt. */
  env: PromptEnv;
  /**
   * Optional initial history to hydrate from a resumed session.
   * Pass the `Turn[]` from `SessionStore.load(id)` (converted to
   * `Message[]` by the caller) here. When set, the App shows those
   * messages on first paint.
   */
  initialMessages?: Msg[];
  /**
   * Called once per completed LLM turn with the final user + assistant
   * pair. Used by the session store to append to the JSONL log. NOT
   * called for slash commands (those don't go through the LLM).
   */
  onTurnComplete?: (turns: { user: ChatMessage; assistant: ChatMessage }) => void;
}

export function AgentApp({
  model,
  env,
  onTurnComplete,
  ...appProps
}: AgentAppProps): React.JSX.Element {
  const system = useMemo(() => buildSystemPrompt('agent', env), [env]);
  const llmModel = useMemo(() => createModel(model), [model]);

  const handleSubmit = useCallback(
    async (value: string): Promise<Msg | null> => {
      const userMsg: ChatMessage = { role: 'user', content: value };
      const startedAt = Date.now();
      let buffer = '';
      try {
        for await (const ev of runTurn({
          model: llmModel,
          system,
          history: [userMsg],
        })) {
          if (ev.type === 'text-delta') {
            buffer += ev.text;
          } else if (ev.type === 'error') {
            return {
              id: `err-${startedAt}`,
              role: 'assistant',
              content: `[error] ${ev.error.message}`,
              ts: startedAt,
            };
          }
        }
        const finalText = buffer || '(empty response)';
        const assistantMsg: ChatMessage = {
          role: 'assistant',
          content: finalText,
          ts: startedAt,
        };
        onTurnComplete?.({ user: userMsg, assistant: assistantMsg });
        return {
          id: `a-${startedAt}`,
          role: 'assistant',
          content: finalText,
          ts: startedAt,
        };
      } catch (err) {
        return {
          id: `err-${startedAt}`,
          role: 'assistant',
          content: `[error] ${err instanceof Error ? err.message : String(err)}`,
          ts: startedAt,
        };
      }
    },
    [llmModel, system, onTurnComplete],
  );

  return <App {...appProps} onSubmit={handleSubmit} />;
}
