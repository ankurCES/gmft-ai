import { Box, Text, useFocus, useInput } from 'ink';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Finding, Severity } from '@gmft/core';
import { readSelections, writeSelections } from '@gmft/tools';
import type { StatusInfo } from '../components/StatusRail.js';
import type { Theme } from '../theme.js';

export interface FindingsTabProps {
  status: StatusInfo;
  theme: Theme;
  /**
   * The findings to render. When undefined, the tab falls back to
   * the phase-1 placeholder ("no findings yet") for tests/older
   * callers that haven't plumbed the findings through. When the
   * array is empty (vs. undefined), we render the empty-state with
   * the new shape so the operator sees the new tab is alive.
   */
  findings?: readonly Finding[];
  /**
   * Directory holding `${sessionId}.jsonl` + `.selections.json`.
   * Required when `findings` is provided; the tab reads the sidecar
   * on mount and writes it (debounced 500ms) on each toggle.
   */
  baseDir?: string;
  sessionId?: string;
  /**
   * Called when the user hits `r` ("write report"). The TUI's slash
   * dispatcher is the natural owner of `report_write`; the tab just
   * signals intent. Tests pass a spy.
   */
  onGenerateReport?: () => void;
}

const SEVERITY_GLYPH: Record<Severity, string> = {
  info: '·',
  low: '·',
  medium: '!',
  high: '‼',
  critical: '☠',
};

const SEVERITY_COLOR: Record<Severity, string> = {
  info: 'blue',
  low: 'green',
  medium: 'yellow',
  high: 'red',
  critical: 'magenta',
};

/**
 * FindingsTab — phase 6 rewrite.
 *
 * Renders the session's findings as a scrollable list. Per-row
 * checkboxes drive the selection sidecar
 * (`${baseDir}/${sessionId}.selections.json`); the `r` key
 * dispatches the report-write slash command via `onGenerateReport`.
 *
 * Keybindings (only active while the tab is focused — useFocus
 * auto-focuses the first focusable in the tree):
 *   - j / ↓    : move cursor down
 *   - k / ↑    : move cursor up
 *   - space    : toggle the row's checkbox
 *   - a        : toggle all
 *   - r        : invoke onGenerateReport
 *
 * The tab stays useful when `findings` is empty (shows "0 findings
 * recorded" + the same keybinding help line) and degrades to the
 * phase-1 placeholder when `findings` is undefined (so older tests
 * that don't pass the prop keep working).
 */
export function FindingsTab({
  status,
  theme,
  findings,
  baseDir,
  sessionId,
  onGenerateReport,
}: FindingsTabProps): React.JSX.Element {
  // The phase-1 placeholder path — no findings plumbed through.
  if (findings === undefined) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
        <Box marginBottom={1}>
          <Text>{theme.accent('Findings')}</Text>
        </Box>
        {status.findings > 0 ? (
          <Text>
            {status.findings} finding{status.findings === 1 ? '' : 's'} recorded in this session.
          </Text>
        ) : (
          <Text>{theme.muted('No findings yet. Run a tool from the chat to see results here.')}</Text>
        )}
        <Box marginTop={1}>
          <Text color="gray">(land in phase 2)</Text>
        </Box>
      </Box>
    );
  }

  // Active path: render the real list. Hooks must be called
  // unconditionally, so we lift them above the early return — but
  // `findings === undefined` is the only case we early-return on, and
  // we've handled it. From here on, `findings` is a readonly array.
  return (
    <FindingsList
      findings={findings}
      baseDir={baseDir}
      sessionId={sessionId}
      onGenerateReport={onGenerateReport}
      theme={theme}
    />
  );
}

function FindingsList({
  findings,
  baseDir,
  sessionId,
  onGenerateReport,
  theme,
}: {
  findings: readonly Finding[];
  baseDir?: string;
  sessionId?: string;
  onGenerateReport?: () => void;
  theme: Theme;
}): React.JSX.Element {
  useFocus({ autoFocus: true });
  const [cursor, setCursor] = useState(0);
  // `checked: Set<string>` — finding ids the operator has ticked.
  // Hydrated from the sidecar on mount; mutated on every toggle.
  const [checked, setChecked] = useState<Set<string>>(() => {
    if (!baseDir || !sessionId) return new Set();
    const sel = readSelections(baseDir, sessionId);
    return new Set(sel?.checkedIds ?? []);
  });
  const checkedRef = useRef(checked);
  checkedRef.current = checked;

  // Debounced sidecar autosave. We schedule a write 500ms after the
  // last toggle; if a new toggle comes in before the timer fires, we
  // cancel the previous timer. The debounce is the same pattern the
  // `useFindings` autosave uses (per plan §B.4).
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!baseDir || !sessionId) return;
    if (debounceRef.current !== null) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      writeSelections(baseDir, sessionId, { checkedIds: Array.from(checkedRef.current) });
      debounceRef.current = null;
    }, 500);
    return () => {
      if (debounceRef.current !== null) clearTimeout(debounceRef.current);
    };
  }, [checked, baseDir, sessionId]);

  // Clamp the cursor when the list shrinks (e.g. session reset).
  const safeCursor = Math.min(cursor, Math.max(findings.length - 1, 0));
  useEffect(() => {
    if (cursor !== safeCursor) setCursor(safeCursor);
  }, [cursor, safeCursor]);

  useInput((input, key) => {
    if (findings.length === 0) {
      // `r` is the only meaningful action on an empty list.
      if (input === 'r') onGenerateReport?.();
      return;
    }
    if (key.downArrow || input === 'j') {
      setCursor((c) => (c + 1) % findings.length);
      return;
    }
    if (key.upArrow || input === 'k') {
      setCursor((c) => (c - 1 + findings.length) % findings.length);
      return;
    }
    if (input === ' ') {
      const f = findings[safeCursor];
      if (!f) return;
      setChecked((prev) => {
        const next = new Set(prev);
        if (next.has(f.id)) next.delete(f.id);
        else next.add(f.id);
        return next;
      });
      return;
    }
    if (input === 'a') {
      setChecked((prev) => {
        if (prev.size === findings.length) return new Set();
        return new Set(findings.map((f) => f.id));
      });
      return;
    }
    if (input === 'r') {
      onGenerateReport?.();
      return;
    }
  });

  const selectedCount = useMemo(() => {
    let n = 0;
    for (const f of findings) if (checked.has(f.id)) n++;
    return n;
  }, [findings, checked]);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
      <Box marginBottom={1}>
        <Text>
          {theme.accent('Findings')}{' '}
          <Text color="gray">
            ({findings.length} recorded · {selectedCount} selected · press `r` to write report)
          </Text>
        </Text>
      </Box>
      {findings.length === 0 ? (
        <Text>{theme.muted('No findings yet. Run a tool from the chat to see results here.')}</Text>
      ) : (
        <Box flexDirection="column">
          {findings.map((f, i) => {
            const isCursor = i === safeCursor;
            const isChecked = checked.has(f.id);
            const box = isChecked ? theme.ok('[x]') : theme.muted('[ ]');
            const sev = f.severity;
            return (
              <Box key={f.id} flexDirection="row">
                <Box marginRight={1}>
                  <Text>
                    {isCursor ? theme.accent('▶') : ' '}
                  </Text>
                </Box>
                <Box marginRight={1}>
                  <Text>{box}</Text>
                </Box>
                <Box marginRight={1} minWidth={9}>
                  <Text color={SEVERITY_COLOR[sev]}>{SEVERITY_GLYPH[sev]} {sev.padEnd(8)}</Text>
                </Box>
                <Box marginRight={1} minWidth={12}>
                  <Text color="cyan">{f.tool}</Text>
                </Box>
                <Box marginRight={1} minWidth={14}>
                  <Text color="magenta">{f.target}</Text>
                </Box>
                <Box flexGrow={1}>
                  <Text>{truncate(f.title, 60)}</Text>
                </Box>
              </Box>
            );
          })}
        </Box>
      )}
      <Box marginTop={1}>
        <Text color="gray">
          j/k navigate · space toggles · a toggles all · r writes report
        </Text>
      </Box>
    </Box>
  );
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}
