import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  existsSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
} from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

// We re-mock `@gmft/core` to:
//   1. Pin `createSecretStore` to the envfile backend (the real factory
//      probes keytar first; on machines where keytar loads (incl. this
//      dev box) the round-trip would land in the OS keychain instead of
//      `$XDG_CONFIG_HOME/gmft/secrets.env`, and the test's file-exists
//      assertion would fail. The spec's "re-mock below" comment hints at
//      this re-mock but is missing from the verbatim body.)
//   2. Control `getProvider` in validateProvider tests.
//
// EnvFileStore is not exported from @gmft/core, so we re-implement the
// same on-disk layout (compositeKey + chmod 0600) inline.
let mockGetProviderReturn: unknown = undefined;

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
      .map(([k, v]) => `${k}=${v.replace(/\n/g, '\\n')}`)
      .join('\n');
    writeFileSync(p, body + '\n');
    chmodSync(p, 0o600);
  }
  async get(key: string): Promise<string | null> {
    return this.readAll()[this.compositeKey(key)] ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    const all = this.readAll();
    all[this.compositeKey(key)] = value;
    this.writeAll(all);
  }
  async delete(key: string): Promise<void> {
    const all = this.readAll();
    delete all[this.compositeKey(key)];
    this.writeAll(all);
  }
}

vi.mock('@gmft/core', async (importOriginal) => {
  const real = await importOriginal<typeof import('@gmft/core')>();
  return {
    ...real,
    createSecretStore: (opts: { service: string }) =>
      Promise.resolve(new TestEnvFileStore(opts.service)),
    getProvider: (id: string) =>
      mockGetProviderReturn === undefined
        ? real.getProvider(id)
        : (mockGetProviderReturn as ReturnType<typeof real.getProvider>),
  };
});

import { createOnboardRuntime } from '../../src/onboard/runtime.js';

let tmp: string;
const realConfig = process.env.XDG_CONFIG_HOME;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gmft-runtime-'));
  process.env.XDG_CONFIG_HOME = tmp;
  mockGetProviderReturn = undefined;
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  if (realConfig === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = realConfig;
  vi.restoreAllMocks();
});

describe('createOnboardRuntime', () => {
  it('exposes the 5 real providers in PROVIDERS order', async () => {
    const { PROVIDERS } = await import('@gmft/core');
    const rt = createOnboardRuntime();
    expect(rt.providers.map((p) => p.id)).toEqual([
      'anthropic', 'openai', 'google', 'openrouter', 'ollama',
    ]);
    expect(PROVIDERS).toBe(rt.providers); // same frozen tuple, not a copy
  });

  it('setSecret writes through the envfile store and getSecret reads it back', async () => {
    const rt = createOnboardRuntime();
    await rt.setSecret('anthropic.apiKey', 'sk-test-1234');
    expect(await rt.getSecret('anthropic.apiKey')).toBe('sk-test-1234');
    // File exists, contains the secret
    const envFile = join(tmp, 'gmft', 'secrets.env');
    expect(existsSync(envFile)).toBe(true);
    const text = readFileSync(envFile, 'utf8');
    expect(text).toContain('sk-test-1234');
  });

  it('validateProvider delegates to the provider module and returns ok:true on 200', async () => {
    mockGetProviderReturn = {
      id: 'anthropic',
      displayName: 'Anthropic',
      authFields: [{ id: 'apiKey', label: 'API key' }],
      modelCatalog: [],
      async validate() { return { ok: true } as const; },
    };
    const rt = createOnboardRuntime();
    const v = await rt.validateProvider('anthropic', 'sk-test', 'https://api.example');
    expect(v).toEqual({ ok: true });
  });

  it('validateProvider returns invalid_key when the provider module says so', async () => {
    mockGetProviderReturn = {
      id: 'anthropic',
      displayName: 'Anthropic',
      authFields: [{ id: 'apiKey', label: 'API key' }],
      modelCatalog: [],
      async validate() { return { ok: false, reason: 'invalid_key' as const }; },
    };
    const rt = createOnboardRuntime();
    const v = await rt.validateProvider('anthropic', 'sk-bad');
    expect(v).toEqual({ ok: false, reason: 'invalid_key' });
  });

  it('validateProvider returns { ok:false, reason: unknown } if the provider id is bogus', async () => {
    // mockGetProviderReturn stays undefined → mocked getProvider returns undefined
    const rt = createOnboardRuntime();
    const v = await rt.validateProvider('nope', 'sk-test');
    expect(v).toEqual({ ok: false, reason: 'unknown' });
  });
});
