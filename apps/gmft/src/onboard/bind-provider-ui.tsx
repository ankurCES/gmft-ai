import React from 'react';
import { render } from 'ink-testing-library';
import type {
  ProviderUI,
  AuthField,
  ModelInfo,
  ProviderModule,
} from '@gmft/core';

import { ProviderPicker } from './components/ProviderPicker.js';
import { ApiKeyPrompt } from './components/ApiKeyPrompt.js';
import { ModelSelector } from './components/ModelSelector.js';
import { ConfirmPrompt } from './components/ConfirmPrompt.js';

/** A `render()` result — `ink-testing-library` declares `Instance`
 *  locally and does not export it, so we infer the type. */
type InkInstance = ReturnType<typeof render>;

/**
 * A `ProviderUI` backed by a fresh Ink instance per call. Each method:
 *   1. Renders the appropriate component
 *   2. Waits for the user to dismiss it (Enter, ←/→+Enter, or Esc)
 *   3. Unmounts the instance
 *   4. Resolves the promise with the result (or `null` on abort)
 *
 * Why a fresh Ink instance per call: the on-screen prompt needs full
 * keyboard focus and a clean tree, and Ink's input model doesn't
 * gracefully support swapping one focused component for another
 * inside an existing tree. The cost is one extra render per
 * interaction (cheap; sub-millisecond) and one extra `setImmediate`
 * cycle in tests.
 */
export function bindProviderUI(): ProviderUI {
  return {
    pickProvider(providers: readonly ProviderModule[]): Promise<string | null> {
      return new Promise<string | null>((resolve) => {
        let inst: InkInstance | null = null;
        const tree = (
          <ProviderPicker
            providers={providers}
            onPick={(id) => { inst?.unmount(); resolve(id); }}
            onAbort={() => { inst?.unmount(); resolve(null); }}
          />
        );
        inst = render(tree);
      });
    },

    enterKey(field: AuthField): Promise<string | null> {
      return new Promise<string | null>((resolve) => {
        let inst: InkInstance | null = null;
        const tree = (
          <ApiKeyPrompt
            field={field}
            onSubmit={(v) => { inst?.unmount(); resolve(v); }}
            onAbort={() => { inst?.unmount(); resolve(null); }}
          />
        );
        inst = render(tree);
      });
    },

    pickModel(
      provider: ProviderModule,
      models: readonly ModelInfo[],
    ): Promise<string | null> {
      return new Promise<string | null>((resolve) => {
        let inst: InkInstance | null = null;
        const tree = (
          <ModelSelector
            provider={provider}
            models={models}
            onPick={(id) => { inst?.unmount(); resolve(id); }}
            onAbort={() => { inst?.unmount(); resolve(null); }}
          />
        );
        inst = render(tree);
      });
    },

    confirmAction(message: string): Promise<boolean> {
      return new Promise<boolean>((resolve) => {
        let inst: InkInstance | null = null;
        const tree = (
          <ConfirmPrompt
            message={message.split('\n')}
            onConfirm={() => { inst?.unmount(); resolve(true); }}
            onDecline={() => { inst?.unmount(); resolve(false); }}
          />
        );
        inst = render(tree);
      });
    },
  };
}
