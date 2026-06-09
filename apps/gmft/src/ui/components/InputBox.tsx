import { Box, Text, useFocus, useInput } from 'ink';
import { useState } from 'react';
import type { Theme } from '../theme.js';

export interface InputBoxProps {
  onSubmit: (value: string) => void;
  history: string[];
  disabled?: boolean;
  placeholder?: string;
  theme: Theme;
}

/**
 * InputBox — a single-line text input with history navigation.
 *
 * Implementation note: we deliberately do NOT use `ink-text-input` because
 * it subscribes to the same `useInput` channel and competes for arrow-key
 * events. Instead we implement a small, focused input handler here. This
 * gives us full control over history, cursor, and edit semantics.
 */
export function InputBox({
  onSubmit,
  history,
  disabled = false,
  placeholder = 'ask gmft (or type /help)',
  theme,
}: InputBoxProps): React.JSX.Element {
  const [value, setValue] = useState('');
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);

  // Make this component focusable so Ink's <App> routes input events here.
  // In Ink v5, `useInput` only fires reliably when the component is
  // registered as a focusable (otherwise arrow keys / multi-char escape
  // sequences can be filtered). This is the standard pattern for any
  // input box in an Ink app.
  useFocus({ autoFocus: true });

  useInput((input, key) => {
    if (disabled) return;

    if (key.return) {
      const trimmed = value.trim();
      if (!trimmed) return;
      onSubmit(trimmed);
      setValue('');
      setHistoryIndex(null);
      return;
    }

    if (key.upArrow) {
      if (history.length === 0) return;
      const next = historyIndex === null ? history.length - 1 : Math.max(0, historyIndex - 1);
      setHistoryIndex(next);
      setValue(history[next] ?? '');
      return;
    }

    if (key.downArrow) {
      if (historyIndex === null) return;
      const next = historyIndex + 1;
      if (next >= history.length) {
        setHistoryIndex(null);
        setValue('');
      } else {
        setHistoryIndex(next);
        setValue(history[next] ?? '');
      }
      return;
    }

    if (key.backspace || key.delete) {
      setValue((v) => v.slice(0, -1));
      return;
    }

    if (key.ctrl && input === 'c') {
      // Parent App handles Ctrl-C for clean exit; swallow the keystroke here
      // so it doesn't get inserted into the value as "^C" text.
      return;
    }

    if (input && !key.ctrl && !key.meta) {
      setValue((v) => v + input);
      // Any new typing exits history-browsing mode.
      if (historyIndex !== null) setHistoryIndex(null);
    }
  });

  return (
    <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="row">
      <Box marginRight={1}>
        <Text color="cyan">▌</Text>
      </Box>
      <Box flexGrow={1}>
        {value === '' ? (
          <Text color="gray">{disabled ? '' : placeholder}</Text>
        ) : (
          <Text>{value}</Text>
        )}
      </Box>
      {disabled && (
        <Box marginLeft={1}>
          <Text color="yellow">⏳ running…</Text>
        </Box>
      )}
    </Box>
  );
}
