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
 * Phase 1.5e adds:
 *   - Slash-command handling (the dispatcher is composed into `onSubmit`,
 *     so the TUI's `handleSubmit` does the right thing transparently)
 *   - In-memory provider/model switching (no config rewrite)
 *   - Persistence: every LLM turn is appended to the SessionStore log
 *     via `onTurnComplete` (set by `cli.tsx`)
 *
 * App is now a controlled component (it reads `messages` from props and
 * reports changes via `onMessagesChange`). AgentApp owns the chat state
 * so slash commands like `/clear` and `/session load` can mutate it.
 */

import { useCallback, useMemo, useState } from 'react';
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
import { SessionStore } from './session/store.js';
import { dispatchSlash } from './session/commands.js';

export interface AgentAppProps extends Omit<AppProps, 'onSubmit' | 'onMessagesChange' | 'messages'> {
  /** LLM model + auth material (from config + secret store). */
  model: CreateModelOpts;
  /** Environment metadata for the system prompt. */
  env: PromptEnv;
  /**
   * Optional initial messages to hydrate from a resumed session.
   * The cli.tsx passes `SessionStore.load(id)` converted to `Msg[]` here.
   */
  initialMessages?: Msg[];
  /**
   * Session store. When provided, slash commands (`/session new|list|load`)
   * and turn persistence are wired up. When omitted (e.g. in tests),
   * slash commands return "no current session" replies and turns are
   * not persisted.
   */
  session?: SessionStore;
  /**
   * Called once per completed LLM turn with the final user + assistant
   * pair. Used by the session store to append to the JSONL log. NOT
   * called for slash commands.
   */
  onTurnComplete?: (turns: { user: ChatMessage; assistant: ChatMessage }) => void;
  /**
   * Called when `/exit` is typed. Production also calls useApp().exit()
   * to unmount; tests assert the call via this spy.
   */
  onExit?: () => void;
  /**
   * Called when the user requests exit (Ctrl-C). Wired by App.tsx —
   * the same callback is invoked whether the user typed `/exit` or
   * pressed Ctrl-C. AgentApp doesn't care which path triggered it.
   */
}

export function AgentApp({
  model,
  env,
  initialMessages,
  session,
  onTurnComplete,
  onExit,
  ...appProps
}: AgentAppProps): React.JSX.Element {
  const system = useMemo(() => buildSystemPrompt('agent', env), [env]);
  const llmModel = useMemo(() => createModel(model), [model]);

  // Chat state lives here so slash commands can mutate it.
  const [messages, setMessages] = useState<Msg[]>(() => initialMessages ?? []);
  // In-memory provider/model (mutated by /model and /provider).
  // We start with the values from the model factory opts, but the
  // user can switch at runtime; the change does NOT persist.
  const [activeProvider, setActiveProvider] = useState<string>(model.provider);
  const [activeModel, setActiveModel] = useState<string>(model.model);

  const handleSwitchModel = useCallback((next: { provider: string; model: string }) => {
    setActiveProvider(next.provider);
    setActiveModel(next.model);
  }, []);

  const handleExit = useCallback(() => {
    onExit?.();
  }, [onExit]);

  const handleSubmit = useCallback(
    async (value: string): Promise<Msg | null> => {
      // 1. Try to dispatch as a slash command.
      if (value.startsWith('/')) {
        // No session => the dispatcher's /session/* replies are still
        // meaningful; the other commands (/help, /clear, /model, /exit)
        // do not need a session.
        const ctx = {
          messages,
          currentProvider: activeProvider,
          currentModel: activeModel,
          // The dispatcher takes a SessionStore. If we have one, pass it;
          // otherwise, the dispatcher still works for the non-/session
          // commands. We don't want to require a session for tests.
          session: session ?? createNoopSession(),
          onSwitchModel: handleSwitchModel,
          onExit: handleExit,
        };
        const result = await dispatchSlash(value, ctx);
        if (result.kind === 'sent') {
          // shouldn't happen — dispatchSlash returns 'sent' for non-slash
          // input only. Fall through to LLM.
        } else if (result.kind === 'exited') {
          return null;
        } else {
          // 'handled'
          if (result.clearMessages) {
            setMessages([]);
          } else if (result.replaceMessages) {
            setMessages(result.replaceMessages);
          }
          return result.reply ?? null;
        }
      }

      // 2. LLM turn.
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
        // Persist + forward.
        if (session) {
          await session.append(userMsg);
          await session.append(assistantMsg);
        }
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
    [llmModel, system, onTurnComplete, session, messages, activeProvider, activeModel, handleSwitchModel, handleExit],
  );

  return (
    <App
      {...appProps}
      messages={messages}
      onMessagesChange={setMessages}
      onSubmit={handleSubmit}
      initialStatus={{
        ...(appProps.initialStatus ?? {}),
        provider: activeProvider,
        model: activeModel || 'none',
      }}
      onExit={onExit ?? handleExit}
    />
  );
}

/**
 * A SessionStore that returns empty results for every method. Used when
 * AgentApp is rendered without a session (e.g. tests, or the no-resume
 * CLI path that mounts the TUI before creating a session). The dispatcher's
 * session-related commands degrade to "no current session" replies
 * instead of throwing.
 */
function createNoopSession(): SessionStore {
  return SessionStore.noop();
}
