/**
 * Public surface of the chokepoint module. `createChokepoint(env)`
 * returns the gate; `readChokepointEnv({ cfg, env? })` builds the
 * env from config + process env (or a test-supplied env object).
 *
 * The aggregator's rule order is documented on `./rules.ts` and
 * covered by `chokepoint.test.ts`. Changing it requires an ADR.
 */

import type { Chokepoint, ChokepointCall, Decision, ChokepointEnv } from './decision.js';
import {
  checkDestructive,
  checkElevation,
  checkTarget,
  checkTypeToConfirm,
} from './rules.js';

export function createChokepoint(env: ChokepointEnv): Chokepoint {
  return {
    decide(call: ChokepointCall): Decision {
      return (
        checkElevation(call, env) ??
        checkTypeToConfirm(call) ??
        checkDestructive(call) ??
        checkTarget(call, env) ??
        { kind: 'allow' }
      );
    },
  };
}

export type { Decision, Chokepoint, ChokepointCall, ChokepointEnv } from './decision.js';
export { readChokepointEnv } from './policy.js';
