import { Box, Text, useFocus, useInput } from 'ink';
import { useEffect, useMemo, useState } from 'react';
import type { AgentEvent } from '@gmft/core';
import type { Theme } from '../theme.js';

export interface AuditLogTabProps {
  /**
   * The session's full event log, in emission order. AgentApp owns
   * the writer; AuditLogTab is read-only. When the array is empty
   * we render the empty-state ("0 events recorded — run a tool
   * from the chat to see results here").
   */
  events: readonly AgentEvent[];
  theme: Theme;
  /**
   * Override the page size. Default 50, per plan A.4.1. Tests pass
   * a smaller size to exercise multi-page navigation without
   * manufacturing 100+ events.
   */
  pageSize?: number;
}

const DEFAULT_PAGE_SIZE = 50;

/**
 * AuditLogTab — v0.3.A.4.
 *
 * Read-only viewer over the session's `AgentEvent` log. Paginated
 * (default 50 events per page), filterable by `kind`, and color-
 * coded so the operator can scan for the salient event types at a
 * glance:
 *
 *   - tool-call-request         cyan
 *   - tool-result (ok)          green
 *   - tool-result (!ok)         red
 *   - confirmation-needed       yellow
 *   - supervisor-fire           magenta
 *   - supervisor-postmortem     magenta
 *   - chain-started / -step-* / -finished  blue
 *   - text-delta                default
 *   - done                      gray
 *   - error                     red
 *
 * Keybindings (active while the tab is focused — useFocus auto-
 * focuses the first focusable in the tree):
 *
 *   - n           next page
 *   - p           previous page
 *   - f           cycle the kind filter
 *
 * The tab is intentionally append-only and read-only: it never
 * edits the underlying event list. Sessions are short-lived so
 * the in-memory list stays small (a runaway loop generates a
 * bounded stream per turn).
 */
export function AuditLogTab({
  events,
  theme,
  pageSize = DEFAULT_PAGE_SIZE,
}: AuditLogTabProps): React.JSX.Element {
  // The kind-filter cycle. We start at 'all' (no filter) and cycle
  // through the canonical AgentEvent.type variants on `f`. The list
  // is the union minus the rare-but-cheap-to-render `chain-*` group
  // (the operator can spot chain activity by its color-coded lines
  // without a dedicated filter button).
  const KIND_CYCLE: Array<'all' | AgentEvent['type']> = useMemo(
    () => [
      'all',
      'tool-call-request',
      'tool-result',
      'confirmation-needed',
      'supervisor-fire',
      'supervisor-postmortem',
      'chain-started',
      'chain-finished',
      'error',
      'done',
    ],
    [],
  );

  const [page, setPage] = useState(0);
  const [kindFilter, setKindFilter] = useState<'all' | AgentEvent['type']>('all');

  // Clamp the page when the filtered list shrinks (e.g. a new
  // session reset or a filter change that drops the last page).
  const filtered = useMemo(() => {
    if (kindFilter === 'all') return events;
    return events.filter((e) => e.type === kindFilter);
  }, [events, kindFilter]);
  const totalPages = Math.max(Math.ceil(filtered.length / pageSize), 1);
  const safePage = Math.min(page, totalPages - 1);
  useEffect(() => {
    if (page !== safePage) setPage(safePage);
  }, [page, safePage]);

  useFocus({ autoFocus: true });
  useInput((input) => {
    if (input === 'n') {
      setPage((p) => (p + 1) % totalPages);
      return;
    }
    if (input === 'p') {
      setPage((p) => (p - 1 + totalPages) % totalPages);
      return;
    }
    if (input === 'f') {
      setKindFilter((prev) => {
        const i = KIND_CYCLE.indexOf(prev);
        const next = KIND_CYCLE[(i + 1) % KIND_CYCLE.length];
        // Defensive: KIND_CYCLE is constant so this is just
        // tightening the type for the setter.
        return next ?? 'all';
      });
      setPage(0);
      return;
    }
  });

  // Empty state: no events yet (session hasn't run a turn, or the
  // runner emitted no events). Match FindingsTab's tone so the
  // operator doesn't think the tab is broken.
  if (events.length === 0) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
        <Box marginBottom={1}>
          <Text>{theme.accent('Audit Log')}</Text>
        </Box>
        <Text>{theme.muted('No events yet. Run a tool from the chat to see results here.')}</Text>
        <Box marginTop={1}>
          <Text color="gray">n=next · p=prev · f=filter</Text>
        </Box>
      </Box>
    );
  }

  const start = safePage * pageSize;
  const end = Math.min(start + pageSize, filtered.length);
  const slice = filtered.slice(start, end);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
      <Box marginBottom={1}>
        <Text>
          {theme.accent('Audit Log')}{' '}
          <Text color="gray">
            (
            {kindFilter === 'all'
              ? `${filtered.length} events`
              : `${filtered.length} matching ${kindFilter}`}
            {' · '}
            page {safePage + 1}/{totalPages} · showing {start + 1}-{end})
          </Text>
        </Text>
      </Box>
      <Box flexDirection="column">
        {slice.map((ev, i) => (
          <AuditEventRow key={`${start + i}-${describe(ev)}`} event={ev} />
        ))}
      </Box>
      <Box marginTop={1}>
        <Text color="gray">n=next · p=prev · f=filter (current: {kindFilter})</Text>
      </Box>
    </Box>
  );
}

/**
 * One row of the audit log. The `color` is keyed off the event's
 * `type` (and, for `tool-result`, also off `ok`). The label is
 * short enough to keep rows to a single line at 80 columns even
 * with the kind + tool-name pairs.
 */
function AuditEventRow({ event }: { event: AgentEvent }): React.JSX.Element {
  return <Text>{renderEvent(event)}</Text>;
}

function renderEvent(event: AgentEvent): React.ReactNode {
  switch (event.type) {
    case 'text-delta':
      return <Text>· {truncate(event.text, 80)}</Text>;
    case 'done':
      return <Text color="gray">✓ done</Text>;
    case 'error':
      return <Text color="red">✗ error: {truncate(event.error.message, 70)}</Text>;
    case 'tool-call-request':
      return (
        <Text color="cyan">
          → tool-call <Text bold>{event.name}</Text>
          {event.flags && event.flags.length > 0 ? (
            <Text color="yellow"> [{event.flags.join(',')}]</Text>
          ) : null}
          {' '}
          {summarizeArgs(event.args)}
        </Text>
      );
    case 'tool-result':
      if (event.ok) {
        return (
          <Text color="green">
            ← tool-result <Text bold>{event.name ?? '(unnamed)'}</Text>{' '}
            {event.output !== undefined ? summarizeOutput(event.output) : '(no output)'}
          </Text>
        );
      }
      return (
        <Text color="red">
          ← tool-result <Text bold>{event.name ?? '(unnamed)'}</Text> ✗
          {event.reason ? ` ${truncate(event.reason, 60)}` : ' denied'}
        </Text>
      );
    case 'confirmation-needed':
      return (
        <Text color="yellow">
          ? confirm <Text bold>{event.name}</Text> — {truncate(event.reason, 60)}
        </Text>
      );
    case 'supervisor-fire':
      return (
        <Text color="magenta">
          ⚠ supervisor-fire <Text bold>{event.fire.kind}</Text> → {event.targetEventId}
        </Text>
      );
    case 'supervisor-postmortem':
      return (
        <Text color="magenta">
          ⚕ postmortem (turn {event.turnId}, {event.fireCount} fires){' '}
          {truncate(event.body.replace(/\s+/g, ' '), 60)}
        </Text>
      );
    case 'chain-started':
      return (
        <Text color="blue">
          ⛓ chain-started <Text bold>{event.chainId}</Text> ({event.stepCount} steps)
        </Text>
      );
    case 'chain-step-started':
      return (
        <Text color="blue">
          ⛓ step-started #{event.stepIndex} {event.tool}
          {event.name ? ` (${event.name})` : ''}
        </Text>
      );
    case 'chain-step-finished':
      return (
        <Text color="blue">
          ⛓ step-finished #{event.stepIndex} {event.status}
          {event.reason ? ` — ${truncate(event.reason, 40)}` : ''}
        </Text>
      );
    case 'chain-finished':
      return (
        <Text color="blue">
          ⛓ chain-finished <Text bold>{event.chainId}</Text> ok={event.completed} denied=
          {event.denied} erred={event.erred}
        </Text>
      );
    default: {
      // Exhaustive — TypeScript narrows `event` to `never` here.
      const _exhaustive: never = event;
      void _exhaustive;
      return <Text color="gray">· (unknown event)</Text>;
    }
  }
}

function describe(event: AgentEvent): string {
  switch (event.type) {
    case 'text-delta':
      return `text-delta:${event.text.slice(0, 16)}`;
    case 'done':
      return 'done';
    case 'error':
      return 'error';
    case 'tool-call-request':
      return `tcr:${event.id}`;
    case 'tool-result':
      return `tr:${event.id}`;
    case 'confirmation-needed':
      return `cn:${event.id}`;
    case 'supervisor-fire':
      return `fire:${event.targetEventId}`;
    case 'supervisor-postmortem':
      return `pm:${event.turnId}`;
    case 'chain-started':
      return `cs:${event.chainId}`;
    case 'chain-step-started':
      return `css:${event.chainId}:${event.stepIndex}`;
    case 'chain-step-finished':
      return `csf:${event.chainId}:${event.stepIndex}`;
    case 'chain-finished':
      return `cf:${event.chainId}`;
    default: {
      const _exhaustive: never = event;
      void _exhaustive;
      return 'unknown';
    }
  }
}

function summarizeArgs(args: Record<string, unknown>): string {
  const keys = Object.keys(args);
  if (keys.length === 0) return '()';
  // Surface the first 2 args as `key=value` pairs; truncate long
  // values. Avoids the row blowing past 80 columns.
  const pairs = keys.slice(0, 2).map((k) => {
    const v = args[k];
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return `${k}=${truncate(s, 24)}`;
  });
  return `(${pairs.join(' ')}${keys.length > 2 ? ` +${keys.length - 2}` : ''})`;
}

function summarizeOutput(output: unknown): string {
  if (Array.isArray(output)) {
    if (output.length === 0) return '[]';
    return `[${output.length} items]`;
  }
  if (output && typeof output === 'object') {
    const keys = Object.keys(output as Record<string, unknown>);
    if (keys.length === 0) return '{}';
    return `{${keys.slice(0, 3).join(',')}${keys.length > 3 ? `+${keys.length - 3}` : ''}}`;
  }
  return truncate(String(output), 40);
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}
