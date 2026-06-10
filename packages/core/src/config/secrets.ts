import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
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
}

/**
 * Returns the best SecretStore available. If `keytar` fails to load
 * (native binding missing — typical on a CI box without libsecret), falls
 * back to `EnvFileStore` silently. Callers should record `store.backend`
 * in `config.toml` under `secrets.backend` so re-runs don't switch.
 *
 * TODO: when honoring `secrets.backend` from config, pass an explicit
 * preference through CreateOpts and re-throw on probe failure when the
 * user explicitly chose 'keytar'. Silent fallback hides locked-keychain
 * errors from users who opted in. (See 1.5a code review.)
 */
export async function createSecretStore(opts: CreateOpts): Promise<SecretStore> {
  const probe = new KeytarStore(opts.service);
  try {
    // Lazy import is the failure point on broken builds. Probing with a
    // known-missing key returns null cleanly when keytar is healthy.
    await probe.get('__gmft_probe__');
    return probe;
  } catch {
    return new EnvFileStore(opts.service);
  }
}
