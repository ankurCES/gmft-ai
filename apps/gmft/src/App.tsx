import { Box, Text, useApp, useInput } from 'ink';
import { useState } from 'react';
import { ChatTab } from './ui/tabs/ChatTab.js';
import { FindingsTab } from './ui/tabs/FindingsTab.js';
import { HelpTab } from './ui/tabs/HelpTab.js';
import { TabBar, type TabId } from './ui/components/TabBar.js';
import type { Message as Msg } from './ui/components/Message.js';
import { makeTheme, type Theme } from './ui/theme.js';
import type { StatusInfo } from './ui/components/StatusRail.js';

export type { TabId };

export interface AppProps {
  initialMessages?: Msg[];
  initialHistory?: string[];
  initialStatus?: Partial<StatusInfo>;
  initialTab?: TabId;
  onSubmit?: (value: string) => Promise<Msg | null> | Msg | null;
  /**
   * Called once when the user requests exit (Ctrl-C). Production also calls
   * useApp().exit() to unmount. Tests pass a spy via this prop to assert the
   * exit path was hit without unmounting the Ink instance mid-test.
   */
  onExit?: () => void;
  themeName?: 'auto' | 'dark' | 'light' | 'high-contrast';
}

const TAB_ORDER: TabId[] = ['chat', 'findings', 'help'];

export function App({
  initialMessages = [],
  initialHistory = [],
  initialStatus = {},
  initialTab = 'chat',
  onSubmit,
  onExit,
  themeName = 'auto',
}: AppProps): React.JSX.Element {
  const theme: Theme = makeTheme(themeName);
  const { exit } = useApp();
  const [activeTab, setActiveTab] = useState<TabId>(initialTab);
  const [messages, setMessages] = useState<Msg[]>(
    initialMessages.length > 0
      ? initialMessages
      : [
          {
            id: 'sys-welcome',
            role: 'system',
            content:
              'GMFT-AI v0.1.0-phase1 — TUI scaffold. No LLM connected yet. Type /help for commands. Tab to switch tabs, Ctrl-C to exit.',
            ts: Date.now(),
          },
        ],
  );
  const [history, setHistory] = useState<string[]>(initialHistory);
  const [status] = useState<StatusInfo>({
    model: 'none',
    provider: 'none',
    sandbox: 'unknown',
    tokensIn: 0,
    tokensOut: 0,
    toolCalls: 0,
    findings: 0,
    ...initialStatus,
  });

  // Global keybindings. This hook is always active, alongside the InputBox's
  // own useInput. Multiple useInput hooks in v5 both receive every event;
  // each decides whether to act.
  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      onExit?.();
      exit();
      return;
    }
    if (key.tab && !key.shift) {
      setActiveTab((t) => TAB_ORDER[(TAB_ORDER.indexOf(t) + 1) % TAB_ORDER.length] ?? t);
      return;
    }
    if (key.tab && key.shift) {
      setActiveTab((t) =>
        TAB_ORDER[(TAB_ORDER.indexOf(t) - 1 + TAB_ORDER.length) % TAB_ORDER.length] ?? t,
      );
      return;
    }
  });

  const handleSubmit = async (value: string) => {
    const userMsg: Msg = {
      id: `u-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      role: 'user',
      content: value,
      ts: Date.now(),
    };
    setMessages((m) => [...m, userMsg]);
    setHistory((h) => [...h, value]);

    if (value === '/help') {
      setMessages((m) => [
        ...m,
        {
          id: `a-${Date.now()}`,
          role: 'assistant',
          content:
            'Commands (phase 1, scaffold only):\n' +
            '  /help   — show this help\n' +
            '  /clear  — clear chat (land in phase 2)\n' +
            '  /model  — show model (land in phase 2)\n' +
            '  /exit   — Ctrl-C to exit for now',
          ts: Date.now(),
        },
      ]);
      return;
    }

    if (value === '/clear') {
      setMessages([]);
      return;
    }

    if (onSubmit) {
      const reply = await onSubmit(value);
      if (reply) {
        setMessages((m) => [...m, reply]);
      }
      return;
    }

    // Default echo so the user sees the TUI is alive.
    setMessages((m) => [
      ...m,
      {
        id: `a-${Date.now()}`,
        role: 'assistant',
        content: `[phase 1 stub] received: ${value}`,
        ts: Date.now(),
      },
    ]);
  };

  return (
    // InputBox is the only focusable in the tree (useFocus + autoFocus).
    // Any future global useInput (e.g. Ctrl-C) would have to live here AND
    // receive focus first, or the InputBox would swallow the keystrokes.
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1}>
        <Text>{theme.banner(' gmft-ai ')}</Text>
      </Box>
      <TabBar active={activeTab} theme={theme} />
      {activeTab === 'chat' && (
        <ChatTab
          messages={messages}
          history={history}
          status={status}
          onSubmit={handleSubmit}
          theme={theme}
        />
      )}
      {activeTab === 'findings' && <FindingsTab theme={theme} status={status} />}
      {activeTab === 'help' && <HelpTab theme={theme} />}
    </Box>
  );
}
