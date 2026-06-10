import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { loadConfig, saveConfig, defaultConfig, configPath } from '../src/config/config.js';

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gmft-cfg-'));
  process.env.XDG_CONFIG_HOME = dir;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.XDG_CONFIG_HOME;
});

describe('config', () => {
  it('round-trips via toml', () => {
    const cfg = defaultConfig();
    cfg.llm.provider = 'anthropic';
    cfg.llm.model = 'claude-3-5-sonnet-latest';
    cfg.ui.theme = 'dark';
    saveConfig(cfg);
    const loaded = loadConfig();
    expect(loaded.llm.provider).toBe('anthropic');
    expect(loaded.llm.model).toBe('claude-3-5-sonnet-latest');
    expect(loaded.ui.theme).toBe('dark');
  });

  it('returns defaults when file is missing', () => {
    const cfg = loadConfig();
    expect(cfg.llm.provider).toBe('anthropic'); // defaultConfig default
    // configPath uses $XDG_CONFIG_HOME/gmft/config.toml
    expect(configPath()).toBe(join(dir, 'gmft', 'config.toml'));
  });

  it('falls back to $HOME/.config/gmft/config.toml when XDG_CONFIG_HOME is unset', () => {
    delete process.env.XDG_CONFIG_HOME;
    const fakeHome = mkdtempSync(join(tmpdir(), 'gmft-home-'));
    const origHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      expect(configPath()).toBe(join(fakeHome, '.config', 'gmft', 'config.toml'));
    } finally {
      process.env.HOME = origHome;
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it('preserves unknown top-level keys (forward compat)', () => {
    const p = configPath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, '[unknown]\nfoo = "bar"\n[llm]\nprovider = "openai"\nmodel = "gpt-4o"\n');
    const cfg = loadConfig();
    expect((cfg as unknown as { unknown?: { foo: string } }).unknown?.foo).toBe('bar');
    expect(cfg.llm.provider).toBe('openai');
  });
});
