import { Box, Text, useFocus, useInput } from 'ink';
import { useState } from 'react';
import type { AuthField } from '@gmft/core';

export interface ApiKeyPromptProps {
  field: AuthField;
  onSubmit: (value: string) => void;
  onAbort: () => void;
}

/**
 * Single-line text input for an auth field. Echoes `*` for each
 * character typed so the secret isn't visible. Empty value + Enter
 * is ignored (we don't want to accept "no key"). Esc aborts.
 *
 * For non-secret fields (e.g. Ollama's `endpoint`, when
 * `field.isEndpoint === true`), the input echoes the literal text
 * so the user can see what URL they're typing.
 */
export function ApiKeyPrompt({
  field,
  onSubmit,
  onAbort,
}: ApiKeyPromptProps): React.JSX.Element {
  const [value, setValue] = useState('');

  useFocus({ autoFocus: true });

  useInput((input, key) => {
    if (key.escape) {
      onAbort();
      return;
    }
    if (key.return) {
      const trimmed = value.trim();
      if (!trimmed) return;
      onSubmit(trimmed);
      return;
    }
    if (key.backspace || key.delete) {
      setValue((v) => v.slice(0, -1));
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      setValue((v) => v + input);
    }
  });

  const echo = field.isEndpoint
    ? value || ' '
    : '*'.repeat(value.length) || ' ';

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Box marginBottom={1}>
        <Text color="cyan">
          {field.label}
          {field.isEndpoint ? ' (endpoint URL)' : ''}
        </Text>
      </Box>
      <Box>
        <Text color="cyan">▌</Text>
        <Box marginLeft={1}>
          <Text>{echo}</Text>
        </Box>
      </Box>
      {field.placeholder && value === '' && (
        <Box marginTop={1}>
          <Text color="gray">e.g. {field.placeholder}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text color="gray">Enter submit · Esc cancel</Text>
      </Box>
    </Box>
  );
}
