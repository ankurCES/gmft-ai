#!/usr/bin/env node
/**
 * gmft — terminal-first agentic pentest runtime.
 *
 * Phase 1.5d entry: runs onboarding, then mounts the TUI via `AgentApp`,
 * which wires the real LLM `onSubmit` to `App`. The LLM call is a
 * single `streamText` round-trip (no tools yet — chokepoint lands in
 * phase 3). API keys live in the SecretStore; we look them up after
 * onboarding, before the render.
 */
import meow from 'meow';
import { hostname, userInfo } from 'node:os';
import React from 'react';
import { render } from 'ink';
import {
  loadConfig,
  saveConfig,
  getConfigFields,
  registerConfigField,
  createLlmProviderField,
  runOnboarding,
  createSecretStore,
  bindGetApiKey,
  type GmftConfig,
} from '@gmft/core';
import { AgentApp } from './AgentApp.js';
import { createOnboardRuntime } from './onboard/runtime.js';
import { bindProviderUI } from './onboard/bind-provider-ui.js';
import { SessionStore } from './session/store.js';
import { parseSandboxFlag } from './sandbox-flag.js';

const cli = meow(
  `
  Usage
    $ gmft [options]

  Options
    --reconfigure       Re-run onboarding (re-prompts all fields)
    --theme <name>      auto | dark | light | high-contrast
    --target <host>     Session target. Pins the whole session to a single host —
                        the chokepoint denies any targetRequired tool call whose
                        args.target doesn't match. Format: a single host label
                        (e.g. "scanme.nmap.org"); one per session.
    --sandbox <mode>    Runner mode for this invocation. v0.2.D.
                        auto   — pick the best available (default)
                        docker — require Docker; refuse to fall back
                        host   — force the host runner (bypasses Docker/landlock
                                 unless GMFT_ALLOW_UNSANDBOXED_DESTRUCTIVE=true
                                 for destructive/elevated tools)
    --resume <id>       Resume a specific session id (skips the current-session pointer)
    --supervisor-model <id>  Model id for the supervisor's end-of-turn postmortem.
                        Default: same as the primary agent model. Useful with
                        cheaper/local models (e.g. claude-haiku-4-5, ollama)
                        since the postmortem is a fixed-prompt 4-section task.
    --help              Show this help
    --version           Show version

  Examples
    $ gmft
    $ gmft --reconfigure
    $ gmft --theme dark
    $ gmft --sandbox docker
    $ gmft --resume 20260611-094512-abcdef
    $ gmft --supervisor-model claude-haiku-4-5
`,
  {
    importMeta: import.meta,
    flags: {
      reconfigure: { type: 'boolean', default: false },
      theme: { type: 'string', default: 'auto' },
      target: { type: 'string' },
      resume: { type: 'string' },
      sandbox: { type: 'string', default: 'auto' },
      supervisorModel: { type: 'string' },
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

// v0.2.D — apply the --sandbox CLI flag. Validated above;
// parseSandboxFlag throws on invalid values.
try {
  const sandboxFlag = parseSandboxFlag(cli.flags.sandbox);
  if (sandboxFlag !== 'auto') {
    // Persist on the config so the rest of the runtime (incl.
    // `sandboxMode: config.sandbox.mode` below) can read it. The
    // existing `mode` field is the runtime's source of truth; we
    // also keep `runner` so the chokepoint can distinguish "user
    // explicitly forced" from "config default".
    config.sandbox = {
      ...config.sandbox,
      mode: sandboxFlag,
      runner: sandboxFlag,
    };
  } else {
    // 'auto' — keep the existing mode + record the intent.
    config.sandbox = {
      ...config.sandbox,
      runner: 'auto',
    };
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

const initialStatus = {
  model: config.llm.model,
  provider: config.llm.provider,
  ...(cli.flags.target ? { target: cli.flags.target } : {}),
};

// Set up the session store. By default we resume the previous
// session (the `current-session-id` pointer). The `--resume <id>`
// flag overrides that and pins the TUI to a specific historical
// session; we also update the pointer so subsequent runs land on
// the resumed session. If the explicit id has no log on disk, we
// fall back to whatever the pointer resolves to and warn.
const session = new SessionStore();
let initialMessages: import('./ui/components/Message.js').Message[] = [];
try {
  let id: string | null = null;
  if (cli.flags.resume) {
    const requested = cli.flags.resume;
    // Try the requested id first; if the log is missing, we still
    // want to honor the user's choice but warn — better to surface
    // the gap than silently load a different session.
    const turns = await session.load(requested);
    if (turns.length === 0) {
      console.error(
        `--resume: no log found for session "${requested}". ` +
        `Falling back to the current-session pointer.`,
      );
      id = await session.currentId();
    } else {
      // Update the pointer so future `gmft` (no flag) starts here.
      await session.setCurrent(requested);
      id = requested;
    }
  } else {
    id = await session.currentId();
  }
  if (id) {
    const turns = await session.load(id);
    initialMessages = turns.map((t, i) => ({
      id: `m-${t.id ?? i + 1}`,
      role: t.role,
      content: t.content,
      ts: t.ts ?? Date.now(),
    }));
  }
} catch (err) {
  // Resume failures are non-fatal — the TUI will start with an empty
  // chat and `/session list` will show what was found.
  console.error(
    'Session resume failed:',
    err instanceof Error ? err.message : String(err),
  );
}

// Look up the API key for the configured provider. Openrouter/ollama
// do not require a key (the secret may be unset for them; ollama passes
// the literal 'ollama' through the factory). Phase 1.5f also binds a
// `getApiKey` closure on the same store so AgentApp can re-resolve
// the key on `/provider` switches without re-creating the store.
let apiKey = '';
let getApiKey: (provider: string) => Promise<string> = async () => '';
try {
  // 1.5h: honor the user's chosen secrets.backend from config.toml.
  // When the user explicitly chose 'keytar', probe failures are
  // surfaced as a chat-visible error rather than a silent downgrade
  // to envfile. The try/catch below preserves the prior behaviour of
  // "non-fatal at boot, error visible at first LLM turn" because
  // bindGetApiKey() swallows store.get errors itself.
  const store = await createSecretStore({
    service: 'gmft',
    preferred: config.secrets?.backend,
  });
  apiKey = (await store.get(`${config.llm.provider}.apiKey`)) ?? '';
  getApiKey = bindGetApiKey(store);
} catch (err) {
  // Keytar probe failures are non-fatal — the TUI will show the LLM
  // error when the first turn is submitted.
  console.error(
    'Secret store unavailable:',
    err instanceof Error ? err.message : String(err),
  );
}

let username = 'unknown';
try {
  username = userInfo().username || 'unknown';
} catch {
  /* sandbox env without uid */
}
let host = 'unknown';
try {
  host = hostname() || 'unknown';
} catch {
  /* same */
}

const { waitUntilExit } = render(
  React.createElement(AgentApp, {
    themeName,
    initialStatus,
    initialConfig: { provider: config.llm.provider, model: config.llm.model },
    model: {
      provider: config.llm.provider,
      model: config.llm.model,
      apiKey,
      ...(config.llm.endpoint ? { endpoint: config.llm.endpoint } : {}),
    },
    getApiKey,
    ...(config.llm.endpoint ? { endpoint: config.llm.endpoint } : {}),
    env: {
      hostname: host,
      os: process.platform,
      sandboxMode: config.sandbox.mode,
      provider: config.llm.provider,
      model: config.llm.model,
      username,
    },
    session,
    ...(initialMessages.length > 0 ? { initialMessages } : {}),
    ...(cli.flags.supervisorModel
      ? { supervisorModelId: cli.flags.supervisorModel }
      : {}),
    onTurnComplete: ({ user, assistant }) => {
      // Persist both halves of the turn. The store is async but the
      // TUI's onTurnComplete is fire-and-forget here — we log on
      // failure but don't block the render loop.
      session
        .append(user)
        .then(() => session.append(assistant))
        .catch((err: unknown) => {
          console.error(
            'Session append failed:',
            err instanceof Error ? err.message : String(err),
          );
        });
    },
  }),
);

await waitUntilExit();
