#!/usr/bin/env node
/**
 * gmft — terminal-first agentic pentest runtime.
 *
 * Phase 1 entry: render the TUI scaffold. No LLM, no tools, no onboarding yet.
 */
import meow from 'meow';
import React from 'react';
import { render } from 'ink';
import { App } from './App.js';

const cli = meow(
  `
  Usage
    $ gmft [options]

  Options
    --reconfigure       Re-run onboarding (lands in phase 1.5f)
    --theme <name>      auto | dark | light | high-contrast
    --model <id>        Model id (lands in phase 2)
    --provider <id>     Provider id (lands in phase 2)
    --target <host>     Session target (lands in phase 6)
    --help              Show this help
    --version           Show version

  Examples
    $ gmft
    $ gmft --theme dark
`,
  {
    importMeta: import.meta,
    flags: {
      reconfigure: { type: 'boolean', default: false },
      theme: { type: 'string', default: 'auto' },
      model: { type: 'string' },
      provider: { type: 'string' },
      target: { type: 'string' },
    },
  },
);

const themeName = (cli.flags.theme ?? 'auto') as 'auto' | 'dark' | 'light' | 'high-contrast';

const initialStatus = {
  model: cli.flags.model ?? 'none',
  provider: cli.flags.provider ?? 'none',
  ...(cli.flags.target ? { target: cli.flags.target } : {}),
};

const { waitUntilExit } = render(
  React.createElement(App, { themeName, initialStatus }),
);

await waitUntilExit();
