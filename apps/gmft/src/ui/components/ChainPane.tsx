/**
 * ChainPane — right-rail (or bottom-panel) progress view for the
 * active `attack_chain` run.
 *
 * Renders a header with the chain's id + completed/total counters,
 * then one row per step. Each row carries a status badge:
 *
 *   ✓ ok       — finished cleanly
 *   ⊘ denied   — chokepoint denied (or user rejected)
 *   ⚠ erred    — tool runner threw
 *   → skipped  — chain short-circuited on a prior failure
 *   ⏵ running  — in flight (started, no finished yet)
 *
 * The "active step" (the most recent step with no `status`) auto-
 * scrolls into view via a ref + `useEffect` on `steps.length`. This
 * is best-effort: if the terminal doesn't support scrollback (CI,
 * pipe), the call is a no-op and the user just sees the full list.
 *
 * The component is purely presentational — it takes a `chainState`
 * prop and renders. The parent (ChatTab / App) decides *when* to
 * render (only when `chainState !== null`). Keeping the component
 * pure means the unit test can exercise it without dragging in the
 * `useAgent` hook's React state machinery.
 *
 * v0.1 phase 6 — ships with feature A.5 of the phase 6 plan.
 */

import { Box, Text } from 'ink';
import { useEffect, useRef } from 'react';
import type { ChainState, ChainStep } from '../hooks/useAgent.js';
import type { Theme } from '../theme.js';

export interface ChainPaneProps {
  chainState: ChainState;
  theme: Theme;
}

/**
 * Pick the status badge for a step. Steps emitted via
 * `chain-step-started` have no `status` yet (still running); the
 * `chain-step-finished` event later annotates them with one of
 * `ok` / `denied` / `erred` / `skipped`. The `running` badge is
 * our representation of the in-flight state, not a wire-level
 * status.
 */
function statusBadge(step: ChainStep, theme: Theme): { glyph: string; label: string; color: (s: string) => string } {
  switch (step.status) {
    case 'ok':
      return { glyph: '✓', label: 'ok', color: theme.ok };
    case 'denied':
      return { glyph: '⊘', label: 'denied', color: theme.warn };
    case 'erred':
      return { glyph: '⚠', label: 'erred', color: theme.error };
    case 'skipped':
      return { glyph: '→', label: 'skipped', color: theme.muted };
    case undefined:
      return { glyph: '⏵', label: 'running', color: theme.accent };
  }
}

/**
 * Build a human-friendly per-step detail line, e.g. "nmap -sV
 * (ok, 1.2s, 3 findings)" or "nikto scan (running)". The shape
 * is `<tool/name> (<label>[, <duration>][, <N> findings][ —
 * <reason>])`. The trailing paren is always emitted so
 * ink-testing-library assertions on the line are stable.
 */
function formatStepDetail(step: ChainStep, badgeLabel: string): string {
  const toolName = step.name ? `${step.tool} ${step.name}` : step.tool;
  const parts: string[] = [toolName, badgeLabel];
  // Duration + finding count only make sense once the step has a
  // terminal status. For `running` we don't render them — the
  // duration is in flight and the finding count is zero.
  if (
    (badgeLabel === 'ok' || badgeLabel === 'erred' || badgeLabel === 'denied') &&
    typeof step.durationMs === 'number'
  ) {
    const secs = (step.durationMs / 1000).toFixed(1);
    parts.push(`${secs}s`);
  }
  if (
    (badgeLabel === 'ok' || badgeLabel === 'erred' || badgeLabel === 'denied') &&
    typeof step.findingCount === 'number' &&
    step.findingCount > 0
  ) {
    parts.push(`${step.findingCount} finding${step.findingCount === 1 ? '' : 's'}`);
  }
  if (step.reason) {
    parts.push(step.reason);
  }
  return `${parts[0]} (${parts.slice(1).join(', ')})`;
}

export function ChainPane({ chainState, theme }: ChainPaneProps): React.JSX.Element {
  // Auto-scroll the active step into view. We ref each row and, on
  // every `steps.length` change, scroll the *last* row whose
  // `status` is undefined (i.e. currently running). When the chain
  // is done, we don't scroll — the user is reading the final
  // summary at the bottom of the list anyway.
  const rowRefs = useRef<Array<{ scrollIntoView?: () => void } | null>>([]);
  useEffect(() => {
    if (chainState.done) return;
    const idx = chainState.steps.findIndex((s) => s.status === undefined);
    if (idx < 0) return;
    rowRefs.current[idx]?.scrollIntoView?.();
  }, [chainState.steps.length, chainState.done]);

  const total = chainState.stepCount || chainState.steps.length;
  const completed = chainState.totals?.completed ?? 0;
  const headerTail = chainState.done
    ? theme.muted(`  ${completed}/${total} done`)
    : theme.accent(`  ${completed}/${total} …`);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="gray"
      paddingX={1}
      marginY={1}
    >
      <Box>
        <Text>
          {theme.tool('Chain: ')}
          {theme.muted(chainState.chainId.slice(0, 8))}
          {headerTail}
        </Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {chainState.steps.length === 0 ? (
          <Text>{theme.muted('(no steps yet — waiting on chain tool)')}</Text>
        ) : (
          chainState.steps.map((step, i) => {
            const badge = statusBadge(step, theme);
            const detail = formatStepDetail(step, badge.label);
            return (
              <Box
                key={`${chainState.chainId}-${step.index}-${i}`}
                ref={(r) => {
                  rowRefs.current[i] = r as { scrollIntoView?: () => void } | null;
                }}
              >
                <Box marginRight={1}>
                  <Text>{String(badge.color(badge.glyph))}</Text>
                </Box>
                <Text>
                  {theme.muted(`[${step.index}]`)} {detail}
                </Text>
              </Box>
            );
          })
        )}
      </Box>
    </Box>
  );
}
