import { Box, Text } from 'ink';
import type { Theme } from '../theme.js';

export type TabId = 'chat' | 'findings' | 'help' | 'audit';

const TABS: { id: TabId; label: string }[] = [
  { id: 'chat', label: 'Chat' },
  { id: 'findings', label: 'Findings' },
  { id: 'help', label: 'Help' },
  { id: 'audit', label: 'Audit' },
];

export function TabBar({ active, theme }: { active: TabId; theme: Theme }): React.JSX.Element {
  return (
    <Box marginBottom={1}>
      {TABS.map((t, i) => {
        const isActive = t.id === active;
        return (
          <Box key={t.id} marginRight={2}>
            <Text>
              {isActive ? theme.accent(`▸ ${t.label}`) : theme.muted(t.label)}
              {i < TABS.length - 1 ? theme.muted(' │ ') : null}
            </Text>
          </Box>
        );
      })}
      <Box flexGrow={1} />
      <Text color="gray">Tab/Shift-Tab cycle · Ctrl-C exit</Text>
    </Box>
  );
}
