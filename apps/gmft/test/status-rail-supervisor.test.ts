/**
 * v0.2.A.3 — StatusRail supervisor field tests.
 *
 * The Supervisor field in the StatusRail shows 3 states:
 *
 *   - `quiet`      → no fires this turn, no postmortem. Rendered dim.
 *   - `fires`      → 1+ supervisor fires this turn. Renders `⚠ N fire(s)` in yellow.
 *   - `postmortem` → postmortem written for this turn. Renders `ⓘ postmortem` in cyan.
 *
 * We test the pure-render helper `renderSupervisorField` (which is
 * what the JSX wrapper calls into) for all 3 states. The full JSX
 * component is exercised through the smoke + app-e2e tests via the
 * App path.
 */

import { describe, it, expect } from 'vitest';
import { renderSupervisorField } from '../src/ui/components/StatusRail.js';

describe('renderSupervisorField', () => {
  it('returns "quiet" when supervisor is quiet (no fires, no postmortem)', () => {
    const out = renderSupervisorField({ supervisor: 'quiet', fireCount: 0 });
    expect(out).toBe('quiet');
  });

  it('returns "⚠ N fires" (plural) when fireCount > 1 and supervisor is fires', () => {
    const out = renderSupervisorField({ supervisor: 'fires', fireCount: 3 });
    expect(out).toBe('⚠ 3 fires');
  });

  it('returns "ⓘ postmortem" when the postmortem is written for the turn', () => {
    const out = renderSupervisorField({ supervisor: 'postmortem', fireCount: 0 });
    expect(out).toBe('ⓘ postmortem');
  });
});
