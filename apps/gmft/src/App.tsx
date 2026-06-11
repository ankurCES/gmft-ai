import { Box, Text, useApp, useInput } from 'ink';
import { useEffect, useState } from 'react';
import { ChatTab } from './ui/tabs/ChatTab.js';
import { FindingsTab } from './ui/tabs/FindingsTab.js';
import { HelpTab } from './ui/tabs/HelpTab.js';
import { TabBar, type TabId } from './ui/components/TabBar.js';
import { ApprovalPrompt } from './ui/components/ApprovalPrompt.js';
import type { Message as Msg } from './ui/components/Message.js';
import { makeTheme, type Theme } from './ui/theme.js';
import type { StatusInfo } from './ui/components/StatusRail.js';
import type { Finding } from '@gmft/core';
import { FindingsStore, defaultReportPath } from '@gmft/tools';

export type { TabId };

export interface AppProps {
  /**
   * Controlled message list. If provided, App is presentational and the
   * parent owns the chat state. If omitted, App falls back to the
   * 1.5d-era internal-state behavior (used by tests that don't care
   * about persistence or slash commands).
   */
  messages?: Msg[];
  /** Called when a new user message is submitted. */
  onSubmit?: (value: string) => Promise<Msg | null> | Msg | null;
  /**
   * Optional callback that can replace/clear the messages in response
   * to a slash command. Called with the *next* messages array; the
   * parent decides how to update its own state.
   */
  onMessagesChange?: (next: Msg[]) => void;
  initialMessages?: Msg[];
  initialHistory?: string[];
  /**
   * Live session status. The parent (AgentApp) owns the state and
   * updates it from the agent loop's `tool-result` events. The App
   * just renders. `initialStatus` is still accepted for tests that
   * don't want to manage a status ref.
   */
  status?: StatusInfo;
  initialStatus?: Partial<StatusInfo>;
  initialTab?: TabId;
  initialConfig?: { provider?: string; model?: string };
  /**
   * Called once when the user requests exit (Ctrl-C). Production also calls
   * useApp().exit() to unmount. Tests pass a spy via this prop to assert the
   * exit path was hit without unmounting the Ink instance mid-test.
   */
  onExit?: () => void;
  themeName?: 'auto' | 'dark' | 'light' | 'high-contrast';
  /**
   * v0.1 phase 3.5: chokepoint `confirm` decisions surface as
   * `<ApprovalPrompt>` rows above the chat. When the array is empty
   * the prompts are not rendered. `onResolve` is the user's y/n.
   * AgentApp owns the lifecycle (ref-based resolver + visible state);
   * App just renders.
   */
  pendingApprovals?: ReadonlyArray<{
    id: string;
    name: string;
    args: Record<string, unknown>;
    reason: string;
    /** v0.1 phase 5 — when set, render type-to-confirm UI. */
    prompt?: string;
  }>;
  onApprovalResolve?: (id: string, approved: boolean) => void;
  /**
   * v0.1 phase 6: the directory holding the session's findings.jsonl
   * + .selections.json. When provided along with `sessionId`, the
   * FindingsTab is loaded with real findings and a working sidecar.
   * The session id is opaque to the App — the parent (AgentApp or
   * tests) decides where findings live.
   */
  baseDir?: string;
  sessionId?: string;
}

const TAB_ORDER: TabId[] = ['chat', 'findings', 'help'];

export function App({
  messages: controlledMessages,
  onMessagesChange,
  initialMessages = [],
  initialHistory = [],
  status: controlledStatus,
  initialStatus = {},
  initialTab = 'chat',
  initialConfig,
  onSubmit,
  onExit,
  themeName = 'auto',
  pendingApprovals = [],
  onApprovalResolve,
  baseDir,
  sessionId,
}: AppProps): React.JSX.Element {
  const theme: Theme = makeTheme(themeName);
  const { exit } = useApp();
  const [activeTab, setActiveTab] = useState<TabId>(initialTab);
  // v0.1 phase 6: load findings + selections on mount, and re-load
  // whenever the user switches to the Findings tab. The store is
  // read-only from the App's perspective — the FindingsTab owns the
  // sidecar (selections) autosave.
  const [findings, setFindings] = useState<readonly Finding[]>(() => {
    if (!baseDir || !sessionId) return [];
    try {
      return new FindingsStore({ baseDir, sessionId }).list();
    } catch {
      return [];
    }
  });
  useEffect(() => {
    if (!baseDir || !sessionId) return;
    if (activeTab !== 'findings') return;
    try {
      setFindings(new FindingsStore({ baseDir, sessionId }).list());
    } catch {
      // Malformed findings.jsonl → leave the prior state in place.
    }
  }, [activeTab, baseDir, sessionId]);
  // The `r` key on the Findings tab calls this; we dispatch a slash
  // command the existing message pipeline can handle. We build the
  // prompt the way the spec's plan §B.2 calls for: "write a report
  // of this session's findings to <path>". The path is the default
  // report path (so the user knows exactly where the file lands).
  const handleGenerateReport = async (): Promise<void> => {
    if (!baseDir || !sessionId) return;
    const targetPath = defaultReportPath(sessionId, 'markdown');
    const prompt = `write a report of this session's findings to ${targetPath}`;
    if (onSubmit) {
      const reply = await onSubmit(prompt);
      if (reply) {
        // Mirror the chat update on the App's controlled state so
        // the user sees the synthetic "report" message in context.
        const next: Msg[] = controlledMessages
          ? [...controlledMessages, reply]
          : [];
        onMessagesChange?.(next);
      }
    }
  };
  // Internal state is used only when the parent does NOT control messages.
  // Tests that don't pass `messages` (e.g. `smoke.test.tsx`) get the
  // legacy behavior; production uses `AgentApp`'s controlled mode.
  const [internalMessages, setInternalMessages] = useState<Msg[]>(
    initialMessages.length > 0
      ? initialMessages
      : [
          {
            id: 'sys-welcome',
            role: 'system',
            content:
              'GMFT-AI v0.1.0-phase1 — TUI shell. Type /help for commands. Tab to switch tabs, Ctrl-C to exit.',
            ts: Date.now(),
          },
        ],
  );
  const isControlled = controlledMessages !== undefined;
  const messages: Msg[] = isControlled ? controlledMessages : internalMessages;
  const setMessages = (next: Msg[] | ((prev: Msg[]) => Msg[])): void => {
    if (isControlled) {
      const value =
        typeof next === 'function' ? (next as (p: Msg[]) => Msg[])(controlledMessages) : next;
      onMessagesChange?.(value);
    } else {
      setInternalMessages(next);
    }
  };
  const [history, setHistory] = useState<string[]>(initialHistory);
  // Live status. When the parent passes a controlled `status` (the
  // AgentApp path), use it verbatim — the parent owns the updates.
  // Otherwise fall back to the old behaviour: initialize from
  // `initialStatus` and never update, which is what tests + the
  // smoke test rely on.
  const [internalStatus] = useState<StatusInfo>(() => ({
    model: initialConfig?.model ?? 'none',
    provider: initialConfig?.provider ?? 'none',
    sandbox: 'unknown',
    tokensIn: 0,
    tokensOut: 0,
    toolCalls: 0,
    findings: 0,
    findingsBySeverity: { info: 0, low: 0, medium: 0, high: 0, critical: 0 },
    // v0.2.A.3 — default to 'quiet' so the StatusRail has a
    // well-defined supervisor field. Production runs override this
    // via the AgentApp's `setStatus` path; tests + smoke path use
    // the default.
    supervisor: 'quiet',
    fireCount: 0,
    ...initialStatus,
  }));
  const status = controlledStatus ?? internalStatus;

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

    if (onSubmit) {
      const reply = await onSubmit(value);
      if (reply) {
        setMessages((m) => [...m, reply]);
      }
      return;
    }

    // Default echo so the user sees the TUI is alive (used by tests
    // that don't pass an onSubmit).
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

  // Silence the unused-import warning (kept available for future
  // scroll/focus behaviors that need an effect on messages.length).
  void messages.length;

  return (
    // InputBox is the only focusable in the tree (useFocus + autoFocus).
    // Any future global useInput (e.g. Ctrl-C) would have to live here AND
    // receive focus first, or the InputBox would swallow the keystrokes.
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1}>
        <Text>{theme.banner(' gmft-ai ')}</Text>
      </Box>
      <TabBar active={activeTab} theme={theme} />
      {/* v0.1 phase 3.5: chokepoint confirmations render above the
          active tab so the user always sees a pending prompt regardless
          of which tab they're on. When the array is empty, no row
          appears; the layout is unchanged from 1.5f. */}
      {pendingApprovals.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          {pendingApprovals.map((p) => (
            <ApprovalPrompt
              key={p.id}
              id={p.id}
              name={p.name}
              args={p.args}
              reason={p.reason}
              {...(p.prompt !== undefined ? { prompt: p.prompt } : {})}
              onResolve={(approved) => onApprovalResolve?.(p.id, approved)}
              theme={theme}
            />
          ))}
        </Box>
      )}
      {activeTab === 'chat' && (
        <ChatTab
          messages={messages}
          history={history}
          status={status}
          onSubmit={handleSubmit}
          theme={theme}
        />
      )}
      {activeTab === 'findings' && (
        <FindingsTab
          theme={theme}
          status={status}
          {...(baseDir !== undefined ? { baseDir } : {})}
          {...(sessionId !== undefined ? { sessionId } : {})}
          findings={findings}
          onGenerateReport={() => {
            void handleGenerateReport();
          }}
        />
      )}
      {activeTab === 'help' && <HelpTab theme={theme} />}
    </Box>
  );
}
