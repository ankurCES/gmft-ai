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
}

export function AgentApp({ model, env, ...appProps }: AgentAppProps): React.JSX.Element {
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
        return {
          id: `a-${startedAt}`,
          role: 'assistant',
          content: buffer || '(empty response)',
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
    [llmModel, system],
  );

  return <App {...appProps} onSubmit={handleSubmit} />;
}
