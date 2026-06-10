#!/usr/bin/env node
/**
 * gmft — terminal-first agentic pentest runtime.
 *
 * Phase 1.5c entry: run onboarding if config is missing (or
 * `--reconfigure` is set), then mount the TUI with the resolved
 * `provider:model` in the status rail.
 */
import meow from 'meow';
import React from 'react';
import { render } from 'ink';
import {
  loadConfig,
  saveConfig,
  getConfigFields,
  registerConfigField,
  createLlmProviderField,
  runOnboarding,
  type GmftConfig,
} from '@gmft/core';
import { App } from './App.js';
import { createOnboardRuntime } from './onboard/runtime.js';
import { bindProviderUI } from './onboard/bind-provider-ui.js';

const cli = meow(
  `
  Usage
    $ gmft [options]

  Options
    --reconfigure       Re-run onboarding (re-prompts all fields)
    --theme <name>      auto | dark | light | high-contrast
    --target <host>     Session target (lands in phase 6)
    --help              Show this help
    --version           Show version

  Examples
    $ gmft
    $ gmft --reconfigure
    $ gmft --theme dark
`,
  {
    importMeta: import.meta,
    flags: {
      reconfigure: { type: 'boolean', default: false },
      theme: { type: 'string', default: 'auto' },
      target: { type: 'string' },
    },
  },
);

const themeName = (cli.flags.theme ?? 'auto') as 'auto' | 'dark' | 'light' | 'high-contrast';

// Register the LLM-provider field with the real Ink UI. Other phases
// (e.g. Phase 2 tools registry) add their own `registerConfigField(...)`
// calls here. Order is determined by each field's `order` property, not
// by the registration order.
registerConfigField(createLlmProviderField(bindProviderUI()));

let config: GmftConfig;
try {
  if (cli.flags.reconfigure) {
    // force: true prompts every field regardless of isConfigured().
    const result = await runOnboarding({
      fields: getConfigFields(),
      runtimeFactory: () => createOnboardRuntime(),
      // saveConfig is sync (returns void); wrap to satisfy the async
      // RunOnboardingOpts.save: (cfg) => Promise<void> contract.
      save: async (cfg) => {
        saveConfig(cfg);
      },
      force: true,
    });
    if (!result) {
      console.error('Onboarding aborted; exiting.');
      process.exit(1);
    }
    config = result;
  } else {
    // Try the existing config first.
    const existing = loadConfig();
    if (existing.llm?.provider && existing.llm?.model) {
      config = existing;
    } else {
      // First launch — run onboarding non-forced. isConfigured() returns
      // false on the empty starting config, so we'll be prompted.
      const result = await runOnboarding({
        fields: getConfigFields(),
        runtimeFactory: () => createOnboardRuntime(),
        // see reconfigure branch above for the sync→async wrapper
        save: async (cfg) => {
          saveConfig(cfg);
        },
        force: false,
      });
      if (!result) {
        console.error('Onboarding aborted; exiting.');
        process.exit(1);
      }
      config = result;
    }
  }
} catch (err) {
  console.error('Onboarding failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
}

const initialStatus = {
  model: config.llm.model,
  provider: config.llm.provider,
  ...(cli.flags.target ? { target: cli.flags.target } : {}),
};

const { waitUntilExit } = render(
  React.createElement(App, {
    themeName,
    initialStatus,
    initialConfig: { provider: config.llm.provider, model: config.llm.model },
  }),
);

await waitUntilExit();
