import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export type SecretBackend = 'keytar' | 'envfile';

export interface SecretStore {
  readonly backend: SecretBackend;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export function secretsEnvDir(): string {
  return process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
}

export function envPath(): string {
  return join(secretsEnvDir(), 'gmft', 'secrets.env');
}

class EnvFileStore implements SecretStore {
  readonly backend: SecretBackend = 'envfile';
  constructor(private readonly service: string) {}

  private compositeKey(key: string): string {
    // Service prefix is uppercased + sanitized so it round-trips through
    // a POSIX env var. The inner key is preserved (dots -> underscores)
    // so case-sensitive provider fields don't collide: `apiKey` and
    // `apikey` are distinct. Callers must not pass keys whose only
    // difference is case — that's a real provider bug, not a gmft bug.
    return `${this.service.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_${key.replace(/\./g, '_')}`;
  }

  private readAll(): Record<string, string> {
    const p = envPath();
    if (!existsSync(p)) return {};
    const text = readFileSync(p, 'utf8');
    const out: Record<string, string> = {};
    for (const line of text.split('\n')) {
      // Env-var style: uppercase letters, digits, underscores. compositeKey
      // produces an uppercased service prefix and a case-preserved inner
      // key (dots -> underscores) so case-sensitive provider fields
      // (apiKey vs apikey) don't collide. Accept both shapes here.
      const m = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
      if (m) out[m[1]!] = m[2] ?? '';
    }
    return out;
  }

  private writeAll(map: Record<string, string>): void {
    const p = envPath();
    mkdirSync(join(secretsEnvDir(), 'gmft'), { recursive: true });
    const body = Object.entries(map)
      .map(([k, v]) => `${k}=${v.replace(/\n/g, '\\n')}`)
      .join('\n');
    // Open the file ourselves so we can fsync before chmod. A bare
    // writeFileSync + chmodSync can leave the file with the new
    // permissions but content from the previous version on disk after
    // a crash, because the kernel may reorder the page-cache flush
    // against the inode update. fsync forces the order. (Discovered
    // in 1.5a code review; fixed in 1.5h.)
    const fd = openSync(p, 'w');
    try {
      writeFileSync(fd, body + '\n');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
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

class KeytarStore implements SecretStore {
  readonly backend: SecretBackend = 'keytar';
  private mod: typeof import('keytar') | null = null;
  constructor(private readonly service: string) {}

  private async load(): Promise<typeof import('keytar')> {
    if (this.mod) return this.mod;
    this.mod = await import('keytar');
    return this.mod;
  }

  async get(key: string): Promise<string | null> {
    const k = await this.load();
    return k.getPassword(this.service, key);
  }
  async set(key: string, value: string): Promise<void> {
    const k = await this.load();
    await k.setPassword(this.service, key, value);
  }
  async delete(key: string): Promise<void> {
    const k = await this.load();
    await k.deletePassword(this.service, key);
  }
}

export interface CreateOpts {
  service: string;
  /**
   * If the user has explicitly chosen a backend (e.g. via
   * `secrets.backend` in `config.toml`), probe failure for `keytar`
   * re-throws so the error surfaces instead of being silently
   * downgraded to `envfile`. When unset (default), the factory
   * silently falls back — useful for first-run, CI, and developer
   * boxes where keytar's native binding is missing.
   */
  preferred?: SecretBackend;
}

/**
 * Returns the best SecretStore available. The probe order is:
 *
 *   1. If `opts.preferred === 'envfile'`, return EnvFileStore
 *      immediately (no probe).
 *   2. Otherwise, probe KeytarStore. If the probe succeeds, use it.
 *   3. If the probe throws AND `opts.preferred === 'keytar'`, re-throw
 *      — the user asked for keytar and we can't deliver.
 *   4. Otherwise, fall back to EnvFileStore silently.
 *
 * The pre-1.5h behaviour was case 4 only (always silent fallback),
 * which hid locked-keychain errors from users who explicitly opted
 * into keytar. (See 1.5a code review.)
 */
export async function createSecretStore(opts: CreateOpts): Promise<SecretStore> {
  if (opts.preferred === 'envfile') {
    return new EnvFileStore(opts.service);
  }
  const probe = new KeytarStore(opts.service);
  try {
    // Lazy import is the failure point on broken builds. Probing with a
    // known-missing key returns null cleanly when keytar is healthy.
    await probe.get('__gmft_probe__');
    return probe;
  } catch (err) {
    if (opts.preferred === 'keytar') {
      // User asked for keytar; don't silently downgrade. The caller
      // can decide to log, display, or fall back themselves.
      throw err;
    }
    return new EnvFileStore(opts.service);
  }
}
