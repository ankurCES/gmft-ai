import { render, type RenderOptions } from 'ink-testing-library';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { InputBox } from '../src/ui/components/InputBox.js';
import { makeTheme } from '../src/ui/theme.js';

const theme = makeTheme('dark');

/**
 * Yield to the event loop so React/Ink can flush re-renders triggered by
 * `stdin.write`. ink-testing-library's stdin is synchronous, but Ink's
 * useInput / useState updates land in a microtask.
 */
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Render the InputBox and wait one microtask before returning. The first
 * `stdin.write` after `render()` is dropped for escape sequences because
 * Ink's useInput subscription runs in a useEffect, which hasn't fired
 * yet at the time of a synchronous write. Awaiting here makes every
 * test safe by default and removes the footgun from individual tests.
 */
async function renderInputBox(props: Omit<React.ComponentProps<typeof InputBox>, 'theme'>) {
  const result = render(
    React.createElement(InputBox, { ...props, theme }) as ReactElement,
    {} as RenderOptions,
  );
  await tick();
  return result;
}

describe('InputBox', () => {
  it('renders the prompt', async () => {
    const { lastFrame } = await renderInputBox({
      onSubmit: () => {},
      history: [],
    });
    const frame = lastFrame() ?? '';
    expect(frame).toContain('▌');
  });

  it('calls onSubmit when Enter is pressed', async () => {
    const onSubmit = vi.fn();
    const { stdin } = await renderInputBox({ onSubmit, history: [] });
    stdin.write('hello world');
    await tick();
    stdin.write('\r');
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('hello world');
  });

  it('does not call onSubmit for whitespace-only input', async () => {
    const onSubmit = vi.fn();
    const { stdin } = await renderInputBox({ onSubmit, history: [] });
    stdin.write('   ');
    await tick();
    stdin.write('\r');
    await tick();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('recalls history with up arrow', async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = await renderInputBox({
      onSubmit,
      history: ['first', 'second'],
    });
    stdin.write('\u001B[A'); // up arrow -> 'second'
    await tick();
    expect(lastFrame() ?? '').toContain('second');

    stdin.write('\u001B[A'); // up arrow -> 'first'
    await tick();
    expect(lastFrame() ?? '').toContain('first');
  });

  it('does not call onSubmit when disabled', async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = await renderInputBox({
      onSubmit,
      history: [],
      disabled: true,
    });
    stdin.write('hello');
    await tick();
    stdin.write('\r');
    await tick();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(lastFrame() ?? '').toContain('running…');
  });
});
