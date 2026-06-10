import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, chmodSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { createOnboardRuntime } from '../src/onboard/runtime.js';
import {
  registerConfigField,
  getConfigFields,
  _clearConfigFields,
  createLlmProviderField,
  runOnboarding,
  type GmftConfig,
  type ProviderModule,
  type AuthField,
  type ModelInfo,
  PROVIDERS,
  getProvider,
} from '@gmft/core';

// Re-mock @gmft/core to:
//   1. Pin createSecretStore to the envfile backend (the real factory
//      probes keytar first; on dev boxes where keytar loads, the
//      round-trip would land in the OS keychain instead of the tmp
//      $XDG_CONFIG_HOME/gmft/secrets.env and the test's file-exists
//      assertion would fail).
//   2. Override getProvider('anthropic') to return a fake ProviderModule
//      whose validate() always returns {ok: true} so the field's
//      validateProvider step doesn't bail.

class TestEnvFileStore {
  readonly backend = 'envfile' as const;
  constructor(private readonly service: string) {}
  private compositeKey(key: string): string {
    return `${this.service.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_${key.replace(/\./g, '_')}`;
  }
  private filePath(): string {
    const dir = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
    return join(dir, 'gmft', 'secrets.env');
  }
  private readAll(): Record<string, string> {
    const p = this.filePath();
    if (!existsSync(p)) return {};
    const out: Record<string, string> = {};
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
      if (m) out[m[1]!] = m[2] ?? '';
    }
    return out;
  }
  private writeAll(map: Record<string, string>): void {
    const p = this.filePath();
    const dir = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
    mkdirSync(join(dir, 'gmft'), { recursive: true });
    const body = Object.entries(map)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    writeFileSync(p, body, { mode: 0o600 });
  }
  async get(key: string): Promise<string | null> {
    return this.readAll()[this.compositeKey(key)] ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    const m = this.readAll();
    m[this.compositeKey(key)] = value;
    this.writeAll(m);
  }
  async delete(key: string): Promise<boolean> {
    const m = this.readAll();
    const k = this.compositeKey(key);
    if (!(k in m)) return false;
    delete m[k];
    this.writeAll(m);
    return true;
  }
}

const ANTHROPIC_FAKE_AUTH_FIELDS: readonly AuthField[] = Object.freeze([
  { id: 'apiKey', label: 'API key' },
]);

const ANTHROPIC_FAKE_MODEL_CATALOG: readonly ModelInfo[] = Object.freeze([
  { id: 'claude-3-5-sonnet-latest', displayName: 'Claude 3.5 Sonnet', isDefault: true },
]);

const ANTHROPIC_FAKE_PROVIDER: ProviderModule = {
  id: 'anthropic',
  displayName: 'Anthropic (fake)',
  authFields: ANTHROPIC_FAKE_AUTH_FIELDS,
  modelCatalog: ANTHROPIC_FAKE_MODEL_CATALOG,
  validate: async () => ({ ok: true, modelHints: [] }),
};

vi.mock('@gmft/core', async (importOriginal) => {
  const real = await importOriginal<typeof import('@gmft/core')>();
  return {
    ...real,
    createSecretStore: (opts: { service: string }) =>
      Promise.resolve(new TestEnvFileStore(opts.service)),
    getProvider: (id: string) =>
      id === 'anthropic' ? ANTHROPIC_FAKE_PROVIDER : real.getProvider(id),
  };
});

const tick = () => new Promise<void>((r) => setImmediate(r));

let tmp: string;
const realConfig = process.env.XDG_CONFIG_HOME;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gmft-cli-onboard-'));
  process.env.XDG_CONFIG_HOME = tmp;
  _clearConfigFields();
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  if (realConfig === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = realConfig;
});

/**
 * Fake UI that returns canned values for the LLM-provider field's
 * three steps. Records every call to verify the driver actually
 * invoked each step.
 */
function fakeUI() {
  const calls: string[] = [];
  let i = 0;
  return {
    calls,
    ui: {
      pickProvider: async (ps: readonly ProviderModule[]) => {
        calls.push(`pickProvider:${ps.length}`);
        return 'anthropic';
      },
      enterKey: async (f: AuthField) => {
        calls.push(`enterKey:${f.id}`);
        i++;
        return `sk-fake-${i}`;
      },
      pickModel: async () => {
        calls.push('pickModel');
        return 'claude-3-5-sonnet-latest';
      },
      confirmAction: async () => true,
    },
  };
}

describe('cli onboarding integration', () => {
  it('first launch: runOnboarding prompts, saves config.toml + secrets.env', async () => {
    const { ui, calls } = fakeUI();
    registerConfigField(createLlmProviderField(ui));

    const result = await runOnboarding({
      fields: getConfigFields(),
      runtimeFactory: () => createOnboardRuntime(),
      save: async (cfg: GmftConfig) => {
        const { saveConfig } = await import('@gmft/core');
        saveConfig(cfg);
      },
      force: false,
    });

    expect(result).not.toBeNull();
    expect(result?.llm.provider).toBe('anthropic');
    expect(result?.llm.model).toBe('claude-3-5-sonnet-latest');

    // The field prompted all three steps.
    expect(calls.some((c) => c.startsWith('pickProvider'))).toBe(true);
    expect(calls.some((c) => c.startsWith('enterKey'))).toBe(true);
    expect(calls.some((c) => c === 'pickModel')).toBe(true);

    // Secrets were written to the tmp envfile store.
    const envFile = join(tmp, 'gmft', 'secrets.env');
    expect(existsSync(envFile)).toBe(true);
    expect(readFileSync(envFile, 'utf8')).toContain('sk-fake-1');

    // Config was saved to the tmp config.toml.
    const cfgFile = join(tmp, 'gmft', 'config.toml');
    expect(existsSync(cfgFile)).toBe(true);
    const toml = readFileSync(cfgFile, 'utf8');
    expect(toml).toContain('anthropic');
    expect(toml).toContain('claude-3-5-sonnet-latest');
  });

  it('first launch: non-forced runOnboarding prompts all unconfigured fields', async () => {
    const { ui, calls } = fakeUI();
    registerConfigField(createLlmProviderField(ui));

    const result = await runOnboarding({
      fields: getConfigFields(),
      runtimeFactory: () => createOnboardRuntime(),
      save: async () => {},
      force: false,
    });

    // Empty starting config: isConfigured() is false → field IS prompted.
    expect(calls.some((c) => c.startsWith('pickProvider'))).toBe(true);
    expect(calls.some((c) => c.startsWith('enterKey'))).toBe(true);
    expect(calls.some((c) => c === 'pickModel')).toBe(true);
    expect(result).not.toBeNull();
  });

  it('--reconfigure: force:true re-prompts even with a saved config', async () => {
    const { ui, calls } = fakeUI();
    registerConfigField(createLlmProviderField(ui));

    const result = await runOnboarding({
      fields: getConfigFields(),
      runtimeFactory: () => createOnboardRuntime(),
      save: async () => {},
      force: true,
    });

    // force:true means even a configured field gets re-prompted.
    expect(calls.some((c) => c.startsWith('pickProvider'))).toBe(true);
    expect(calls.some((c) => c === 'pickModel')).toBe(true);
    expect(result).not.toBeNull();
  });
});
