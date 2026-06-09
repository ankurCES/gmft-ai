import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import React from 'react';
import { App } from '../src/App.js';

describe('App (smoke)', () => {
  it('renders without crashing and shows the gmft-ai banner', () => {
    const { lastFrame } = render(React.createElement(App));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('gmft-ai');
  });

  it('shows the system welcome message on first render', () => {
    const { lastFrame } = render(React.createElement(App));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('TUI scaffold');
  });

  it('shows status rail with model=none when no provider is configured', () => {
    const { lastFrame } = render(React.createElement(App));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('model');
    expect(frame).toContain('none');
  });

  it('honors initialStatus override', () => {
    const { lastFrame } = render(
      React.createElement(App, {
        initialStatus: { provider: 'openai', model: 'gpt-4o-mini', sandbox: 'docker' },
      }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('openai');
    expect(frame).toContain('gpt-4o-mini');
  });
});
