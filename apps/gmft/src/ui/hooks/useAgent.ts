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
 */

import { useCallback, useRef, useState } from 'react';
import type { z } from 'zod';
import type { ChatMessage, Finding, Tool } from '@gmft/core';

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
   */
  runTurn: (args: {
    system: string;
    history: readonly ChatMessage[];
    signal?: AbortSignal;
  }) => AsyncIterable<{ type: 'text-delta'; text: string } | { type: 'done'; text: string } | { type: 'error'; error: Error }>;
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
            }
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

  return { history, streaming, error, findings, submit, abort };
}
