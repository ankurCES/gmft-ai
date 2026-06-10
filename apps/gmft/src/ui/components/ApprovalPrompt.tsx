import { Box, Text, useFocus, useInput } from 'ink';
import { useState } from 'react';
import type { Theme } from '../theme.js';

export interface ApprovalPromptProps {
  /** Unique id for this pending confirmation; surfaced in the resolved callback. */
  id: string;
  /** Tool name (e.g. "shell_exec"). */
  name: string;
  /** The parsed args the LLM is about to invoke. Shown to the user verbatim. */
  args: Record<string, unknown>;
  /** Chokepoint-supplied reason (e.g. "destructive; confirm to proceed"). */
  reason: string;
  /** Resolves true if the user approves, false if they deny. */
  onResolve: (approved: boolean) => void;
  theme: Theme;
}

/**
 * ApprovalPrompt — a y/n prompt for chokepoint `confirm` decisions.
 *
 * The agent loop emits a `confirmation-needed` event when the chokepoint
 * says a tool call needs user approval. AgentApp turns that into an
 * entry in a `pendingApprovals` map and renders THIS component. The
 * component takes focus, listens for y/n/Esc, and calls `onResolve`
 * exactly once. AgentApp removes the entry from the map on resolve
 * and the prompt unmounts.
 *
 * Y or y -> approve
 * N or n, Esc -> deny
 *
 * The component is intentionally self-contained (does not import any
 * state from outside). AgentApp owns the lifecycle; the component is
 * the visible slice.
 */
export function ApprovalPrompt({
  id,
  name,
  args,
  reason,
  onResolve,
  theme,
}: ApprovalPromptProps): React.JSX.Element {
  // Track focus so the prompt can flash an "active" hint. The prompt
  // is auto-focused when it mounts; AgentApp re-renders without it
  // when resolved.
  useFocus({ autoFocus: true });
  const [pulsed, setPulsed] = useState(false);

  useInput((input, key) => {
    if (key.escape) {
      onResolve(false);
      return;
    }
    if (input === 'y' || input === 'Y') {
      onResolve(true);
      return;
    }
    if (input === 'n' || input === 'N') {
      onResolve(false);
      return;
    }
    // Any other key — pulse the border so the user sees their keystroke
    // is being routed here.
    setPulsed(true);
    setTimeout(() => setPulsed(false), 120);
  });

  // Truncate the args dump for display. Long argv arrays would
  // blow up the terminal; the audit log retains the full payload.
  const argsSummary = summarizeArgs(args);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={pulsed ? 'magenta' : 'yellow'}
      paddingX={1}
      marginBottom={1}
    >
      <Box>
        <Text>
          {theme.warn('⚠ chokepoint confirm  ')}
          {theme.muted('id=')}
          {id}
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text>
          {theme.muted('tool  ')}
          <Text color="cyan">{name}</Text>
        </Text>
      </Box>
      <Box>
        <Text wrap="wrap">
          {theme.muted('args  ')}
          <Text color="gray">{argsSummary}</Text>
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text wrap="wrap">
          {theme.muted('why   ')}
          <Text color="yellow">{reason}</Text>
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text>
          {theme.muted('press ')}
          <Text color="green">[Y]</Text>
          {theme.muted(' to approve  ')}
          <Text color="red">[N]</Text>
          {theme.muted(' or ')}
          <Text color="red">[Esc]</Text>
          {theme.muted(' to deny')}
        </Text>
      </Box>
    </Box>
  );
}

function summarizeArgs(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    let s: string;
    if (typeof v === 'string') {
      s = v.length > 80 ? `${v.slice(0, 77)}...` : v;
    } else if (Array.isArray(v)) {
      s = `[${v.length} item${v.length === 1 ? '' : 's'}]`;
    } else if (v && typeof v === 'object') {
      s = '{...}';
    } else {
      s = String(v);
    }
    parts.push(`${k}=${s}`);
  }
  const joined = parts.join('  ');
  return joined.length > 240 ? `${joined.slice(0, 237)}...` : joined;
}
