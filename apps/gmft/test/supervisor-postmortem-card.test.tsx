/**
 * v0.2.A.3 — SupervisorPostmortemCard component tests.
 *
 * 3 tests:
 *  1. Renders the postmortem body lines + the "N fires" plural label.
 *  2. Singular "fire" agreement for fireCount=1.
 *  3. Empty body still renders the card with a placeholder (no crash).
 */

import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { SupervisorPostmortemCard } from '../src/ui/components/SupervisorPostmortemCard.js';

describe('SupervisorPostmortemCard', () => {
  it('renders the postmortem body by default', () => {
    const { lastFrame } = render(
      <SupervisorPostmortemCard
        body={'WHAT WE TRIED: scan\nLEARNED: x\nMISSING: y\nNEXT STEP: z'}
        fireCount={2}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toMatch(/Postmortem/);
    expect(frame).toMatch(/WHAT WE TRIED/);
    expect(frame).toMatch(/2 fires/);
  });

  it('uses singular "fire" for fireCount=1', () => {
    const { lastFrame } = render(
      <SupervisorPostmortemCard
        body={'WHAT: x\nLEARNED: y\nMISSING: z\nNEXT: w'}
        fireCount={1}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toMatch(/1 fire\b/);
    expect(frame).not.toMatch(/1 fires/);
  });

  it('renders a placeholder for an empty body (postmortem error case)', () => {
    const { lastFrame } = render(
      <SupervisorPostmortemCard body="" fireCount={0} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toMatch(/Postmortem/);
    expect(frame).toMatch(/0 fires/);
    // The card must still render — no crash, no undefined in the frame.
    expect(frame).toMatch(/no postmortem|generator error/);
  });
});
