import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gmft-sec-'));
  process.env.XDG_CONFIG_HOME = dir;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.XDG_CONFIG_HOME;
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('createSecretStore', () => {
  it('uses EnvFileStore when keytar import throws (native not built)', async () => {
    vi.resetModules();
    vi.doMock('keytar', () => {
      throw new Error('libsecret not found');
    });
    const { createSecretStore } = await import('../src/config/secrets.js');
    const store = await createSecretStore({ service: 'gmft-test' });
    expect(store.backend).toBe('envfile');
    await store.set('anthropic.apiKey', 'sk-test-123');
    expect(await store.get('anthropic.apiKey')).toBe('sk-test-123');
  });

  it('compositeKey preserves inner-key case (apiKey vs apikey do not collide)', async () => {
    vi.resetModules();
    vi.doMock('keytar', () => {
      throw new Error('libsecret not found');
    });
    const { createSecretStore } = await import('../src/config/secrets.js');
    const store = await createSecretStore({ service: 'gmft-case' });
    await store.set('apiKey', 'first');
    await store.set('apikey', 'second');
    expect(await store.get('apiKey')).toBe('first');
    expect(await store.get('apikey')).toBe('second');
  });

  it('round-trips secrets via EnvFileStore and locks file mode to 0600', async () => {
    vi.resetModules();
    vi.doMock('keytar', () => {
      throw new Error('libsecret not found');
    });
    const { createSecretStore, envPath } = await import('../src/config/secrets.js');
    const store = await createSecretStore({ service: 'gmft-test-mode' });
    expect(store.backend).toBe('envfile');
    await store.set('openai.apiKey', 'sk-openai-456');
    const v = await store.get('openai.apiKey');
    expect(v).toBe('sk-openai-456');
    const mode = statSync(envPath()).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
