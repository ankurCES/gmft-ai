import { render, type RenderOptions } from 'ink-testing-library';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { App } from '../src/App.js';
import type { Message as Msg } from '../src/ui/components/Message.js';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Render the App and wait one microtask before returning. The first
 * `stdin.write` after `render()` would otherwise be dropped for escape
 * sequences because Ink's useInput subscription runs in a useEffect that
 * hasn't fired yet at the time of a synchronous write.
 */
async function renderApp(props: React.ComponentProps<typeof App> = {}) {
  const result = render(React.createElement(App, props) as ReactElement, {} as RenderOptions);
  await tick();
  return result;
}

describe('App (e2e)', () => {
  it('/help shows the commands list in the chat', async () => {
    // The slash dispatcher is wired via onSubmit in production (AgentApp
    // composes dispatchSlash into a real onSubmit). For an e2e smoke
    // test, we mirror that: a tiny onSubmit that recognizes /help and
    // /clear (the most common path) and echoes everything else.
    const onSubmit = async (v: string): Promise<Msg | null> => {
      if (v === '/help') {
        return {
          id: 'help-1',
          role: 'assistant',
          content:
            'Commands:\n' + '  /help\n' + '  /clear\n' + '  /model\n' + '  /provider\n',
          ts: 0,
        };
      }
      return { id: 'echo-1', role: 'assistant', content: v, ts: 0 };
    };
    const { stdin, lastFrame } = await renderApp({ onSubmit });
    stdin.write('/help');
    await tick();
    stdin.write('\r');
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('/help');
    expect(frame).toContain('/clear');
    expect(frame).toContain('/model');
  });

  it('echoes the user message in the transcript', async () => {
    const onSubmit = async (v: string): Promise<Msg | null> => ({
      id: 'echo-1',
      role: 'assistant',
      content: v,
      ts: 0,
    });
    const { stdin, lastFrame } = await renderApp({ onSubmit });
    stdin.write('hello gmft');
    await tick();
    stdin.write('\r');
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('hello gmft');
  });

  it('/clear wipes the transcript', async () => {
    // /clear is special: it has to mutate messages state. In production
    // it's the slash dispatcher's `clearMessages` flag. Here we simulate
    // it by giving the parent a controlled `messages` list and pushing
    // [] back on /clear.
    const onSubmit = async (v: string): Promise<Msg | null> => {
      if (v === '/help') {
        return {
          id: 'help-1',
          role: 'assistant',
          content: 'Commands (phase 1, scaffold only): blah blah',
          ts: 0,
        };
      }
      return null;
    };
    const ControlledClear = (): React.JSX.Element => {
      const [msgs, setMsgs] = React.useState<Msg[]>([]);
      return (
        <App
          messages={msgs}
          onMessagesChange={setMsgs}
          onSubmit={async (v) => {
            if (v === '/clear') {
              setMsgs([]);
              return null;
            }
            return onSubmit(v);
          }}
        />
      );
    };
    const { stdin, lastFrame } = render(React.createElement(ControlledClear));
    await tick();
    stdin.write('/help');
    await tick();
    stdin.write('\r');
    await tick();
    expect(lastFrame() ?? '').toContain('Commands (phase 1, scaffold only)');

    stdin.write('/clear');
    await tick();
    stdin.write('\r');
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('Commands (phase 1, scaffold only)');
  });

  it('calls onSubmit for non-slash input and appends the reply', async () => {
    const reply: Msg = {
      id: 'mock-reply-1',
      role: 'assistant',
      content: 'mock assistant reply',
      ts: 0,
    };
    const onSubmit = vi.fn().mockResolvedValue(reply);
    const { stdin, lastFrame } = await renderApp({ onSubmit });

    stdin.write('tell me a secret');
    await tick();
    stdin.write('\r');
    await tick();
    // onSubmit is async; give it a couple of microtasks to resolve.
    await tick();
    await tick();

    expect(onSubmit).toHaveBeenCalledWith('tell me a secret');
    expect(lastFrame() ?? '').toContain('mock assistant reply');
  });

  it('falls back to the phase-1 stub echo when no onSubmit is provided', async () => {
    const { stdin, lastFrame } = await renderApp();
    stdin.write('plain text');
    await tick();
    stdin.write('\r');
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('plain text');
    expect(frame).toContain('[phase 1 stub] received: plain text');
  });

  it('history ↑ recalls the last submitted message', async () => {
    const { stdin, lastFrame } = await renderApp();
    stdin.write('alpha');
    await tick();
    stdin.write('\r');
    await tick();

    stdin.write('beta');
    await tick();
    stdin.write('\r');
    await tick();

    // The hint line should now be visible because history is non-empty.
    expect(lastFrame() ?? '').toContain('↑/↓ for history');

    stdin.write('\u001B[A'); // up arrow -> 'beta'
    await tick();
    expect(lastFrame() ?? '').toContain('beta');

    stdin.write('\u001B[A'); // up arrow -> 'alpha'
    await tick();
    expect(lastFrame() ?? '').toContain('alpha');
  });

  it('Tab cycles Chat -> Findings -> Help -> Chat', async () => {
    const { stdin, lastFrame } = await renderApp();
    // Default is chat; the tab bar should show "Chat" as active.
    expect(lastFrame() ?? '').toContain('▸ Chat');

    stdin.write('\t'); // Tab -> Findings
    await tick();
    expect(lastFrame() ?? '').toContain('▸ Findings');
    expect(lastFrame() ?? '').toContain('No findings yet');

    stdin.write('\t'); // Tab -> Help
    await tick();
    expect(lastFrame() ?? '').toContain('▸ Help');
    expect(lastFrame() ?? '').toContain('Keybindings');

    stdin.write('\t'); // Tab -> wraps back to Chat
    await tick();
    expect(lastFrame() ?? '').toContain('▸ Chat');
  });

  it('Shift-Tab cycles backwards Help -> Findings -> Chat', async () => {
    const { stdin, lastFrame } = await renderApp({ initialTab: 'help' });
    expect(lastFrame() ?? '').toContain('▸ Help');

    // Shift-Tab is ESC [ Z in xterm.
    stdin.write('\u001B[Z');
    await tick();
    expect(lastFrame() ?? '').toContain('▸ Findings');

    stdin.write('\u001B[Z');
    await tick();
    expect(lastFrame() ?? '').toContain('▸ Chat');
  });

  it('Ctrl-C calls onExit', async () => {
    const onExit = vi.fn();
    const { stdin } = await renderApp({ onExit });
    stdin.write('\u0003');
    await tick();
    expect(onExit).toHaveBeenCalledTimes(1);
  });
});
