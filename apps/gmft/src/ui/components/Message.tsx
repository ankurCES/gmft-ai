import { Box, Text } from 'ink';
import type { Theme } from '../theme.js';

export type Role = 'user' | 'assistant' | 'system' | 'tool';

export interface Message {
  id: string;
  role: Role;
  content: string;
  ts: number;
  /** When role === 'tool', the tool call this is a result for. */
  toolCallId?: string;
}

export function renderRole(role: Role, theme: Theme): string {
  switch (role) {
    case 'user':
      return theme.user('you');
    case 'assistant':
      return theme.assistant('gmft');
    case 'system':
      return theme.muted('sys');
    case 'tool':
      return theme.tool('tool');
  }
}

export function Message({
  message,
  theme,
}: {
  message: Message;
  theme: Theme;
}): React.JSX.Element {
  const prefix = renderRole(message.role, theme);
  return (
    <Box flexDirection="row" marginBottom={1}>
      <Box marginRight={1}>
        <Text>{prefix}</Text>
      </Box>
      <Box flexGrow={1}>
        <Text wrap="wrap">{message.content}</Text>
      </Box>
    </Box>
  );
}
