import { Box, Text } from 'ink';
import type { Theme } from '../theme.js';

const SECTIONS: { title: string; lines: string[] }[] = [
  {
    title: 'Keybindings',
    lines: [
      'Tab / Shift-Tab  — cycle Chat / Findings / Help',
      '↑ / ↓            — recall history (chat only)',
      'Enter            — submit input',
      'Ctrl-C           — exit',
    ],
  },
  {
    title: 'Slash commands (chat tab)',
    lines: [
      '/help            — show this help in chat',
      '/clear           — clear chat transcript',
      '/model           — show model (phase 2)',
    ],
  },
  {
    title: 'Status',
    lines: [
      'sandbox          — docker (default) or host (warns)',
      'model / provider — none until phase 2',
      'findings         — count of structured tool results',
    ],
  },
];

export function HelpTab({ theme }: { theme: Theme }): React.JSX.Element {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
      {SECTIONS.map((s, i) => (
        <Box key={s.title} flexDirection="column" marginBottom={i < SECTIONS.length - 1 ? 1 : 0}>
          <Text>{theme.accent(s.title)}</Text>
          {s.lines.map((l) => (
            <Text key={l}>{l}</Text>
          ))}
        </Box>
      ))}
    </Box>
  );
}
