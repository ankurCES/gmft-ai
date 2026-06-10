import { Box, Text, useFocus, useInput } from 'ink';
import { useState } from 'react';
import type { ProviderModule, ModelInfo } from '@gmft/core';

export interface ModelSelectorProps {
  provider: ProviderModule;
  models: readonly ModelInfo[];
  onPick: (modelId: string) => void;
  onAbort: () => void;
}

/**
 * Arrow-key picker over a model list. The provider's default model
 * (where `isDefault === true`) is pre-selected. Enter calls
 * `onPick(modelId)` with the highlighted id. Esc calls `onAbort()`.
 */
export function ModelSelector({
  provider,
  models,
  onPick,
  onAbort,
}: ModelSelectorProps): React.JSX.Element {
  // Pre-select the default model, falling back to index 0.
  const defaultIdx = Math.max(
    0,
    models.findIndex((m) => m.isDefault),
  );
  const [idx, setIdx] = useState(defaultIdx);

  useFocus({ autoFocus: true });

  useInput((input, key) => {
    if (key.escape) {
      onAbort();
      return;
    }
    if (key.return) {
      const chosen = models[idx];
      if (chosen) onPick(chosen.id);
      return;
    }
    if (key.upArrow) {
      setIdx((i) => (i === 0 ? models.length - 1 : i - 1));
      return;
    }
    if (key.downArrow) {
      setIdx((i) => (i + 1) % models.length);
      return;
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Box marginBottom={1}>
        <Text color="cyan">Select model — {provider.displayName}</Text>
      </Box>
      {models.map((m, i) => {
        const active = i === idx;
        return (
          <Box key={m.id}>
            <Text color={active ? 'cyan' : undefined}>
              {active ? '▸ ' : '  '}
              {m.displayName}
              {m.isDefault ? <Text color="gray"> (default)</Text> : null}
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
