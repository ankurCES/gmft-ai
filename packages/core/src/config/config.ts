import { parse, stringify } from 'smol-toml';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface LlmConfig {
  provider: 'anthropic' | 'openai' | 'google' | 'openrouter' | 'ollama';
  model: string;
  endpoint?: string;
}

export interface SandboxConfig {
  mode: 'docker' | 'host';
  defaultImage?: string;
}

export interface ChokepointConfig {
  allowPrivateNetworks: boolean;
  denylist: string[];
}

export interface UiConfig {
  theme: 'auto' | 'dark' | 'light' | 'high-contrast';
}

export interface SecretsMeta {
  backend: 'keytar' | 'envfile';
}

export interface GmftConfig {
  llm: LlmConfig;
  sandbox: SandboxConfig;
  chokepoint: ChokepointConfig;
  ui: UiConfig;
  secrets: SecretsMeta;
  /** Forward-compat: preserve unknown top-level keys on read. */
  [k: string]: unknown;
}

export function defaultConfig(): GmftConfig {
  return {
    llm: { provider: 'anthropic', model: 'claude-3-5-haiku-latest' },
    sandbox: { mode: 'host' },
    chokepoint: { allowPrivateNetworks: false, denylist: [] },
    ui: { theme: 'auto' },
    secrets: { backend: 'envfile' },
  };
}

export function configDir(): string {
  return process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
}

export function configPath(): string {
  return join(configDir(), 'gmft', 'config.toml');
}

export function loadConfig(): GmftConfig {
  const p = configPath();
  if (!existsSync(p)) return defaultConfig();
  const text = readFileSync(p, 'utf8');
  const raw = parse(text) as Record<string, unknown>;
  return { ...defaultConfig(), ...raw } as GmftConfig;
}

export function saveConfig(cfg: GmftConfig): void {
  const p = configPath();
  mkdirSync(join(configDir(), 'gmft'), { recursive: true });
  writeFileSync(p, stringify(cfg as Record<string, unknown>));
}
