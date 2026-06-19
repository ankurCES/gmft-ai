/**
 * v0.2.A.2/A.3 — the `withSupervisor` wrapper.
 *
 * Observes an inner `runTurn` `AsyncIterable<AgentEvent>`, runs the 3
 * rules from `supervisor-rules.ts` on every event, and on a fire:
 *
 *   1. Yields a `supervisor-fire` event IMMEDIATELY BEFORE the
 *      triggering event (fires and the event are emitted in the same
 *      per-event chunk: [fire(s), event]). The TUI can read the
 *      `targetEventId` to render an inline ⚠ marker next to the
 *      matching event.
 *   2. Pushes a `role: 'user'` advice message into the caller's
 *      `historyRef.current` array, so the NEXT submit's `runTurn`
 *      call (i.e. the next user turn) sees the supervisor's
 *      correction. v0.2.A.2's architecture is single-turn `runTurn`
 *      calls, not multi-step within a turn, so advice doesn't reach
 *      the LLM mid-turn — it accumulates in the ref and shows up on
 *      the next turn.
 *
 * On `done` (v0.2.A.3), all per-turn state is reset AND a 1-shot
 * postmortem LLM call is made via `generatePostmortem` (when a
 * `model` is supplied). The postmortem is yielded as a
 * `supervisor-postmortem` event and exposed via
 * `wrapper.lastPostmortem()`. The caller can capture it (via the
 * `onPostmortem` callback) and append it to the session log as a
 * `SupervisorTurnRecord`.
 *
 * On `error`, no postmortem is generated (the turn didn't produce
 * useful work) — fires are still snapshotted into `lastFires()` for
 * the caller's diagnostics.
 *
 * The `chokepointSessionTarget` is sticky across turns (it's the
 * session target, not a per-turn thing) — `createInitialState`
 * preserves it on every reset.
 *
 * The wrapper also exposes `lastFires()` — an accessor for the
 * fires from the LAST completed turn. Used by the session log
 * (Phase A.3) to record a `SupervisorTurnRecord` per turn.
 *
 * Design notes:
 *
 *   - We use `Object.assign(iterator, { lastFires, lastPostmortem })`
 *     so the returned value is both `AsyncIterable<AgentEvent>` (via
 *     the iterator protocol) and has callable `lastFires` and
 *     `lastPostmortem` methods. The cast works because
 *     `AsyncIterableIterator<T>` is duck-typed in TS — no structural
 *     mismatch to complain about.
 *
 *   - History mutation is immutable (`[...arr, msg]`, never `push`).
 *     This avoids aliasing bugs if a caller re-uses the same array
 *     reference somewhere else (e.g. the React state setter).
 *
 *   - The postmortem generator is "best effort" — a 10s timeout or
 *     a provider error never throws out of the wrapper. The result
 *     is always a well-formed `SupervisorTurnRecord` (possibly with
 *     `postmortemError` set and `body: ''`).
 */

import type { AgentEvent, RunTurnOpts } from './loop.js';
import type { LanguageModel } from 'ai';
import {
  observeRuleA,
  observeRuleB,
  observeRuleC,
  observeRuleE,
  applyFire,
} from './supervisor-rules.js';
import {
  createInitialState,
  type SupervisorState,
  type SupervisorFire,
  type SupervisorFireRecord,
  type SupervisorTurnRecord,
} from './supervisor-types.js';
import { generatePostmortem } from './supervisor-postmortem.js';
import type { ChatMessage } from './context.js';

export interface HistoryRef {
  current: ChatMessage[];
}

export interface WithSupervisorOpts {
  runTurn: (opts: RunTurnOpts) => AsyncIterable<AgentEvent>;
  runTurnOpts: RunTurnOpts;
  historyRef: HistoryRef;
  /**
   * Findings the session has produced so far. Used by Rule B to
   * detect "scan complete, no findings on disk" claims. Empty array
   * is the common case during the first few turns.
   */
  sessionFindings?: readonly { target?: string }[];
  /**
   * The chokepoint's session-scoped target. Sticky across turns —
   * `createInitialState` preserves it on every per-turn reset.
   */
  chokepointSessionTarget?: string;
  // v0.2.A.3 — postmortem generator
  /** If supplied, generate a 1-shot postmortem LLM call on `done`. */
  model?: LanguageModel;
  /**
   * v0.3.A.3 — the model id used for the postmortem. Recorded in
   * `SupervisorTurnRecord.modelUsed` so post-session review can tell
   * whether the postmortem used the primary agent model or a separate
   * supervisor override (the `--supervisor-model` CLI flag).
   */
  modelId?: string;
  /**
   * Ref to the accumulated turn text (assembled by the caller from
   * `text-delta` events). Passed to the postmortem as context. The
   * wrapper does NOT mutate this ref — the caller owns it.
   */
  turnTextRef?: { current: string };
  /** Called with the resulting `SupervisorTurnRecord` after `done`. */
  onPostmortem?: (record: SupervisorTurnRecord) => void;
}

export interface SupervisorWrapper extends AsyncIterable<AgentEvent> {
  lastFires: () => readonly SupervisorFire[];
  /** The `SupervisorTurnRecord` from the last `done` event, or `undefined`. */
  lastPostmortem: () => SupervisorTurnRecord | undefined;
}

/**
 * Map an in-memory `SupervisorFire` to a JSON-serializable
 * `SupervisorFireRecord`. The discriminated union has identical
 * JSON shape to the schema — the cast is a no-op, but it's the
 * boundary marker for "this leaves the process".
 */
function toFireRecord(fire: SupervisorFire): SupervisorFireRecord {
  return fire as SupervisorFireRecord;
}

export function withSupervisor(opts: WithSupervisorOpts): SupervisorWrapper {
  let state: SupervisorState = createInitialState(opts.chokepointSessionTarget);
  let lastFires: SupervisorFire[] = [];
  let lastPostmortem: SupervisorTurnRecord | undefined;

  const iterator = (async function* () {
    for await (const event of opts.runTurn(opts.runTurnOpts)) {
      // Run all rules in order. Each is pure: (state, event) → {state, fire?}.
      // v0.4-A: observeRuleE runs BEFORE observeRuleC because Rule E reads
      // the pre-call `toolsCalledThisTurn` counter (it must be `=== 0`).
      // observeRuleC increments the counter on every tool-call-request,
      // so running E after C would cause E's gate to over-fire on every
      // 2nd+ destructive call in a turn. See ADR-0014 §Decision.
      const rA = observeRuleA(state, event);
      state = rA.state;
      const rE = observeRuleE(state, event);
      state = rE.state;
      const rC = observeRuleC(state, event);
      state = rC.state;
      const rB = observeRuleB(state, event, opts.sessionFindings ?? []);
      state = rB.state;

      // Collect any fires that triggered on this event. Order is the order
      // they ran in. Multiple rules can fire on the same event (e.g. A on
      // a 4th nmap call AND C.2 on the 3rd nmap family call) — both advice
      // messages are pushed.
      for (const fire of [rA.fire, rE.fire, rC.fire, rB.fire].filter(Boolean) as SupervisorFire[]) {
        state = applyFire(state, fire);
        // Mirror the v0.1 AgentApp history-mutation pattern, but
        // immutable (no in-place push — would alias the array the
        // caller might be holding).
        opts.historyRef.current = [
          ...opts.historyRef.current,
          { role: 'user', content: `Supervisor: ${fire.advice}` },
        ];
        yield { type: 'supervisor-fire', fire, targetEventId: fire.targetEventId };
      }

      // Always yield the original event unchanged.
      yield event;

      // Turn boundary: snapshot fires, optionally generate a
      // postmortem, then reset for the next turn.
      // createInitialState preserves chokepointSessionTarget.
      if (event.type === 'done') {
        lastFires = state.firesThisTurn;
        const fires = state.firesThisTurn.map(toFireRecord);
        const turnText = opts.turnTextRef?.current ?? '';

        if (opts.model) {
          const result = await generatePostmortem({
            fires,
            model: opts.model,
            turnText,
            timeoutMs: 10_000,
          });
          const record: SupervisorTurnRecord = {
            fires,
            ...(result.body ? { postmortem: result.body } : {}),
            ...(result.error ? { postmortemError: result.error } : {}),
            // v0.3.A.3 — record the actual model id used for the
            // postmortem so session-log review can tell whether the
            // primary agent model or the override (--supervisor-model)
            // generated it. Falls back to the legacy 'agent-model'
            // literal for callers that don't pass modelId.
            modelUsed: opts.modelId ?? 'agent-model',
          };
          lastPostmortem = record;
          opts.onPostmortem?.(record);
          yield {
            type: 'supervisor-postmortem',
            body: result.body,
            turnId: 'turn',
            fireCount: fires.length,
          };
        } else {
          // No model supplied — caller opted out of the postmortem.
          // We still record fires for the session log, but skip the
          // LLM call entirely.
          const record: SupervisorTurnRecord = { fires };
          lastPostmortem = record;
          opts.onPostmortem?.(record);
        }

        state = createInitialState(opts.chokepointSessionTarget);
      } else if (event.type === 'error') {
        // Error turn: snapshot fires for diagnostics, but skip the
        // postmortem (the turn didn't produce useful work).
        lastFires = state.firesThisTurn;
        state = createInitialState(opts.chokepointSessionTarget);
      }
    }
  })();

  return Object.assign(iterator, {
    lastFires: () => lastFires,
    lastPostmortem: () => lastPostmortem,
  }) as SupervisorWrapper;
}
