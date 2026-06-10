/*
 * Phase 1.5f — top-level AgentApp.
 *
 * Owns the chat state, the LLM model, and the slash-command dispatcher.
 * In phase 1.5e the LLM was constructed once from the initial config
 * and `/model`/`/provider` only updated the in-memory status string.
 * In phase 1.5f a real switch:
 *
 *   1. The slash command calls `onSwitchModel({provider, model})`
 *      on AgentApp.
 *   2. AgentApp resolves a fresh API key for the new provider via the
 *      `getApiKey` prop (which the CLI wires to SecretStore). This is
 *      async — `useEffect` does the resolve after the state flip.
 *   3. `useMemo` rebuilds `llmModel` from
 *      `(provider, model, resolvedApiKey, endpoint)`.
 *   4. The next `runTurn` uses the new model. A tiny "switching..."
 *      message can be appended to the chat while the key is resolving
 *      (handled by handleSubmit returning a "Resolving API key..."
 *      Msg if the user hits Enter mid-resolve — the common case is
 *      fast enough that the user never sees it).
 *
 * The slash dispatcher itself stays pure (no I/O, no React). AgentApp
 * is the only React-aware layer, and it's the only place that knows
 * about the async apiKey lookup.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  buildSystemPrompt,
  createModel,
  getDefaultModel,
  runTurn,
  type ChatMessage,
  type CreateModelOpts,
  type LlmConfig,
  type PromptEnv,
} from '@gmft/core';
import { App, type AppProps } from './App.js';
import type { Message as Msg } from './ui/components/Message.js';
import { SessionStore } from './session/store.js';
import { dispatchSlash } from './session/commands.js';

/**
 * Async API-key resolver. Returns `undefined` when the key is unset
 * (e.g. ollama). The CLI wires this to SecretStore; tests pass a
 * stub that returns a literal key.
 */
export type GetApiKey = (provider: string) => Promise<string | undefined>;

export interface AgentAppProps
  extends Omit<AppProps, 'onSubmit' | 'onMessagesChange' | 'messages'> {
  /**
   * Initial LLM model + auth material. This is what gets used for the
   * very first turn (so we don't block on a key lookup before the TUI
   * paints). Subsequent `/model` and `/provider` switches resolve
   * fresh keys via `getApiKey`.
   */
  model: CreateModelOpts;
  /**
   * Async API-key resolver. Called by AgentApp on provider switches
   * to fetch a fresh key for the new provider. Must be stable across
   * renders (wrap in `useCallback` in the caller).
   */
  getApiKey: GetApiKey;
  /**
   * Endpoint URL carried over from the boot config. Required for
   * openrouter / ollama. Phase 1.5f does NOT let the user change
   * endpoints at runtime — re-run onboarding for that. We keep the
   * initial value so a `/provider openrouter` switch still works.
   */
  endpoint?: string;
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
}

export function AgentApp({
  model,
  getApiKey,
  endpoint: initialEndpoint,
  env,
  initialMessages,
  session,
  onTurnComplete,
  onExit,
  ...appProps
}: AgentAppProps): React.JSX.Element {
  const system = useMemo(() => buildSystemPrompt('agent', env), [env]);

  // Chat state lives here so slash commands can mutate it.
  const [messages, setMessages] = useState<Msg[]>(() => initialMessages ?? []);
  // In-memory provider/model (mutated by /model and /provider).
  // We start with the values from the model factory opts, but the
  // user can switch at runtime; the change does NOT persist to config.
  const [activeProvider, setActiveProvider] = useState<LlmConfig['provider']>(model.provider);
  const [activeModel, setActiveModel] = useState<string>(model.model);
  // Resolved API key for the active provider. Initially the key that
  // was used to build the boot model; refreshed whenever the provider
  // changes (model-only switches reuse the existing key).
  const [resolvedApiKey, setResolvedApiKey] = useState<string>(model.apiKey);

  // Rebuild the live model from the current (provider, model, key, endpoint).
  // `useMemo` is sufficient — there's no async work in the rebuild
  // itself; the key has already been resolved by the effect below.
  // `endpoint` is read once from props (phase 1.5f: endpoint changes
  // require re-onboarding, not a slash command).
  const llmModel = useMemo(
    () =>
      createModel({
        provider: activeProvider,
        model: activeModel,
        apiKey: resolvedApiKey,
        ...(initialEndpoint ? { endpoint: initialEndpoint } : {}),
      }),
    [activeProvider, activeModel, resolvedApiKey, initialEndpoint],
  );

  // When the provider changes, fetch a fresh API key. Model-only
  // switches don't need a new key (same provider).
  useEffect(() => {
    if (activeProvider === model.provider && resolvedApiKey === model.apiKey) {
      // No-op: still on the boot provider with the boot key. Avoids
      // a redundant keytar read on the first render.
      return;
    }
    let cancelled = false;
    getApiKey(activeProvider)
      .then((key) => {
        if (cancelled) return;
        setResolvedApiKey(key ?? '');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // Swallow: the next runTurn will surface a clean "missing key"
        // error from the model factory. We don't want to crash the TUI
        // for a transient keytar hiccup.
        console.error(
          'getApiKey failed:',
          err instanceof Error ? err.message : String(err),
        );
        setResolvedApiKey('');
      });
    return () => {
      cancelled = true;
    };
    // We intentionally omit `model.provider`/`model.apiKey` from deps
    // — they're the *initial* values, not a per-render source of truth.
    // We only want to refetch when `activeProvider` changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProvider]);

  const handleSwitchModel = useCallback((next: { provider: string; model: string }) => {
    // Validate the new provider id. The slash command is the only
    // caller and it can pass any string; we silently no-op unknown
    // providers (the slash command already replied with the same
    // string, so the user sees the typo in the chat). A better UX
    // would be to reply with "unknown provider" — that lands in a
    // follow-up when we have a /model list. For now: log + keep the
    // active provider.
    const validProviders: ReadonlyArray<LlmConfig['provider']> = [
      'anthropic',
      'openai',
      'google',
      'openrouter',
      'ollama',
    ];
    if (!validProviders.includes(next.provider as LlmConfig['provider'])) {
      console.error(`AgentApp: ignoring unknown provider id "${next.provider}"`);
      return;
    }
    // If the slash command cleared the model (the legacy `/provider`
    // behavior), pick a sensible default for the new provider so the
    // next turn has a real model id. Model-only switches leave the
    // user-supplied value alone.
    const nextProvider = next.provider as LlmConfig['provider'];
    const model = next.model || (nextProvider !== activeProvider ? getDefaultModel(nextProvider) : '');
    setActiveProvider(nextProvider);
    setActiveModel(model);
  }, [activeProvider]);

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
