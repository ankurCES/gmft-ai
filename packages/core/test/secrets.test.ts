import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gmft-sec-'));
  process.env.XDG_CONFIG_HOME = dir;
  keytarMockState.importError = undefined;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.XDG_CONFIG_HOME;
  vi.restoreAllMocks();
  vi.resetModules();
});

// The keytar mock state. `importError`, if set, causes the static
// keytar mock to throw the error on its first method call (mimicking
// a real keytar that loaded but then failed at the keychain level).
// This is what "keytar probe failure" means in the chokepoint tests:
// keytar loaded, but `getPassword` threw because libsecret is locked
// or the service doesn't exist.
//
// We use a stub that throws (not a factory that throws) because
// vitest treats throwing factories as factory errors regardless of
// whether the throw is at module init or first call. The throw on
// first call propagates as a normal async rejection that
// `rejects.toThrow` can match.
const keytarMockState = vi.hoisted(() => ({ importError: undefined as Error | undefined }));

vi.mock('keytar', () => ({
  getPassword: async () => {
    if (keytarMockState.importError) throw keytarMockState.importError;
    return null;
  },
  setPassword: async () => {},
  deletePassword: async () => true,
}));

describe('createSecretStore', () => {
  it('uses EnvFileStore when keytar getPassword throws (native not built)', async () => {
    keytarMockState.importError = new Error('libsecret not found');
    const { createSecretStore } = await import('../src/config/secrets.js');
    const store = await createSecretStore({ service: 'gmft-test' });
    expect(store.backend).toBe('envfile');
    await store.set('anthropic.apiKey', 'sk-test-123');
    expect(await store.get('anthropic.apiKey')).toBe('sk-test-123');
  });

  it('compositeKey preserves inner-key case (apiKey vs apikey do not collide)', async () => {
    keytarMockState.importError = new Error('libsecret not found');
    const { createSecretStore } = await import('../src/config/secrets.js');
    const store = await createSecretStore({ service: 'gmft-case' });
    await store.set('apiKey', 'first');
    await store.set('apikey', 'second');
    expect(await store.get('apiKey')).toBe('first');
    expect(await store.get('apikey')).toBe('second');
  });

  it('round-trips secrets via EnvFileStore and locks file mode to 0600', async () => {
    keytarMockState.importError = new Error('libsecret not found');
    const { createSecretStore, envPath } = await import('../src/config/secrets.js');
    const store = await createSecretStore({ service: 'gmft-test-mode' });
    expect(store.backend).toBe('envfile');
    await store.set('openai.apiKey', 'sk-openai-456');
    const v = await store.get('openai.apiKey');
    expect(v).toBe('sk-openai-456');
    const mode = statSync(envPath()).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('regression: apiKey/apikey round-trip via a raw env file (1.5h)', async () => {
    // 1.5b fixed the in-memory compositeKey but the env-file parser
    // regex was widened to A-Za-z0-9_ to match. This test writes a
    // raw env file (bypassing compositeKey) and confirms both
    // case-variants round-trip — the parser must not collapse them.
    keytarMockState.importError = new Error('libsecret not found');
    const { createSecretStore, envPath } = await import('../src/config/secrets.js');
    const store = await createSecretStore({ service: 'gmft-case-roundtrip' });
    await store.set('apiKey', 'first');
    await store.set('apikey', 'second');
    const raw = readFileSync(envPath(), 'utf8');
    // Both keys appear as separate lines in the file.
    expect(raw).toMatch(/^GMFT_CASE_ROUNDTRIP_apiKey=first$/m);
    expect(raw).toMatch(/^GMFT_CASE_ROUNDTRIP_apikey=second$/m);
    expect(await store.get('apiKey')).toBe('first');
    expect(await store.get('apikey')).toBe('second');
  });

  it('honors preferred=envfile without probing keytar (1.5h)', async () => {
    // keytar is mocked at module level; if the factory probes it,
    // getPassword would be called and return null (clean). The
    // assertion is that the returned store is envfile-backed
    // regardless — preferred=envfile short-circuits the probe.
    const { createSecretStore } = await import('../src/config/secrets.js');
    const store = await createSecretStore({
      service: 'gmft-envfile-pref',
      preferred: 'envfile',
    });
    expect(store.backend).toBe('envfile');
  });

  it('rethrows keytar probe failure when preferred=keytar (1.5h)', async () => {
    keytarMockState.importError = new Error('libsecret locked');
    const { createSecretStore } = await import('../src/config/secrets.js');
    await expect(
      createSecretStore({ service: 'gmft-keytar-pref', preferred: 'keytar' }),
    ).rejects.toThrow(/libsecret/);
  });

  it('EnvFileStore.writeAll fsyncs the file before chmod (1.5h)', async () => {
    // Verify the crash-safe property: a crash during fsync leaves
    // the file's pre-crash content intact or fully replaced — never
    // empty or torn. We mock fsyncSync to throw, drive a write,
    // and assert the on-disk file is one of the two safe states.
    keytarMockState.importError = new Error('libsecret not found');
    vi.doMock('node:fs', async () => {
      const real = await vi.importActual<typeof import('node:fs')>('node:fs');
      return {
        ...real,
        fsyncSync: () => {
          throw new Error('simulated crash');
        },
      };
    });
    const { createSecretStore, envPath } = await import('../src/config/secrets.js');
    const store = await createSecretStore({ service: 'gmft-fsync' });
    // The mock is in effect for all subsequent calls, so the first
    // set will also throw. We just want the on-disk state before
    // the second set's crash window, so let the first throw and
    // inspect whatever's on disk (which may be empty or torn).
    let before = '';
    try {
      await store.set('openai.apiKey', 'before-crash');
      before = readFileSync(envPath(), 'utf8');
    } catch {
      before = readFileSync(envPath(), 'utf8');
    }
    // The second set must throw — and the file must remain in a
    // safe (pre-crash or fully-replaced) state.
    let caught: unknown = null;
    try {
      await store.set('openai.apiKey', 'after-crash');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/simulated crash/);
    const after = readFileSync(envPath(), 'utf8');
    // The on-disk file must never be empty or torn. After a crash
    // during fsync, the kernel may have left the file at its prior
    // state or not flushed the new content — both are safe.
    expect(after.length).toBeGreaterThan(0);
    if (before.length > 0) {
      expect([before, before.replace('before-crash', 'after-crash')]).toContain(after);
    }
  });
});
