/**
 * React hook that owns the agent turn state. Wires `runTurn` to React's
 * state machinery so the TUI can show streaming deltas one-by-one.
 *
 * The hook depends on React 18+ (useState/useCallback/useRef). It is the
 * "live" half of the agent; persistence + slash commands live elsewhere
 * (see `apps/gmft/src/session` and `apps/gmft/src/ui/tabs/ChatTab.tsx`).
 *
 * Test seam: this hook imports `runTurn` from `@gmft/core` via a dynamic
 * import so tests can `vi.mock('@gmft/core', ...)` and inject a fake
 * `runTurn` (see `useAgent.test.tsx`).
 *
 * v0.1 phase 6 — the hook handles 4 new `chain-*` `AgentEvent` variants
 * from the agent loop, surfacing the `attack_chain` tool's per-step
 * progress as a `chainState` ref the UI subscribes to. The 4 variants
 * interleave with `text-delta` / `tool-result` in the same async
 * iterable; the hook routes each to the right consumer. Chain state
 * is a `useRef` (not `useState`) because the UI subscribes to it via a
 * tick counter (`setChainTick` bumps on every change) — this avoids
 * a re-render storm when many chain events arrive in a single step
 * while still keeping the UI live.
 */

import { useCallback, useRef, useState } from 'react';
import type { z } from 'zod';
import type { ChatMessage, Finding, Tool } from '@gmft/core';

/**
 * The shape of the `chainState` ref the UI subscribes to. v0.1 only
 * models the active chain (no historical chains); when a chain
 * finishes, the state is held until the next chain starts so the
 * TUI can render the final summary.
 *
 * `null` ⇒ no chain has been observed this session.
 */
export interface ChainState {
  chainId: string;
  stepCount: number;
  /** Per-step progress in emission order. */
  steps: readonly ChainStep[];
  /** Totals copied from the `chain-finished` event. Undefined while the chain is in flight. */
  totals?: { completed: number; denied: number; erred: number };
  /** True after `chain-finished` was emitted. */
  done: boolean;
}

export interface ChainStep {
  index: number;
  tool: string;
  name?: string;
  status?: 'ok' | 'denied' | 'erred' | 'skipped';
  durationMs?: number;
  findingCount?: number;
  reason?: string;
}

export interface UseAgentOpts {
  /** System prompt (typically the output of `buildSystemPrompt('agent', env)`). */
  system: string;
  /** Optional initial history. */
  initialHistory?: readonly ChatMessage[];
  /**
   * The turn runner. v0.1 callers pass the real `runTurn` from
   * `@gmft/core`; tests pass a fake generator. Typed as a structural
   * shape so we don't have to import `runTurn` (which would force the
   * test to deal with the whole AI SDK module graph).
   *
   * v0.1 phase 6 — the event union now includes 4 `chain-*` variants
   * so the hook can route chain progress to `chainState`.
   */
  runTurn: (args: {
    system: string;
    history: readonly ChatMessage[];
    signal?: AbortSignal;
  }) => AsyncIterable<
    | { type: 'text-delta'; text: string }
    | { type: 'done'; text: string }
    | { type: 'error'; error: Error }
    | { type: 'tool-call-request'; id: string; name: string; args: Record<string, unknown> }
    | { type: 'tool-result'; id: string; name: string; ok: boolean; output?: unknown; reason?: string }
    | { type: 'confirmation-needed'; id: string; name: string; reason: string; prompt?: string }
    | { type: 'chain-started'; chainId: string; stepCount: number }
    | { type: 'chain-step-started'; chainId: string; stepIndex: number; tool: string; name?: string }
    | {
        type: 'chain-step-finished';
        chainId: string;
        stepIndex: number;
        status: 'ok' | 'denied' | 'erred' | 'skipped';
        durationMs: number;
        findingCount: number;
        reason?: string;
      }
    | {
        type: 'chain-finished';
        chainId: string;
        totalSteps: number;
        completed: number;
        denied: number;
        erred: number;
      }
  >;
  /** Called whenever an error event arrives. */
  onError?: (err: Error) => void;
  /**
   * v0.1 phase 4 scaffold: the catalog of tools the LLM can call.
   * The hook stores this in a ref for future use — actual tool-call
   * execution and `findings` extraction are wired in a follow-up
   * task. For now the value is unused at runtime; surfacing it on the
   * opts lets `AgentApp` route the catalog through `useAgent` without
   * duplicating the import.
   */
  tools?: readonly Tool<z.ZodTypeAny, z.ZodTypeAny>[];
}

export interface UseAgentResult {
  history: readonly ChatMessage[];
  /** True while a turn is in flight. */
  streaming: boolean;
  /** Last error from a failed turn, or null. */
  error: Error | null;
  /**
   * v0.1 phase 4 scaffold: findings surfaced from tool results.
   * Always `[]` for now — tool-call execution in the hook is a future
   * task. Surfaced as state (not a ref) so the UI subscribes via React
   * and re-renders automatically when execution lands.
   */
  findings: readonly Finding[];
  /**
   * v0.1 phase 6 — the active attack_chain's progress, or `null` if
   * no chain has been observed this session. Updated as chain events
   * arrive; the UI re-renders via `chainTick` (which bumps on every
   * chain-state change). The TUI uses this to render the per-step
   * progress panel below the chat log.
   */
  chainState: ChainState | null;
  /**
   * v0.1 phase 6 — increments on every chain-state change. The UI
   * subscribes to this rather than `chainState` directly (ref
   * mutations don't trigger re-renders) so the panel updates
   * live as each step starts/finishes.
   */
  chainTick: number;
  /** Send a user message and start a streaming turn. No-ops if busy or empty. */
  submit: (text: string) => void;
  /** Abort the in-flight turn (if any). */
  abort: () => void;
}

export function useAgent(opts: UseAgentOpts): UseAgentResult {
  const [history, setHistory] = useState<ChatMessage[]>(() => [
    ...(opts.initialHistory ?? []),
  ]);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  // v0.1 phase 4 scaffold: the findings state the UI subscribes to.
  // Empty for now (no tool execution); the slot is here so the
  // public surface is stable and the UI can wire it up before the
  // execution side lands.
  const [findings] = useState<Finding[]>([]);
  // Mirror the latest `opts.tools` into a ref so a future revision
  // that reads it inside the turn loop doesn't have to re-create
  // `submit` on every render. Unused at runtime for now.
  const toolsRef = useRef(opts.tools);
  toolsRef.current = opts.tools;
  void toolsRef;
  const abortRef = useRef<AbortController | null>(null);
  // v0.1 phase 6 — chain state lives in a ref (mutated on every chain
  // event) and a `chainTick` counter (incremented on every change)
  // that drives the re-render. The TUI reads `chainState.current`
  // when `chainTick` changes. Bumping once per change keeps the
  // re-render count proportional to the chain's event count, not
  // the SDK's chunk count.
  const chainStateRef = useRef<ChainState | null>(null);
  const [chainTick, setChainTick] = useState(0);

  const submit = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      if (streaming) return;

      const userMsg: ChatMessage = {
        role: 'user',
        content: trimmed,
        ts: Date.now(),
      };
      const assistantMsg: ChatMessage = {
        role: 'assistant',
        content: '',
        ts: Date.now(),
      };
      // Snapshot the history that will be sent to runTurn. We include
      // the new user message but not the empty assistant placeholder
      // (the LLM produces the assistant content, not us).
      const sentHistory: ChatMessage[] = [...history, userMsg];

      setError(null);
      setHistory((h) => [...h, userMsg, assistantMsg]);
      setStreaming(true);

      const ac = new AbortController();
      abortRef.current = ac;

      void (async () => {
        let lastText = '';
        try {
          for await (const ev of opts.runTurn({
            system: opts.system,
            history: sentHistory,
            signal: ac.signal,
          })) {
            if (ac.signal.aborted) break;
            if (ev.type === 'text-delta') {
              lastText += ev.text;
              setHistory((h) => {
                const next = [...h];
                const last = next[next.length - 1];
                if (last && last.role === 'assistant') {
                  next[next.length - 1] = { ...last, content: lastText };
                }
                return next;
              });
            } else if (ev.type === 'error') {
              setError(ev.error);
              opts.onError?.(ev.error);
            } else if (ev.type === 'chain-started') {
              chainStateRef.current = {
                chainId: ev.chainId,
                stepCount: ev.stepCount,
                steps: [],
                done: false,
              };
              setChainTick((t) => t + 1);
            } else if (ev.type === 'chain-step-started') {
              const cur = chainStateRef.current;
              if (cur && cur.chainId === ev.chainId) {
                chainStateRef.current = {
                  ...cur,
                  steps: [
                    ...cur.steps,
                    { index: ev.stepIndex, tool: ev.tool, ...(ev.name !== undefined ? { name: ev.name } : {}) },
                  ],
                };
                setChainTick((t) => t + 1);
              }
            } else if (ev.type === 'chain-step-finished') {
              const cur = chainStateRef.current;
              if (cur && cur.chainId === ev.chainId) {
                // Find the matching step (started earlier) and
                // annotate it; if not found, append a new step entry.
                // The chain tool always emits step-started before
                // step-finished for the same index, so the find is
                // the common path. `cur.steps[idx]` is `undefined`
                // per noUncheckedIndexedAccess even when idx is
                // in-bounds, so we narrow with a local.
                const existing = cur.steps.find((s) => s.index === ev.stepIndex);
                const updated: ChainStep = {
                  ...(existing ?? { index: ev.stepIndex, tool: '' }),
                  index: ev.stepIndex,
                  tool: existing?.tool ?? '',
                  status: ev.status,
                  durationMs: ev.durationMs,
                  findingCount: ev.findingCount,
                  ...(ev.reason !== undefined ? { reason: ev.reason } : {}),
                };
                const idx = existing ? cur.steps.indexOf(existing) : -1;
                const nextSteps =
                  idx >= 0
                    ? cur.steps.map((s, i) => (i === idx ? updated : s))
                    : [...cur.steps, updated];
                chainStateRef.current = { ...cur, steps: nextSteps };
                setChainTick((t) => t + 1);
              }
            } else if (ev.type === 'chain-finished') {
              const cur = chainStateRef.current;
              if (cur && cur.chainId === ev.chainId) {
                chainStateRef.current = {
                  ...cur,
                  totals: { completed: ev.completed, denied: ev.denied, erred: ev.erred },
                  done: true,
                };
                setChainTick((t) => t + 1);
              }
            }
            // 'done', 'tool-call-request', 'tool-result', 'confirmation-needed'
            // are observed but not surfaced to the hook's state — the
            // TUI handles those directly (rendered by the parent
            // component that wires `onConfirmation`).
          }
        } finally {
          setStreaming(false);
          abortRef.current = null;
        }
      })();
    },
    [history, streaming, opts],
  );

  const abort = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return { history, streaming, error, findings, chainState: chainStateRef.current, chainTick, submit, abort };
}
