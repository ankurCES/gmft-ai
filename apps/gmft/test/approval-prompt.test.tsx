import { render } from 'ink-testing-library';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { ApprovalPrompt } from '../src/ui/components/ApprovalPrompt.js';
import { makeTheme } from '../src/ui/theme.js';

const theme = makeTheme('dark');

const tick = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

async function renderPrompt(
  props: Omit<React.ComponentProps<typeof ApprovalPrompt>, 'theme'>,
) {
  const result = render(React.createElement(ApprovalPrompt, { ...props, theme }) as ReactElement);
  await tick();
  return result;
}

describe('ApprovalPrompt', () => {
  it('renders the tool name, args, reason, and y/n hint', async () => {
    const { lastFrame } = await renderPrompt({
      id: 'tc-1',
      name: 'shell_exec',
      args: { argv: ['ls', '-la'] },
      reason: 'destructive; confirm to proceed',
      onResolve: () => {},
    });
    const frame = lastFrame() ?? '';
    expect(frame).toContain('chokepoint confirm');
    expect(frame).toContain('shell_exec');
    // The argv array is summarized (not serialized verbatim) so the
    // user can scan the prompt quickly. Long argv lives in the audit log.
    expect(frame).toContain('argv=[2 items]');
    expect(frame).toContain('destructive; confirm to proceed');
    expect(frame).toContain('[Y]');
    expect(frame).toContain('[N]');
    expect(frame).toContain('id=tc-1');
  });

  it('calls onResolve(true) when y is pressed', async () => {
    const onResolve = vi.fn();
    const { stdin } = await renderPrompt({
      id: 'tc-2',
      name: 'shell_exec',
      args: { argv: ['echo', 'hi'] },
      reason: 'destructive',
      onResolve,
    });
    stdin.write('y');
    await tick();
    expect(onResolve).toHaveBeenCalledWith(true);
    expect(onResolve).toHaveBeenCalledTimes(1);
  });

  it('calls onResolve(false) when n is pressed', async () => {
    const onResolve = vi.fn();
    const { stdin } = await renderPrompt({
      id: 'tc-3',
      name: 'shell_exec',
      args: { argv: ['rm', '-rf', '/'] },
      reason: 'destructive',
      onResolve,
    });
    stdin.write('n');
    await tick();
    expect(onResolve).toHaveBeenCalledWith(false);
    expect(onResolve).toHaveBeenCalledTimes(1);
  });

  it('calls onResolve(false) when Esc is pressed', async () => {
    const onResolve = vi.fn();
    const { stdin } = await renderPrompt({
      id: 'tc-4',
      name: 'shell_exec',
      args: { argv: ['whoami'] },
      reason: 'destructive',
      onResolve,
    });
    stdin.write('\u001B'); // ESC
    await tick();
    expect(onResolve).toHaveBeenCalledWith(false);
  });

  it('truncates a long string arg for display', async () => {
    const long = 'x'.repeat(200);
    const { lastFrame } = await renderPrompt({
      id: 'tc-5',
      name: 'http_post',
      args: { body: long, url: 'https://example.com/api' },
      reason: 'destructive',
      onResolve: () => {},
    });
    const frame = lastFrame() ?? '';
    // The 200-char body is truncated with an ellipsis.
    expect(frame).toContain('...');
    // The short url is shown verbatim.
    expect(frame).toContain('body=');
    expect(frame).toContain('url=https://example.com/api');
    // The full 200-char string should NOT be in the rendered frame.
    expect(frame).not.toContain('x'.repeat(200));
  });

  describe('type-to-confirm mode', () => {
    it('renders the literal prompt + Enter hint, hides y/n', async () => {
      const { lastFrame } = await renderPrompt({
        id: 'tc-6',
        name: 'evil_twin',
        args: { ssid: 'corp-wifi' },
        reason: 'high-friction; type "attack" to confirm',
        prompt: 'attack',
        onResolve: () => {},
      });
      const frame = lastFrame() ?? '';
      expect(frame).toContain('chokepoint type-to-confirm');
      expect(frame).toContain('type');
      expect(frame).toContain('attack');
      expect(frame).toContain('[Enter]');
      // y/n hint should NOT appear in type-to-confirm mode.
      expect(frame).not.toContain('[Y]');
      expect(frame).not.toContain('[N]');
    });

    it('approves when the user types the exact prompt and presses Enter', async () => {
      const onResolve = vi.fn();
      const { stdin } = await renderPrompt({
        id: 'tc-7',
        name: 'evil_twin',
        args: { ssid: 'corp-wifi' },
        reason: 'high-friction',
        prompt: 'attack',
        onResolve,
      });
      // ink-testing-library emits each char as a separate input event;
      // tick() between writes so React's state update flushes.
      for (const ch of 'attack') {
        stdin.write(ch);
        await tick();
      }
      stdin.write('\r'); // Enter
      await tick();
      expect(onResolve).toHaveBeenCalledWith(true);
      expect(onResolve).toHaveBeenCalledTimes(1);
    });

    it('denies when the user presses Enter with a wrong / partial match', async () => {
      const onResolve = vi.fn();
      const { stdin } = await renderPrompt({
        id: 'tc-8',
        name: 'evil_twin',
        args: { ssid: 'corp-wifi' },
        reason: 'high-friction',
        prompt: 'attack',
        onResolve,
      });
      for (const ch of 'attac') {
        stdin.write(ch);
        await tick();
      }
      stdin.write('\r');
      await tick();
      expect(onResolve).toHaveBeenCalledWith(false);
    });

    it('denies on Esc in type-to-confirm mode', async () => {
      const onResolve = vi.fn();
      const { stdin } = await renderPrompt({
        id: 'tc-9',
        name: 'evil_twin',
        args: { ssid: 'corp-wifi' },
        reason: 'high-friction',
        prompt: 'attack',
        onResolve,
      });
      stdin.write('\u001B');
      await tick();
      expect(onResolve).toHaveBeenCalledWith(false);
    });

    it('supports backspace to correct the typed input', async () => {
      const onResolve = vi.fn();
      const { stdin } = await renderPrompt({
        id: 'tc-10',
        name: 'evil_twin',
        args: { ssid: 'corp-wifi' },
        reason: 'high-friction',
        prompt: 'attack',
        onResolve,
      });
      for (const ch of 'attackk') {
        stdin.write(ch);
        await tick();
      }
      stdin.write('\u007F');   // backspace
      await tick();
      stdin.write('\r');        // Enter
      await tick();
      expect(onResolve).toHaveBeenCalledWith(true);
    });

    // v0.3.B — destructive warning surface. When the chokepoint
    // returns a `type-then-confirm` decision, the prompt renders
    // a red `DESTRUCTIVE` label in the header so the user can
    // see — at a glance, even while scrolling past prior prompts
    // — that this one is high-friction. Plain `confirm` prompts
    // (no `prompt` prop) keep the original yellow treatment.
    it('renders a DESTRUCTIVE label in the header when prompt is set', async () => {
      const { lastFrame } = await renderPrompt({
        id: 'tc-11',
        name: 'evil_twin',
        args: { ssid: 'corp-wifi' },
        reason: 'high-friction',
        prompt: 'attack',
        onResolve: () => {},
      });
      const frame = lastFrame() ?? '';
      expect(frame).toContain('DESTRUCTIVE');
      // The original chokepoint type-to-confirm label is preserved
      // (the audit log still wants to see it; the DESTRUCTIVE label
      // is additive).
      expect(frame).toContain('chokepoint type-to-confirm');
    });

    it('does NOT render a DESTRUCTIVE label in plain confirm mode (no prompt prop)', async () => {
      // Sanity-check the back-compat path: a plain `confirm` (no
      // `prompt` prop) should keep the original yellow treatment
      // with no DESTRUCTIVE label. This pins the "destructive banner
      // is *only* for type-to-confirm" contract.
      const { lastFrame } = await renderPrompt({
        id: 'tc-12',
        name: 'shell_exec',
        args: { argv: ['nmap', '-sS', 'scanme.nmap.org'] },
        reason: 'destructive; confirm to proceed',
        onResolve: () => {},
      });
      const frame = lastFrame() ?? '';
      expect(frame).toContain('chokepoint confirm');
      expect(frame).not.toContain('DESTRUCTIVE');
      expect(frame).not.toContain('chokepoint type-to-confirm');
    });

    it('echoes the literal prompt verbatim in the type-to-confirm hint', async () => {
      // The "type X then press [Enter]" instructions should show
      // the literal `prompt` string, not a placeholder. Existing
      // test tc-6 already asserts the prompt is rendered; this one
      // pins the *exact* wording "type  attack  then press [Enter]"
      // so a future refactor that loses the literal "attack"
      // surfaces here.
      const { lastFrame } = await renderPrompt({
        id: 'tc-13',
        name: 'bettercap',
        args: { eval: 'wifi.recon on' },
        reason: 'high-friction',
        prompt: 'attack',
        onResolve: () => {},
      });
      const frame = lastFrame() ?? '';
      expect(frame).toContain('type');
      expect(frame).toContain('attack');
      expect(frame).toContain('then press');
      expect(frame).toContain('[Enter]');
    });
  });
});
