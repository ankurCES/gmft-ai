import { Box, Text } from 'ink';
import type { Severity } from '@gmft/core';
import type { Theme } from '../theme.js';

export interface StatusInfo {
  model: string;
  provider: string;
  sandbox: 'docker' | 'host' | 'unknown';
  target?: string;
  tokensIn: number;
  tokensOut: number;
  toolCalls: number;
  findings: number;
  /**
   * Per-severity cumulative finding counts for the current session.
   * Drives the sparkline in the StatusRail — a stacked bar that
   * shows at-a-glance how the run is going. Order is severity order
   * (low → critical); the bar is colored by severity. `info` is
   * rendered muted to keep the focus on real findings.
   */
  findingsBySeverity: Record<Severity, number>;
}

export function StatusRail({ status, theme }: { status: StatusInfo; theme: Theme }): React.JSX.Element {
  const sandboxLabel =
    status.sandbox === 'host' ? theme.warn('⚠ host ') : theme.ok(status.sandbox);
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="gray"
      paddingX={1}
      marginBottom={1}
    >
      <Box>
        <Text>
          {theme.muted('model ')}<Text color="cyan">{status.provider}:{status.model}</Text>
          {status.target && (
            <>
              {theme.muted('  target ')}
              <Text color="magenta">{status.target}</Text>
            </>
          )}
          {theme.muted('  sandbox ')}
          {sandboxLabel}
        </Text>
      </Box>
      <Box>
        <Text>
          {theme.muted('tokens ')}
          <Text>
            ↑{status.tokensIn} ↓{status.tokensOut}
          </Text>
          {theme.muted('  tools ')}
          <Text>{status.toolCalls}</Text>
          {theme.muted('  findings ')}
          <Text color={status.findings > 0 ? 'yellow' : undefined}>{status.findings}</Text>
          {theme.muted('  ')}
          <SeveritySparkline counts={status.findingsBySeverity} />
        </Text>
      </Box>
    </Box>
  );
}

/**
 * Stacked-bar sparkline of the current findings, grouped by severity.
 * Each severity with count > 0 contributes a Unicode block character
 * repeated `count` times, color-coded by severity. The order is fixed
 * (info → critical) so the eye can compare runs at a glance.
 *
 * Width is unbounded when the run is fresh; in practice a long run
 * accumulates ~10-100 findings, well under any reasonable terminal
 * width. We don't truncate — a finding isn't safe to drop from the
 * status line. The user can `/clear` to reset.
 *
 * The bar lives alongside (not inside) the find count so the count
 * stays scannable and the bar is the secondary signal.
 */
const SPARK_BARS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const;
const SEVERITY_ORDER: readonly Severity[] = ['info', 'low', 'medium', 'high', 'critical'] as const;

/** Pure render of a severity sparkline. Public for unit testing. */
export function renderSeveritySparkline(counts: Record<Severity, number>): string {
  const parts: string[] = [];
  for (const sev of SEVERITY_ORDER) {
    const n = counts[sev] ?? 0;
    if (n === 0) continue;
    // Cap the per-severity bar at 8 to avoid runaway widths if a tool
    // emits 50+ critical findings in one shot. 8 cells is plenty for
    // at-a-glance comparison; the raw count is in the `findings` field.
    const repeats = Math.min(n, SPARK_BARS.length);
    const bar = SPARK_BARS[SPARK_BARS.length - 1]!.repeat(repeats);
    parts.push(`${sev}:${bar}`);
  }
  if (parts.length === 0) return '(none)';
  return parts.join(' ');
}

function SeveritySparkline({ counts }: { counts: Record<Severity, number> }): React.JSX.Element {
  return <Text>{renderSeveritySparkline(counts)}</Text>;
}
