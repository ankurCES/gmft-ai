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
  /**
   * v0.1 phase 5 — when set, the user must type this literal string
   * (verbatim) to approve. Esc / Enter-without-match denies. Renders
   * a typing prompt instead of the y/n prompt. Undefined = plain y/n.
   */
  prompt?: string;
  /** Resolves true if the user approves, false if they deny. */
  onResolve: (approved: boolean) => void;
  theme: Theme;
}

/**
 * ApprovalPrompt — a y/n or type-to-confirm prompt for chokepoint
 * `confirm` / `type-then-confirm` decisions.
 *
 * The agent loop emits a `confirmation-needed` event when the chokepoint
 * says a tool call needs user approval. AgentApp turns that into an
 * entry in a `pendingApprovals` map and renders THIS component. The
 * component takes focus, listens for y/n/Esc (plain mode) or typed
 * input (type-to-confirm mode), and calls `onResolve` exactly once.
 * AgentApp removes the entry from the map on resolve and the prompt
 * unmounts.
 *
 * Plain mode (no `prompt` prop):
 *   Y or y -> approve
 *   N or n, Esc -> deny
 *
 * Type-to-confirm mode (when `prompt` is set):
 *   user types the literal `prompt` string and presses Enter -> approve
 *   Esc -> deny
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
  prompt,
  onResolve,
  theme,
}: ApprovalPromptProps): React.JSX.Element {
  // Track focus so the prompt can flash an "active" hint. The prompt
  // is auto-focused when it mounts; AgentApp re-renders without it
  // when resolved.
  useFocus({ autoFocus: true });
  const [pulsed, setPulsed] = useState(false);
  // Type-to-confirm mode: accumulate input + Enter.
  const [typed, setTyped] = useState('');

  useInput((input, key) => {
    if (key.escape) {
      onResolve(false);
      return;
    }
    if (prompt !== undefined) {
      // Type-to-confirm mode.
      if (key.return) {
        onResolve(typed === prompt);
        return;
      }
      if (key.backspace || key.delete) {
        setTyped((t) => t.slice(0, -1));
        setPulsed(true);
        setTimeout(() => setPulsed(false), 120);
        return;
      }
      // Ignore control keys / non-printable; just append printable chars.
      if (input && !key.ctrl && !key.meta) {
        setTyped((t) => t + input);
        setPulsed(true);
        setTimeout(() => setPulsed(false), 120);
      }
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
  // v0.3.B — destructive warning surface. When the chokepoint decided
  // `type-then-confirm`, the user is one keystroke from running a
  // tool that can drop packets, take down a service, or compromise
  // a host. The visual treatment is intentionally louder than a
  // plain `confirm`:
  //   - red border (vs. yellow)
  //   - a `DESTRUCTIVE  ` prefix in the header
  //   - the literal-typing instructions in red
  // Pulsing (a keystroke landing here) still overrides the border
  // so the user can see their input is being routed.
  const isDestructive = prompt !== undefined;
  const baseBorder = isDestructive ? 'red' : 'yellow';

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={pulsed ? 'magenta' : baseBorder}
      paddingX={1}
      marginBottom={1}
    >
      <Box>
        <Text>
          {isDestructive
            ? <Text color="red" bold>{`DESTRUCTIVE  `}</Text>
            : theme.warn(`⚠ chokepoint confirm  `)}
          {!isDestructive ? null : theme.warn('chokepoint type-to-confirm  ')}
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
          <Text color={isDestructive ? 'red' : 'yellow'}>{reason}</Text>
        </Text>
      </Box>
      {isDestructive ? (
        <>
          <Box marginTop={1}>
            <Text>
              <Text color="red" bold>{'type  '}</Text>
              <Text color="red">{prompt}</Text>
              <Text color="red">{'  then press '}</Text>
              <Text color="green">[Enter]</Text>
            </Text>
          </Box>
          <Box>
            <Text>
              <Text color="red" bold>{'input '}</Text>
              <Text color={typed === prompt ? 'green' : 'gray'}>[{typed || ' '}]</Text>
              <Text color="gray">_</Text>
            </Text>
          </Box>
        </>
      ) : (
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
      )}
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
