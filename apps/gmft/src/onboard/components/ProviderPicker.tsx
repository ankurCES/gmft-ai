import { Box, Text, useFocus, useInput } from 'ink';
import { useState } from 'react';
import type { ProviderModule } from '@gmft/core';

export interface ProviderPickerProps {
  providers: readonly ProviderModule[];
  onPick: (id: string) => void;
  onAbort: () => void;
}

/**
 * Arrow-key picker over a provider list. Enter calls `onPick(id)` with
 * the highlighted id. Esc calls `onAbort()`. Renders the list with the
 * currently-highlighted row prefixed with `▸ ` and a non-breaking
 * selection cursor for clarity.
 */
export function ProviderPicker({
  providers,
  onPick,
  onAbort,
}: ProviderPickerProps): React.JSX.Element {
  const [idx, setIdx] = useState(0);

  useFocus({ autoFocus: true });

  useInput((input, key) => {
    if (key.escape) {
      onAbort();
      return;
    }
    if (key.return) {
      const chosen = providers[idx];
      if (chosen) onPick(chosen.id);
      return;
    }
    if (key.upArrow) {
      setIdx((i) => (i === 0 ? providers.length - 1 : i - 1));
      return;
    }
    if (key.downArrow) {
      setIdx((i) => (i + 1) % providers.length);
      return;
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Box marginBottom={1}>
        <Text color="cyan">Select LLM provider</Text>
      </Box>
      {providers.map((p, i) => {
        const active = i === idx;
        return (
          <Box key={p.id}>
            <Text color={active ? 'cyan' : undefined}>
              {active ? '▸ ' : '  '}
              {p.displayName}
              <Text color="gray"> ({p.id})</Text>
            </Text>
          </Box>
        );
      })}
      <Box marginTop={1}>
        <Text color="gray">↑/↓ move · Enter pick · Esc cancel</Text>
      </Box>
    </Box>
  );
}
