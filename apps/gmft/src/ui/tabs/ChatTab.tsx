import { Box, Static, Text } from 'ink';
import { useEffect, useRef } from 'react';
import { InputBox } from '../components/InputBox.js';
import { Message, type Message as Msg } from '../components/Message.js';
import { StatusRail, type StatusInfo } from '../components/StatusRail.js';
import type { Theme } from '../theme.js';

export interface ChatTabProps {
  messages: Msg[];
  history: string[];
  status: StatusInfo;
  onSubmit: (value: string) => void;
  theme: Theme;
}

export function ChatTab({
  messages,
  history,
  status,
  onSubmit,
  theme,
}: ChatTabProps): React.JSX.Element {
  // Re-mount the bottom-of-list marker so the cursor always anchors to the latest
  // message. This is the standard Ink pattern.
  const endRef = useRef<{ rerender: () => void } | null>(null);
  useEffect(() => {
    endRef.current?.rerender();
  }, [messages.length]);

  return (
    <Box flexDirection="column">
      <Static items={messages.slice(0, -1)}>
        {(m) => <Message key={m.id} message={m} theme={theme} />}
      </Static>
      {messages.length > 0 && (
        <Message
          message={messages[messages.length - 1] as Msg}
          theme={theme}
        />
      )}
      <StatusRail status={status} theme={theme} />
      <InputBox onSubmit={onSubmit} history={history} theme={theme} />
      {history.length > 0 && (
        <Box marginTop={1}>
          <Text color="gray">↑/↓ for history · Ctrl-C to exit</Text>
        </Box>
      )}
    </Box>
  );
}
