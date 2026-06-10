import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { PROVIDERS, getProvider } from '@gmft/core';

const tick = () => new Promise<void>((r) => setImmediate(r));

describe('onboard components', () => {
  it('ProviderPicker: ↓↓ Enter calls onPick with the second provider', async () => {
    const { ProviderPicker } = await import('../../src/onboard/components/ProviderPicker.js');
    let picked: string | null = null;
    const handle = render(
      React.createElement(ProviderPicker, {
        providers: PROVIDERS,
        onPick: (id: string) => { picked = id; },
        onAbort: () => {},
      }),
    );
    await tick();
    handle.stdin.write('\u001B[B'); // down -> openai
    await tick();
    handle.stdin.write('\u001B[B'); // down -> google
    await tick();
    handle.stdin.write('\r');
    await tick();
    expect(picked).toBe('google');
  });

  it('ProviderPicker: Esc calls onAbort', async () => {
    const { ProviderPicker } = await import('../../src/onboard/components/ProviderPicker.js');
    let aborted = false;
    const handle = render(
      React.createElement(ProviderPicker, {
        providers: PROVIDERS,
        onPick: () => {},
        onAbort: () => { aborted = true; },
      }),
    );
    await tick();
    handle.stdin.write('\u001B');
    await tick();
    expect(aborted).toBe(true);
  });

  it('ApiKeyPrompt: type + Enter calls onSubmit with the trimmed value', async () => {
    const { ApiKeyPrompt } = await import('../../src/onboard/components/ApiKeyPrompt.js');
    let submitted: string | null = null;
    const handle = render(
      React.createElement(ApiKeyPrompt, {
        field: { id: 'apiKey', label: 'API key' },
        onSubmit: (v: string) => { submitted = v; },
        onAbort: () => {},
      }),
    );
    await tick();
    handle.stdin.write('sk-test-1234');
    await tick();
    handle.stdin.write('\r');
    await tick();
    expect(submitted).toBe('sk-test-1234');
  });

  it('ApiKeyPrompt: empty Enter is ignored (no callback)', async () => {
    const { ApiKeyPrompt } = await import('../../src/onboard/components/ApiKeyPrompt.js');
    let calls = 0;
    const handle = render(
      React.createElement(ApiKeyPrompt, {
        field: { id: 'apiKey', label: 'API key' },
        onSubmit: () => { calls++; },
        onAbort: () => {},
      }),
    );
    await tick();
    handle.stdin.write('\r');
    await tick();
    expect(calls).toBe(0);
  });

  it('ApiKeyPrompt: Esc calls onAbort', async () => {
    const { ApiKeyPrompt } = await import('../../src/onboard/components/ApiKeyPrompt.js');
    let aborted = false;
    const handle = render(
      React.createElement(ApiKeyPrompt, {
        field: { id: 'apiKey', label: 'API key' },
        onSubmit: () => {},
        onAbort: () => { aborted = true; },
      }),
    );
    await tick();
    handle.stdin.write('\u001B');
    await tick();
    expect(aborted).toBe(true);
  });

  it('ModelSelector: ↓ Enter calls onPick with the second model', async () => {
    const { ModelSelector } = await import('../../src/onboard/components/ModelSelector.js');
    let picked: string | null = null;
    const provider = getProvider('anthropic')!;
    const handle = render(
      React.createElement(ModelSelector, {
        provider,
        models: provider.modelCatalog,
        onPick: (id: string) => { picked = id; },
        onAbort: () => {},
      }),
    );
    await tick();
    handle.stdin.write('\u001B[B'); // down
    await tick();
    handle.stdin.write('\r');
    await tick();
    expect(picked).toBe(provider.modelCatalog[1]!.id);
  });

  // ConfirmPrompt (real API): arrow keys toggle, Enter fires, Esc = decline.
  it('ConfirmPrompt: Enter on default (Yes) calls onConfirm', async () => {
    const { ConfirmPrompt } = await import('../../src/onboard/components/ConfirmPrompt.js');
    let confirmed = false;
    let declined = false;
    const handle = render(
      React.createElement(ConfirmPrompt, {
        message: ['sure?'],
        onConfirm: () => { confirmed = true; },
        onDecline: () => { declined = true; },
      }),
    );
    await tick();
    handle.stdin.write('\r'); // Enter on default Yes
    await tick();
    expect(confirmed).toBe(true);
    expect(declined).toBe(false);
  });

  it('ConfirmPrompt: → Enter calls onDecline', async () => {
    const { ConfirmPrompt } = await import('../../src/onboard/components/ConfirmPrompt.js');
    let confirmed = false;
    let declined = false;
    const handle = render(
      React.createElement(ConfirmPrompt, {
        message: ['sure?'],
        onConfirm: () => { confirmed = true; },
        onDecline: () => { declined = true; },
      }),
    );
    await tick();
    handle.stdin.write('\u001B[C'); // right arrow -> No
    await tick();
    handle.stdin.write('\r');
    await tick();
    expect(confirmed).toBe(false);
    expect(declined).toBe(true);
  });
});
