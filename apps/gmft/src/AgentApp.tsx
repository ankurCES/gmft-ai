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
  runInner,
  runTurn,
  ToolRegistry,
  withSupervisor,
  type AgentEvent,
  type ChatMessage,
  type CreateModelOpts,
  type ExecuteResult,
  type Finding,
  type LlmConfig,
  type PromptEnv,
  type Severity,
  type SupervisorFire,
  type Tool,
  type ToolContext,
} from '@gmft/core';
import { z } from 'zod';
import {
  shellExecTool,
  nmapTool,
  dnsenumTool,
  theHarvesterTool,
  whatwebTool,
  masscanTool,
  rustscanTool,
  subfinderTool,
  dnsreconTool,
  fierceTool,
  enum4linuxTool,
  ldapsearchTool,
  nucleiTool,
  niktoTool,
  gobusterTool,
  ffufTool,
  sqlmapTool,
  httpxTool,
  wpscanTool,
  snmpcheckTool,
  evilTwinTool,
  wifiDeauthTool,
  wifiteScanTool,
  bettercapTool,
  aircrackTool,
  kismetTool,
  reportWriteTool,
  reportPdfTool,
  runnerCapabilities,
} from '@gmft/tools';
import { App, type AppProps } from './App.js';
import type { Message as Msg } from './ui/components/Message.js';
import type { StatusInfo } from './ui/components/StatusRail.js';
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
 * v0.3.B — full 27-tool registry used by `/run <tool> [args...]`.
 *
 * The agent loop's `DEFAULT_TOOLS` is a 5-tool subset because the
 * LLM gets a tighter, more focused set. The slash command is a
 * human-invoked path: the operator typed the tool name, so we
 * honor the full catalog. Destructive + type-to-confirm tools are
 * still gated by the chokepoint (with no `onConfirmation` wired,
 * they're denied with a clear reason — see `runToolForSession`).
 */
function buildCatalogRegistry(): ToolRegistry {
  const r = new ToolRegistry();
  // The registry's `register` is generic on the input/output Zod
  // shape. A homogeneous array literal (e.g. `[shellExecTool,
  // nmapTool]`) gets TS to infer `Tool<ShellExecInput, ShellExecOutput>`
  // from the first element, then complains about the rest. Casting
  // the whole array to `Tool<z.ZodTypeAny, z.ZodTypeAny>[]` widens
  // the element type so each call infers independently — and that
  // matches the registry's internal storage shape exactly.
  const all: Tool<z.ZodTypeAny, z.ZodTypeAny>[] = [
    shellExecTool,
    nmapTool,
    dnsenumTool,
    theHarvesterTool,
    whatwebTool,
    masscanTool,
    rustscanTool,
    subfinderTool,
    dnsreconTool,
    fierceTool,
    enum4linuxTool,
    ldapsearchTool,
    nucleiTool,
    niktoTool,
    gobusterTool,
    ffufTool,
    sqlmapTool,
    httpxTool,
    wpscanTool,
    snmpcheckTool,
    evilTwinTool,
    wifiDeauthTool,
    wifiteScanTool,
    bettercapTool,
    aircrackTool,
    kismetTool,
    reportWriteTool,
    reportPdfTool,
  ] as unknown as Tool<z.ZodTypeAny, z.ZodTypeAny>[];
  for (const t of all) {
    r.register(t);
  }
  return r;
}

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
   * Optional override model id for the supervisor's end-of-turn postmortem.
   * When set, the supervisor builds a second `LanguageModel` from this id
   * (same provider / apiKey / endpoint as the primary) and passes it to
   * `withSupervisor({ model })`. When unset, the supervisor uses the
   * primary `llmModel` (built from `model`).
   *
   * Wired in v0.3.A.3 from `cli.tsx`'s `--supervisor-model <id>` flag.
   */
  supervisorModelId?: string;
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
   * v0.3.B — per-invocation allowlist loaded from `--scope <path>`.
   * When non-empty, the chokepoint denies any `targetRequired` tool
   * call whose `args.target` is not in the list. Loaded by `cli.tsx`
   * at boot; AgentApp just threads it through to `readChokepointEnv`.
   * Undefined / empty = no allowlist (back-compat with pre-v0.3.B
   * operators).
   */
  allowlist?: readonly string[];
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
  supervisorModelId,
  allowlist,
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

  // v0.1 phase 6 — live status (toolCalls, tokens, findings, severity
  // tally). Owned here, updated from the agent loop's `tool-result`
  // events, and passed to App as a controlled prop. App renders the
  // StatusRail from this object. The shape is the full StatusInfo
  // because callers (cli.tsx, tests) initialize from `initialStatus`
  // and the only field that changes mid-run is toolCalls/findings;
  // model/provider/sandbox stay at their initial values for the life
  // of the session.
  const [status, setStatus] = useState<StatusInfo>(() => ({
    model: appProps.initialConfig?.model ?? 'none',
    provider: appProps.initialConfig?.provider ?? 'none',
    // v0.2.D — the rail starts with the host's auto-resolved mode. As
    // soon as the first tool runs, the `tool-result` handler below
    // will overwrite this with the actual `RunResult.mode` from the
    // runner (e.g. `host+landlock+seccomp` if both kernel layers
    // applied, or `host` if neither did). The rail's `SandboxField`
    // color-codes kernel-enforced modes green and bare host yellow.
    sandbox: runnerCapabilities().resolvedAuto,
    ...(sessionTarget ? { target: sessionTarget } : {}),
    tokensIn: 0,
    tokensOut: 0,
    toolCalls: 0,
    findings: 0,
    findingsBySeverity: { info: 0, low: 0, medium: 0, high: 0, critical: 0 },
    // v0.2.A.3 — supervisor state for the current turn. Defaults to
    // 'quiet' (no fires, no postmortem) and 0 fires. Updated from
    // `wrapped.lastFires()` and `wrapped.lastPostmortem()` after each
    // turn completes.
    supervisor: 'quiet',
    fireCount: 0,
  }));

  // v0.3.A.2 — supervisor fires accumulated this session. Each fire
  // carries its own `targetEventId` (the runtime event id the rule
  // fired on) and the `Message` it should attach to is found by
  // matching `targetEventId` against any `Message.eventIds` entry.
  // We use a state array (not a Set of fires) so the transcript can
  // show multiple fires on the same target, in emission order. We
  // dedupe by `targetEventId + kind + tool-or-quote-or-text` so a
  // re-yield on re-render doesn't double up. Append-only for the life
  // of the session — the array stays small (a runaway loop generates
  // ~1 fire per turn at worst).
  const [supervisorFires, setSupervisorFires] = useState<SupervisorFire[]>([]);

  // v0.3.A.4 — session-wide audit log of every event the agent loop
  // yields (tool-call-request, tool-result, confirmation-needed,
  // supervisor-fire, supervisor-postmortem, chain-*, text-delta, done,
  // error). The AuditLogTab reads this to paginate / filter / color
  // the session. We snapshot on each event into a state array so
  // switching to the tab is a no-rerender-of-the-loop (and so the tab
  // can read a stable list, not a ref). The array is append-only for
  // the life of the session; even a runaway loop generates a bounded
  // stream per turn.
  const [auditEvents, setAuditEvents] = useState<AgentEvent[]>([]);

  // v0.3.A.2 — set of `event.id` values that the supervisor fired on
  // during the current session. Used by ChatTab to render a
  // `SupervisorFireMarker` after the assistant message whose turn
  // contained the fire. The set is append-only for the life of the
  // session; we don't prune (sessions are short-lived and the set
  // stays <1KB even with thousands of fires).
  const supervisedEventIdsRef = useRef<Set<string>>(new Set());
  // Per-turn collector: every event id we observe in the loop is pushed
  // here, and the array is attached to the assistant message we create
  // at the end of the turn. This lets ChatTab match the `targetEventId`
  // on a `SupervisorFire` back to a transcript entry.
  const currentTurnEventIdsRef = useRef<string[]>([]);

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

  // v0.3.A.3 — supervisor's end-of-turn postmortem model. Same
  // provider / apiKey / endpoint as the primary, but the model id is
  // either the override (`supervisorModelId` from the `--supervisor-model`
  // CLI flag) or the primary's model id. When the supervisor and primary
  // are the same model, the postmortem still fires (this also closes the
  // v0.2.A.3 gap where AgentApp never passed `model` to `withSupervisor`,
  // so the postmortem never actually ran in production).
  const supervisorLlmModel = useMemo(
    () =>
      createModel({
        provider: activeProvider,
        model: supervisorModelId ?? activeModel,
        apiKey: resolvedApiKey,
        ...(initialEndpoint ? { endpoint: initialEndpoint } : {}),
      }),
    [activeProvider, activeModel, resolvedApiKey, initialEndpoint, supervisorModelId],
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

  // v0.2.A.2 — the supervisor's advice injection needs the SAME array
  // to be visible to both the inner `runTurn` and the next user turn.
  // The wrapper does `historyRef.current = [...historyRef.current, msg]`
  // (immutable reassignment, never in-place push) so the next submit
  // sees the supervisor's accumulated advice. v0.1 passed
  // `history: [userMsg]` (a fresh array) which would have lost any
  // advice the supervisor pushed during the turn.
  const historyRef = useRef<ChatMessage[]>([]);

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
          // v0.3.B — direct tool invocation via `/run <tool> [args...]`.
          // Builds the chokepoint lazily so the slash command works
          // even if the user runs `/run` before submitting any LLM
          // turn (otherwise chokepointRef.current is null until the
          // first LLM-driven submit).
          runTool: (tool: string, args: readonly string[]) =>
            runToolForSession(tool, args, {
              getChokepoint: () => {
                if (chokepointRef.current === null) {
                  chokepointRef.current = createChokepoint(
                    readChokepointEnv({
                      cfg: loadConfig(),
                      ...(sessionTarget ? { sessionTarget } : {}),
                      ...(allowlist && allowlist.length > 0 ? { allowlist } : {}),
                    }),
                  );
                }
                return chokepointRef.current;
              },
            }),
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
          } else if (result.toolResult) {
            // v0.3.B — `/run` returns a rich `role: 'tool'` message
            // alongside the human-readable reply. Push it as a
            // separate transcript entry so the chat can render
            // findings / stdout excerpts with the tool color.
            setMessages((prev) => [...prev, result.toolResult!]);
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
          readChokepointEnv({
            cfg: loadConfig(),
            ...(sessionTarget ? { sessionTarget } : {}),
            // v0.3.B — per-invocation allowlist from --scope. Empty
            // array is the back-compat no-op; non-empty array is
            // enforced by `checkTarget` after the denylist check.
            ...(allowlist && allowlist.length > 0 ? { allowlist } : {}),
          }),
        );
      }
      try {
        // v0.2.A.2 — push the user message into the shared history ref
        // so the supervisor's advice (added during the turn) flows
        // into the next turn's `runTurn` call. The wrapper around
        // `runTurn` observes the event stream, runs the 3 rules, and
        // on a fire: (a) yields a `supervisor-fire` event the TUI can
        // render, and (b) pushes a `role: 'user'` advice message into
        // `historyRef.current`.
        historyRef.current = [...historyRef.current, userMsg];
        const wrapped = withSupervisor({
          runTurn: (opts) => runTurn(opts),
          runTurnOpts: {
            model: llmModel,
            system,
            history: historyRef.current,
            onConfirmation,
            tools: DEFAULT_TOOLS,
            chokepoint: chokepointRef.current,
          },
          historyRef,
          // Session-level findings aren't yet wired through AgentApp's
          // session store (A.3 work). Pass `undefined` so Rule B uses
          // an empty array internally and degrades gracefully.
          sessionFindings: undefined,
          // chokepointSessionTarget is read once at chokepoint build
          // time (line 380) and lives in chokepointRef.current's config.
          // The supervisor's Rule C.3 only consults this for the
          // `targetRequired` flag, which no current tool uses, so
          // passing undefined is safe for A.2.
          chokepointSessionTarget: undefined,
          // v0.3.A.3 — pass the supervisor's model so the wrapper
          // generates the end-of-turn postmortem (closes the v0.2.A.3
          // gap where AgentApp never passed `model`, so the postmortem
          // never ran in production). The supervisor uses its own model
          // when `--supervisor-model` is set, otherwise the primary.
          model: supervisorLlmModel,
          // v0.3.A.3 — record the actual model id used so session-log
          // review can tell whether the primary agent model or the
          // override (--supervisor-model) generated the postmortem.
          modelId: supervisorModelId ?? activeModel,
        });
        // v0.3.A.2 — start a fresh per-turn event-id collector. Every
        // event the loop yields with an `id` field (tool-call-request,
        // tool-result, etc.) gets pushed here, and we attach the array
        // to the assistant message at the end of the turn so ChatTab
        // can match a `supervisor-fire.targetEventId` back to a
        // transcript line.
        currentTurnEventIdsRef.current = [];
        for await (const ev of wrapped) {
          // v0.3.A.4 — append to the session-wide audit log. We use a
          // functional setState (avoids stale closures across turns);
          // the array is append-only so we don't need to dedupe.
          setAuditEvents((prev) => [...prev, ev]);
          // Capture event ids for the marker-rendering pass.
          // `eventIds` are on tool-call-request / tool-result /
          // confirmation-needed. Skip events without an id (text-delta,
          // done, error, supervisor-fire's own id is the targetEventId,
          // not an event we own).
          if (
            ev.type === 'tool-call-request' ||
            ev.type === 'tool-result' ||
            ev.type === 'confirmation-needed'
          ) {
            currentTurnEventIdsRef.current.push(ev.id);
          } else if (ev.type === 'supervisor-fire') {
            // Add to the session-wide set so the marker can be
            // re-rendered if the user scrolls back. Backfill the
            // per-turn collector too so the assistant message this
            // turn creates carries the id in its eventIds.
            supervisedEventIdsRef.current.add(ev.targetEventId);
            if (!currentTurnEventIdsRef.current.includes(ev.targetEventId)) {
              currentTurnEventIdsRef.current.push(ev.targetEventId);
            }
            // Append the fire to the session accumulator so ChatTab
            // can render a `SupervisorFireMarker` next to the matching
            // message. The accumulator survives across turns (the
            // marker should re-render when the user scrolls back to
            // an earlier message). Dedup is not strictly necessary —
            // the supervisor yields each fire exactly once per event —
            // but we guard against a future change that re-yields.
            setSupervisorFires((prev) => {
              const last = prev[prev.length - 1];
              if (
                last &&
                last.targetEventId === ev.targetEventId &&
                last.kind === ev.fire.kind
              ) {
                return prev;
              }
              return [...prev, ev.fire];
            });
          }
          if (ev.type === 'text-delta') {
            buffer += ev.text;
          } else if (ev.type === 'error') {
            return {
              id: `err-${startedAt}`,
              role: 'assistant',
              content: `[error] ${ev.error.message}`,
              ts: startedAt,
              // v0.3.A.2 — preserve any events captured before the
              // error so a supervisor-fire that triggered the abort
              // still gets a marker in the transcript.
              eventIds: [...currentTurnEventIdsRef.current],
            };
          } else if (ev.type === 'tool-result') {
            // v0.1 phase 6 — update the live status bar.
            // 1. Always bump the tool-call counter (deny decisions
            //    still count as a tool call from the user's POV).
            // 2. If the tool produced findings, tally them by severity.
            //    The `output` is `unknown`; we only trust the shape
            //    `output.findings: Array<{ severity: string }>`. Anything
            //    else is a no-op (the executor's extractFindings is the
            //    authoritative path; this is a UI-side mirror that
            //    updates faster than the sidecar fsync).
            // 3. v0.2.D — update the sandbox field with the runner's
            //    actual mode. The host runner emits `RunResult.mode`
            //    ∈ `'host' | 'host+landlock' | 'host+seccomp' |
            //    'host+landlock+seccomp' | 'docker'`. A denied call
            //    (ev.ok === false, no output) records `'unsandboxed'`
            //    so the rail shows the user a red ✗ that maps to the
            //    audit log entry.
            setStatus((prev) => {
              const next = { ...prev, toolCalls: prev.toolCalls + 1 };
              if (!ev.ok) {
                // Chokepoint denied or runner refused; record the
                // audit-side mode so the user can correlate the rail
                // with the audit log.
                if (ev.reason !== undefined && ev.reason.length > 0) {
                  next.sandbox = 'unsandboxed';
                }
                return next;
              }
              if (!ev.output || typeof ev.output !== 'object') {
                return next;
              }
              const out = ev.output as { mode?: unknown; findings?: unknown };
              if (
                out.mode === 'docker' ||
                out.mode === 'host' ||
                out.mode === 'host+landlock' ||
                out.mode === 'host+seccomp' ||
                out.mode === 'host+landlock+seccomp'
              ) {
                next.sandbox = out.mode;
              }
              const findings = out.findings;
              if (!Array.isArray(findings) || findings.length === 0) {
                return next;
              }
              const tally: Record<Severity, number> = { ...prev.findingsBySeverity };
              let added = 0;
              for (const f of findings) {
                if (!f || typeof f !== 'object') continue;
                const sev = (f as { severity?: unknown }).severity;
                if (typeof sev !== 'string') continue;
                if (sev !== 'info' && sev !== 'low' && sev !== 'medium' && sev !== 'high' && sev !== 'critical') {
                  continue;
                }
                tally[sev] = (tally[sev] ?? 0) + 1;
                added += 1;
              }
              if (added === 0) return next;
              return { ...next, findings: prev.findings + added, findingsBySeverity: tally };
            });
          }
        }
        const finalText = buffer || '(empty response)';
        const assistantMsg: ChatMessage = {
          role: 'assistant',
          content: finalText,
          ts: startedAt,
          // v0.3.A.2 — snapshot the per-turn event id collector so the
          // ChatTab can match each `SupervisorFire.targetEventId` back
          // to a transcript line. Copy (not freeze) because the ref
          // gets reset on the next turn.
          eventIds: [...currentTurnEventIdsRef.current],
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
          // v0.3.A.2 — surface the captured event ids so the parent
          // component (App) can attach them to the same Msg it stores
          // in messages[]. Matches `assistantMsg.eventIds` above.
          eventIds: [...currentTurnEventIdsRef.current],
        };
      } catch (err) {
        return {
          id: `err-${startedAt}`,
          role: 'assistant',
          content: `[error] ${err instanceof Error ? err.message : String(err)}`,
          ts: startedAt,
          // v0.3.A.2 — preserve captured event ids on throw too
          // (e.g. broker race) so the marker-rendering pass still
          // has a target.
          eventIds: [...currentTurnEventIdsRef.current],
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
      status={status}
      onExit={onExit ?? handleExit}
      pendingApprovals={pendingApprovals}
      onApprovalResolve={resolveApproval}
      // v0.3.A.2 — fires accumulated this session, used by ChatTab to
      // render SupervisorFireMarker lines next to the matching message.
      supervisorFires={supervisorFires}
      // v0.3.A.4 — full event log of the session, used by the new
      // AuditLogTab to paginate / filter / color the agent loop's
      // yield stream.
      auditEvents={auditEvents}
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

/**
 * v0.3.B — the `/run <tool> [args...]` slash command's executor.
 *
 * The slash dispatcher calls this closure with the tool name and
 * a free-form arg list. We:
 *   1. Build the full 27-tool registry once (cached at module
 *      scope; tools are registered lazily because the agent loop
 *      doesn't need the destructive / type-to-confirm tools).
 *   2. Lazily build the chokepoint if it isn't already built
 *      (otherwise `/run` would crash on a fresh TUI before the
 *      first LLM submit).
 *   3. Translate the slash args into a Zod-friendly `args` object
 *      using a small convention: first arg is `target`, the rest
 *      are joined into a single `options` string (the way an
 *      operator would type a CLI invocation).
 *   4. Hand off to `runInner` from `@gmft/core`, which runs the
 *      full chokepoint + tool-run pipeline.
 *   5. Format the `ExecuteResult` as a `Msg` (role: 'tool') with
 *      the tool's output, error, or denial reason.
 *
 * Destructive + type-to-confirm tools are denied with a clear
 * "no handler provided" reason (see `runInner` at
 * packages/core/src/tools/executor.ts:155). Operators who want
 * the high-friction wifi attacks run from the LLM-driven path
 * (where the approval prompt renders inline).
 */
const CATALOG_REGISTRY = buildCatalogRegistry();

async function runToolForSession(
  tool: string,
  args: readonly string[],
  opts: { getChokepoint: () => ReturnType<typeof createChokepoint> },
): Promise<{ msg: Msg; denied: boolean }> {
  const chokepoint = opts.getChokepoint();
  const toolCtx: ToolContext = {
    cwd: process.cwd(),
    env: process.env,
    cfg: { sandbox: { mode: 'host' as const } },
  };
  // Translate the slash args into the tool's expected arg shape.
  // Convention: first token is `target`; remaining tokens are
  // joined as `options` (the binary's CLI flags). Tools without
  // `targetRequired` get the full arg list as `options` and
  // `target` is omitted. This matches the way operators type
  // `/run <tool> <args...>` at the prompt.
  const toolEntry = CATALOG_REGISTRY.get(tool);
  if (!toolEntry) {
    return {
      msg: {
        id: `run-${Date.now()}-unknown`,
        role: 'tool',
        content: `Unknown tool: ${tool}`,
        ts: Date.now(),
      },
      denied: true,
    };
  }
  const isTargetRequired = toolEntry.flags.includes('targetRequired');
  const toolArgs: Record<string, unknown> = isTargetRequired
    ? {
        target: args[0] ?? '',
        ...(args.length > 1 ? { options: args.slice(1).join(' ') } : {}),
      }
    : args.length > 0
      ? { options: args.join(' ') }
      : {};

  const result: ExecuteResult = await runInner(
    tool,
    toolArgs,
    CATALOG_REGISTRY,
    chokepoint,
    toolCtx,
    // No `onConfirmation`: high-friction tools are denied with a
    // clear "needs confirmation but no handler provided" reason.
    // The LLM-driven path is the right place to run destructive
    // tools interactively.
  );

  const ts = Date.now();
  if (result.ok) {
    const out = result.output as Record<string, unknown>;
    // Tools that produce findings store them under `findings`; the
    // rest typically have `summary` or `stdout` (a string). We
    // stringify whatever the tool returned so the chat gets a
    // readable transcript entry.
    let body: string;
    if (typeof out.stdout === 'string') {
      body = out.stdout;
    } else if (typeof out.summary === 'string') {
      body = out.summary;
    } else if (Array.isArray(out.findings)) {
      body = `${tool} produced ${out.findings.length} finding(s).`;
    } else {
      body = JSON.stringify(out, null, 2);
    }
    return {
      msg: {
        id: `run-${ts}-ok`,
        role: 'tool',
        content: body,
        ts,
        toolCallId: `run-${ts}`,
      },
      denied: false,
    };
  }
  // Failure path — denied (chokepoint) or runtime error.
  return {
    msg: {
      id: `run-${ts}-fail`,
      role: 'tool',
      content:
        (result.error ? `${result.reason}: ${result.error}` : result.reason) ??
        'unknown failure',
      ts,
    },
    denied: result.denied === true,
  };
}
