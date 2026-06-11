/**
 * v0.2.A.2 — the `withSupervisor` wrapper.
 *
 * Observes an inner `runTurn` `AsyncIterable<AgentEvent>`, runs the 3
 * rules from `supervisor-rules.ts` on every event, and on a fire:
 *
 *   1. Yields a `supervisor-fire` event AFTER the original event (so
 *      the TUI can render the trigger and the warning in the right
 *      order).
 *   2. Pushes a `role: 'user'` advice message into the caller's
 *      `historyRef.current` array, so the next LLM call within the
 *      same multi-step turn sees the supervisor's correction.
 *
 * On `done` or `error`, all per-turn state is reset for the next
 * turn. The `chokepointSessionTarget` is sticky across turns (it's
 * the session target, not a per-turn thing) — the factory call
 * preserves it.
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
  resetForNewTurn,
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
   * the factory preserves it through `resetForNewTurn`.
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
      // event (e.g. A on a 4th nmap call AND B on a "scan complete"
      // text-delta in the same turn) — both advice messages are pushed.
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

      // Turn boundary: snapshot fires, then reset.
      if (event.type === 'done' || event.type === 'error') {
        lastFires = state.firesThisTurn;
        state = createInitialState(opts.chokepointSessionTarget);
        // resetForNewTurn preserves chokepointSessionTarget if it was
        // set on the state. The factory above also sets it. So this
        // is equivalent to: state = resetForNewTurn(state). We use
        // the factory for explicitness.
      }
    }
  })();

  return Object.assign(iterator, {
    lastFires: () => lastFires,
  }) as SupervisorWrapper;
}
