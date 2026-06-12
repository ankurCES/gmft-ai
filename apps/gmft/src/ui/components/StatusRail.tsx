import { Box, Text } from 'ink';
import type { Severity } from '@gmft/core';
import type { Theme } from '../theme.js';

/**
 * v0.2.D — the union of sandbox modes the rail can display.
 *   - `'docker'`           — containerized runner (default for the docker resolver).
 *   - `'host+landlock'`    — host runner with kernel landlock fs-allowlist.
 *   - `'host+seccomp'`     — host runner with kernel seccomp syscall-allowlist.
 *   - `'host+landlock+seccomp'` — both kernel layers applied.
 *   - `'host'`             — bare host runner; no kernel enforcement.
 *   - `'unsandboxed'`      — the chokepoint denied the call; recorded for audit.
 *   - `'unknown'`          — boot state, before the first tool runs.
 *
 * `'host'` is the only one that triggers the persistent ⚠ — the kernel-enforced
 * modes (`host+landlock`, `host+seccomp`, `host+landlock+seccomp`) are *safer*
 * than a `docker` runner with a permissive profile, so they don't need a
 * warning glyph.
 *
 * `'unsandboxed'` is what the audit log records when the chokepoint denied a
 * destructive/elevated call because no sandbox was available; the rail shows
 * it as a red "unsandboxed" with a ✗ so the user can correlate a denied call
 * with the rail state.
 */
export type SandboxMode =
  | 'docker'
  | 'host+landlock'
  | 'host+seccomp'
  | 'host+landlock+seccomp'
  | 'host'
  | 'unsandboxed'
  | 'unknown';

/**
 * v0.2.A.3 — the supervisor's high-level state for the current turn.
 * Drives the Supervisor field in the StatusRail. Pure UI state — the
 * rule engine in `@gmft/core/agent/supervisor-rules` produces the
 * fires that drive this, and the wrapper exposes them via
 * `lastFires()`. The TUI maps `lastFires().length > 0` to `fires`
 * and a non-empty `lastPostmortem().body` to `postmortem`.
 */
export type SupervisorState = 'quiet' | 'fires' | 'postmortem';

export interface StatusInfo {
  model: string;
  provider: string;
  sandbox: SandboxMode;
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
  /**
   * v0.2.A.3 — supervisor state for the current turn. Default
   * `'quiet'` when no rule fired and no postmortem was written.
   */
  supervisor: SupervisorState;
  /**
   * v0.2.A.3 — number of supervisor fires in the current turn.
   * Only meaningful when `supervisor === 'fires'`. The StatusRail
   * renders `⚠ N fire(s)` in yellow.
   */
  fireCount: number;
}

export function StatusRail({ status, theme }: { status: StatusInfo; theme: Theme }): React.JSX.Element {
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
          <SandboxField status={status} theme={theme} />
          {theme.muted('  supervisor ')}
          <SupervisorField status={status} theme={theme} />
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
 * Pure render of the Supervisor field. Public for unit testing.
 *
 *   - `'quiet'`     → `quiet` (dim)
 *   - `'fires'`     → `⚠ N fire(s)` (yellow)
 *   - `'postmortem'`→ `ⓘ postmortem` (cyan)
 */
export function renderSupervisorField(status: Pick<StatusInfo, 'supervisor' | 'fireCount'>): string {
  if (status.supervisor === 'fires') {
    const n = status.fireCount;
    return `⚠ ${n} fire${n === 1 ? '' : 's'}`;
  }
  if (status.supervisor === 'postmortem') return 'ⓘ postmortem';
  return 'quiet';
}

function SupervisorField({ status, theme }: { status: StatusInfo; theme: Theme }): React.JSX.Element {
  if (status.supervisor === 'fires') {
    return <Text color="yellow">{renderSupervisorField(status)}</Text>;
  }
  if (status.supervisor === 'postmortem') {
    return <Text color="cyan">{renderSupervisorField(status)}</Text>;
  }
  // 'quiet' — dim via theme
  return <Text dimColor>{renderSupervisorField(status)}</Text>;
}

/**
 * Pure render of the Sandbox field. Public for unit testing.
 *
 *   - `'docker'`                  → `docker` (green)
 *   - `'host+landlock'`           → `host+landlock` (green) — kernel-enforced
 *   - `'host+seccomp'`            → `host+seccomp` (green) — kernel-enforced
 *   - `'host+landlock+seccomp'`   → `host+landlock+seccomp` (green) — both
 *   - `'host'`                    → `⚠ host` (yellow) — persistent warning
 *   - `'unsandboxed'`             → `✗ unsandboxed` (red) — chokepoint denied
 *   - `'unknown'`                 → `unknown` (dim) — boot state
 *
 * The persistent ⚠ on `'host'` is the v0.1 fallback banner. The
 * kernel-enforced host modes (`host+landlock` and friends) do NOT show a
 * warning — the kernel is enforcing, so the blast radius is bounded even
 * though we're on the host.
 */
export function renderSandboxField(mode: SandboxMode): string {
  switch (mode) {
    case 'docker':
      return 'docker';
    case 'host+landlock':
      return 'host+landlock';
    case 'host+seccomp':
      return 'host+seccomp';
    case 'host+landlock+seccomp':
      return 'host+landlock+seccomp';
    case 'host':
      return '⚠ host';
    case 'unsandboxed':
      return '✗ unsandboxed';
    case 'unknown':
      return 'unknown';
  }
}

/**
 * v0.2.D — the JSX wrapper for the Sandbox field. Color-codes each mode
 * so the eye can spot a host fallback in one glance:
 *   - green: docker + any kernel-enforced host mode (safe)
 *   - yellow: bare host (⚠ — the persistent fallback warning)
 *   - red: unsandboxed (✗ — the chokepoint denied; something IS off)
 *   - dim: unknown (boot state, before the first tool result)
 */
function SandboxField({ status, theme }: { status: StatusInfo; theme: Theme }): React.JSX.Element {
  const label = renderSandboxField(status.sandbox);
  switch (status.sandbox) {
    case 'docker':
    case 'host+landlock':
    case 'host+seccomp':
    case 'host+landlock+seccomp':
      return <Text color="green">{label}</Text>;
    case 'host':
      return <Text color="yellow">{label}</Text>;
    case 'unsandboxed':
      return <Text color="red">{label}</Text>;
    case 'unknown':
      return <Text dimColor>{label}</Text>;
  }
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
