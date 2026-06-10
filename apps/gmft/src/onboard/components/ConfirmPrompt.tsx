import { Box, Text, useFocus, useInput } from 'ink';
import { useState } from 'react';

export interface ConfirmPromptProps {
  /** Lines of context shown above the prompt (e.g. the resolved config). */
  message: string[];
  /** Call when the user confirms (Yes). */
  onConfirm: () => void;
  /** Call when the user declines (No) or presses Esc. */
  onDecline: () => void;
}

/**
 * Two-option prompt shown after credentials are collected. ←/→ toggle
 * Yes/No, Enter fires the focused option, Esc is treated as decline.
 * Default focus is Yes (destructive config is the opt-in direction).
 */
export function ConfirmPrompt({
  message,
  onConfirm,
  onDecline,
}: ConfirmPromptProps): React.JSX.Element {
  const [yes, setYes] = useState(true);

  useFocus({ autoFocus: true });

  useInput((input, key) => {
    if (key.escape) {
      onDecline();
      return;
    }
    if (key.leftArrow) {
      setYes(true);
      return;
    }
    if (key.rightArrow) {
      setYes(false);
      return;
    }
    if (key.return) {
      if (yes) onConfirm();
      else onDecline();
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      {message.map((line, i) => (
        <Box key={i}>
          <Text>{line}</Text>
        </Box>
      ))}
      <Box marginTop={1} gap={2}>
        <Text color={yes ? 'green' : undefined} bold={yes}>
          {'[ '}
          {yes ? '▸ ' : '  '}Yes
          {' ]'}
        </Text>
        <Text color={!yes ? 'red' : undefined} bold={!yes}>
          {'[ '}
          {!yes ? '▸ ' : '  '}No
          {' ]'}
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text color="gray">←/→ toggle · Enter select · Esc cancel</Text>
      </Box>
    </Box>
  );
}
