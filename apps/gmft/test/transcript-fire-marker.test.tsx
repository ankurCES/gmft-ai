/**
 * v0.2.A.3 — `SupervisorFireMarker` unit tests.
 *
 * The marker is the per-fire renderable line that the TUI shows below
 * a transcript line whose id matches a `supervisor-fire.targetEventId`.
 *
 * 3 tests:
 *  1. Marker renders ⚠ + the rule tag + the advice body.
 *  2. Marker omits the targetEventId by default (not a debug build).
 *  3. Marker handles each rule (A / B / C) with the same shape.
 *
 * Note on plan: the original plan called for a `Transcript.tsx` with
 * an `events` + `firedTargets: Set<string>` prop. That component
 * doesn't exist in the v0.1 app (events stream into AgentApp and
 * supervisor-fire events are currently unrendered). The marker is
 * the smallest renderable unit that satisfies the contract — the
 * AgentApp-level wiring (deciding which messages get a marker) is
 * the v0.3.A.2 work, tested in `chat-tab-fire-marker.test.tsx` and
 * `agent-app-fire-wiring.test.tsx`.
 */

import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { SupervisorFireMarker } from '../src/ui/components/SupervisorFireMarker.js';
import type { SupervisorFire } from '@gmft/core';

describe('SupervisorFireMarker', () => {
  it('renders ⚠ + the rule tag + the advice body (rule A / loop)', () => {
    const fire: SupervisorFire = {
      kind: 'loop-detected',
      tool: 'whois',
      count: 3,
      recent: ['whois', 'whois', 'whois'],
      advice: 'Tool has been called 3 times with the same args — consider switching approach.',
      targetEventId: 'tc-1',
    };
    const { lastFrame } = render(<SupervisorFireMarker fire={fire} />);
    const frame = lastFrame() ?? '';
    expect(frame).toMatch(/⚠/);
    expect(frame).toMatch(/rule a/i);
    expect(frame).toMatch(/whois/);
    // The advice body may be line-wrapped by the terminal — match
    // a single word from the body rather than a phrase that could
    // wrap across a boundary.
    expect(frame).toMatch(/switching/);
  });

  it('omits targetEventId by default; shows it when showTargetId=true (rule B / overclaim)', () => {
    const fire: SupervisorFire = {
      kind: 'overclaim',
      quote: 'definitely safe',
      evidence: 'last 2 tool results',
      advice: 'Confidence claim "definitely safe" is unsupported by your last 2 tool results.',
      targetEventId: 'tc-42',
    };
    const hidden = render(<SupervisorFireMarker fire={fire} />).lastFrame() ?? '';
    const shown = render(
      <SupervisorFireMarker fire={fire} showTargetId />,
    ).lastFrame() ?? '';
    expect(hidden).not.toMatch(/tc-42/);
    expect(shown).toMatch(/tc-42/);
    expect(hidden).toMatch(/rule b/i);
  });

  it('handles rule C / plan-issue with the same shape (no rule-specific branches)', () => {
    const fire: SupervisorFire = {
      kind: 'plan-issue',
      severity: 'info',
      text: 'whois+nmap target=h',
      advice: 'Whois + nmap target is host=h — consider an explicit target declaration.',
      targetEventId: 'tc-7',
    };
    const { lastFrame } = render(<SupervisorFireMarker fire={fire} />);
    const frame = lastFrame() ?? '';
    expect(frame).toMatch(/⚠/);
    expect(frame).toMatch(/rule c/i);
    expect(frame).toMatch(/info/);
    expect(frame).toMatch(/declaration/);
  });
});
