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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  buildSystemPrompt,
  createChokepoint,
  createModel,
  getDefaultModel,
  readChokepointEnv,
  loadConfig,
  runTurn,
  type ChatMessage,
  type CreateModelOpts,
  type LlmConfig,
  type PromptEnv,
} from '@gmft/core';
import {
  shellExecTool,
  nmapTool,
  dnsenumTool,
  theHarvesterTool,
  whatwebTool,
  reportWriteTool,
  reportPdfTool,
} from '@gmft/tools';
import { App, type AppProps } from './App.js';
import type { Message as Msg } from './ui/components/Message.js';
import { SessionStore } from './session/store.js';
import {
  dispatchSlash,
  type ReportFormat,
  type RunReportOpts,
  type RunReportResult,
} from './session/commands.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * v0.1 phase 4 — the default tool catalog. The agent loop in
 * `runTurn` consults this list when deciding what to expose to the
 * LLM. Today the hook layer doesn't drive tool execution; the LLM
 * turn is the one that pulls these in. AgentApp threads them
 * through `runTurn` so the loop is ready when the LLM asks for a
 * tool — the chokepoint is built lazily on first submit (we don't
 * want a config disk read on every render).
 */
const DEFAULT_TOOLS = [
  shellExecTool,
  nmapTool,
  dnsenumTool,
  theHarvesterTool,
  whatwebTool,
] as const;

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

  // Session target (from CLI --target). Read once at mount and held
  // stable for the whole session — switching hosts requires a fresh
  // `gmft --target <other>` invocation. Undefined = no scope set, in
  // which case per-call `args.target` is still format- and denylist-
  // checked but no cross-call binding is enforced. This is the only
  // seam between the CLI flag and the chokepoint.
  const sessionTarget = useMemo<string | undefined>(
    () => appProps.initialStatus?.target,
    [appProps.initialStatus?.target],
  );

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

  // Pending chokepoint confirmations. The agent loop's `onConfirmation`
  // callback resolves the user's y/n for any `confirm` decision. AgentApp
  // keeps two pieces of state:
  //   - a Map of resolvers (a ref — the loop reads it, not the UI)
  //   - a visible array of pending entries (state — drives the render)
  // The `<ApprovalPrompt>` component onResolve() pops the entry and
  // calls the resolver.
  //
  // The ref+state split is necessary because the runTurn call site is
  // a useCallback (stable across renders) and can't read state without
  // a re-create. The ref lets the callback always see the latest
  // resolvers; the state is what the UI subscribes to.
  // v0.1 phase 5 — the chokepoint gate. `prompt` is set when the
  // decision was `type-then-confirm`; the user must type the literal
  // `prompt` string to approve. For plain `confirm` it's undefined
  // and the UI renders a y/n.
  type PendingApproval = { id: string; name: string; args: Record<string, unknown>; reason: string; prompt?: string };
  const [pendingApprovals, setPendingApprovals] = useState<PendingApproval[]>([]);
  const approvalResolversRef = useRef<Map<string, (approved: boolean) => void>>(new Map());

  // v0.1 phase 4 — the chokepoint gate. Built lazily on the first
  // submit (not at render time) because `loadConfig` does a sync
  // disk read. We cache it in a ref so subsequent submits don't
  // re-read. The ref is also the seam tests use to disable the
  // chokepoint — see the agent-app test which never reaches this
  // path (its runTurn is mocked).
  const chokepointRef = useRef<ReturnType<typeof createChokepoint> | null>(null);

  const onConfirmation = useCallback(
    async (call: { id: string; name: string; args: Record<string, unknown>; reason: string; prompt?: string }): Promise<boolean> => {
      return new Promise<boolean>((resolve) => {
        approvalResolversRef.current.set(call.id, resolve);
        setPendingApprovals((prev) => [
          ...prev,
          {
            id: call.id,
            name: call.name,
            args: call.args,
            reason: call.reason,
            ...(call.prompt !== undefined ? { prompt: call.prompt } : {}),
          },
        ]);
      });
    },
    [],
  );

  const resolveApproval = useCallback((id: string, approved: boolean): void => {
    const resolver = approvalResolversRef.current.get(id);
    if (resolver) {
      resolver(approved);
      approvalResolversRef.current.delete(id);
    }
    setPendingApprovals((prev) => prev.filter((p) => p.id !== id));
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
          runReport: (opts: RunReportOpts) => runReportForSession(session, opts),
          openFile: openFileInOS,
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
      // v0.1 phase 4 — lazily build the chokepoint on first submit
      // (not at render time, since `loadConfig` is a sync disk read).
      // The cached ref means subsequent submits reuse the gate.
      if (chokepointRef.current === null) {
        chokepointRef.current = createChokepoint(
          readChokepointEnv({ cfg: loadConfig(), ...(sessionTarget ? { sessionTarget } : {}) }),
        );
      }
      try {
        for await (const ev of runTurn({
          model: llmModel,
          system,
          history: [userMsg],
          onConfirmation,
          tools: DEFAULT_TOOLS,
          chokepoint: chokepointRef.current,
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
    [llmModel, system, onTurnComplete, session, messages, activeProvider, activeModel, handleSwitchModel, handleExit, onConfirmation],
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
      pendingApprovals={pendingApprovals}
      onApprovalResolve={resolveApproval}
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

/**
 * Resolve the current session id, returning null if there is no
 * session (or the store is a noop). Used by `/report` to pick the
 * findings file. Mirrors `SessionStore.currentId()` but stays
 * private to this module so tests can inject a `noop` store.
 */
async function resolveSessionId(session: SessionStore | undefined): Promise<string | null> {
  if (!session) return null;
  return session.currentId();
}

/**
 * Run a report tool against the current session's findings.
 *
 * The session id is the filename: `<baseDir>/<id>.jsonl`. If the
 * session has no findings yet, the tools will write an empty report
 * (no error). The `baseDir` is `session.directory` for live sessions
 * and a throwaway temp dir for the noop store.
 */
async function runReportForSession(
  session: SessionStore | undefined,
  opts: RunReportOpts,
): Promise<RunReportResult> {
  const id = await resolveSessionId(session);
  if (!id) {
    throw new Error('No current session — start one with /session new first.');
  }
  // The session store is the source of truth for where the
  // findings live. Live stores have a `directory` getter; noop
  // stores have an empty one and the resolveSessionId branch above
  // already returns null for them.
  const baseDir = (session as { directory?: string }).directory;
  if (!baseDir) {
    throw new Error('Session store has no directory; cannot locate findings.');
  }
  const ctx = { cwd: process.cwd(), env: process.env, cfg: { sandbox: { mode: 'host' as const } } };
  if (opts.format === 'pdf') {
    const out = await reportPdfTool.run(
      {
        baseDir,
        sessionId: id,
        outputPath: opts.outputPath,
        severityFilter: opts.severityFilter ?? 'medium',
        includeEvidence: opts.includeEvidence ?? true,
      },
      ctx,
    );
    return {
      path: out.path,
      format: 'pdf',
      findingCount: out.findingCount,
      bytesWritten: out.bytesWritten,
    };
  }
  // md / json share the `report_write` tool
  const writeFormat: 'markdown' | 'json' = opts.format === 'json' ? 'json' : 'markdown';
  const out = await reportWriteTool.run(
    {
      baseDir,
      sessionId: id,
      format: writeFormat,
      outputPath: opts.outputPath,
      severityFilter: opts.severityFilter ?? 'medium',
      includeEvidence: opts.includeEvidence ?? true,
    },
    ctx,
  );
  return {
    path: out.path,
    // Slash command contract: external format is 'md', not 'markdown'.
    format: opts.format === 'json' ? 'json' : 'md',
    findingCount: out.findingCount,
    bytesWritten: out.bytesWritten,
  };
}

/**
 * Open a file in the OS default handler. We try `xdg-open` first
 * (Linux), then `open` (macOS), and `cmd.exe /c start` on Windows.
 * Errors are surfaced to the caller — the slash command will fall
 * back to a path-only reply.
 */
async function openFileInOS(path: string): Promise<void> {
  const cmd = process.platform === 'darwin'
    ? 'open'
    : process.platform === 'win32'
      ? 'cmd'
      : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', path] : [path];
  // Detach: xdg-open / open exit immediately after spawning the
  // viewer. We still `await` so we surface launch errors (binary
  // missing, etc.) — the caller prints a friendly message.
  await execFileAsync(cmd, args, { timeout: 5_000 });
}
