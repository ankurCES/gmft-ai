/**
 * v0.2.A.3 — inline ⚠ marker for supervisor fires on a transcript line.
 *
 * The supervisor yields a `supervisor-fire` event with a `targetEventId`
 * pointing at the tool-call-request or text-delta that triggered the
 * fire. The TUI needs to render a visible marker on the matching
 * transcript line so the user can see "this line had a rule fire".
 *
 * This component renders a single marker line given a fire record
 * (the human-readable summary already includes the rule name + the
 * alt-suggestion — see `supervisor-rules.ts` for the exact phrasing).
 *
 * It is intentionally a single line, dim, and self-contained — the
 * transcript renders one `SupervisorFireMarker` per fire below the
 * triggering line. There's no click handler, no expand/collapse; the
 * marker is a label, not a card.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { SupervisorFire } from '@gmft/core';

export interface SupervisorFireMarkerProps {
  fire: SupervisorFire;
  /** Optional: include the targetEventId in the marker (debug builds). */
  showTargetId?: boolean;
}

export function SupervisorFireMarker({
  fire,
  showTargetId = false,
}: SupervisorFireMarkerProps): React.JSX.Element {
  // `kind` is the discriminant on SupervisorFire (loop-detected /
  // overclaim / plan-issue). We map it to a short human label so the
  // marker stays scannable. The advice body is already shaped by
  // the rule engine for human consumption.
  const kindLabel =
    fire.kind === 'loop-detected'
      ? `rule a — loop (${fire.tool} × ${fire.count})`
      : fire.kind === 'overclaim'
        ? `rule b — overclaim`
        : fire.kind === 'plan-issue'
          ? `rule c — plan (${fire.severity})`
          : `rule e — risk-escalation (${fire.kind})`;
  return (
    <Box marginLeft={2}>
      <Text color="yellow">⚠</Text>
      <Text>{' '}</Text>
      <Text dimColor>{kindLabel}</Text>
      <Text>{' — '}</Text>
      <Text>{fire.advice}</Text>
      {showTargetId && (
        <>
          <Text>{' '}</Text>
          <Text dimColor>(target: {fire.targetEventId})</Text>
        </>
      )}
    </Box>
  );
}
