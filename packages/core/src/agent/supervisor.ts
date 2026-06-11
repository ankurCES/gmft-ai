/**
 * v0.2.A.2 — the `withSupervisor` wrapper.
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
 * On `done` or `error`, all per-turn state is reset for the next
 * turn. The `chokepointSessionTarget` is sticky across turns (it's
 * the session target, not a per-turn thing) — `createInitialState`
 * preserves it on every reset.
 *
 * The wrapper also exposes `lastFires()` — an accessor for the
 * fires from the LAST completed turn. Used by the session log
 * (Phase A.3) to record a `SupervisorTurnRecord` per turn.
 *
 * Design notes:
 *
 *   - We use `Object.assign(iterator, { lastFires })` so the returned
 *     value is both `AsyncIterable<AgentEvent>` (via the iterator
 *     protocol) and has a callable `lastFires` method. The cast
 *     works because `AsyncIterableIterator<T>` is duck-typed in
 *     TS — no structural mismatch to complain about.
 *
 *   - History mutation is immutable (`[...arr, msg]`, never `push`).
 *     This avoids aliasing bugs if a caller re-uses the same array
 *     reference somewhere else (e.g. the React state setter).
 */

import type { AgentEvent, RunTurnOpts } from './loop.js';
import {
  observeRuleA,
  observeRuleB,
  observeRuleC,
  applyFire,
} from './supervisor-rules.js';
import {
  createInitialState,
  type SupervisorState,
  type SupervisorFire,
} from './supervisor-types.js';
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
}

export interface SupervisorWrapper extends AsyncIterable<AgentEvent> {
  lastFires: () => readonly SupervisorFire[];
}

export function withSupervisor(opts: WithSupervisorOpts): SupervisorWrapper {
  let state: SupervisorState = createInitialState(opts.chokepointSessionTarget);
  let lastFires: SupervisorFire[] = [];

  const iterator = (async function* () {
    for await (const event of opts.runTurn(opts.runTurnOpts)) {
      // Run all 3 rules in order. Each is pure: (state, event) → {state, fire?}.
      const rA = observeRuleA(state, event);
      state = rA.state;
      const rB = observeRuleB(state, event, opts.sessionFindings ?? []);
      state = rB.state;
      const rC = observeRuleC(state, event);
      state = rC.state;

      // Collect any fires that triggered on this event. Order is A, B, C
      // (the order they ran in). Multiple rules can fire on the same
      // event (e.g. A on a 4th nmap call AND C.2 on the 3rd nmap
      // family call) — both advice messages are pushed.
      for (const fire of [rA.fire, rB.fire, rC.fire].filter(Boolean) as SupervisorFire[]) {
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

      // Turn boundary: snapshot fires, then reset for the next turn.
      // createInitialState preserves chokepointSessionTarget (the
      // equivalent `resetForNewTurn(state)` would also preserve it
      // if the state already had it set; the factory form is more
      // explicit).
      if (event.type === 'done' || event.type === 'error') {
        lastFires = state.firesThisTurn;
        state = createInitialState(opts.chokepointSessionTarget);
      }
    }
  })();

  return Object.assign(iterator, {
    lastFires: () => lastFires,
  }) as SupervisorWrapper;
}
