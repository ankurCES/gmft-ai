import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  sessionDir,
  sessionPath,
  currentSessionPath,
  currentSessionIdPath,
} from '../src/session/paths.js';

describe('session/paths', () => {
  // Use a per-test temp dir for XDG_CONFIG_HOME so we don't depend on
  // the host's real config.
  function withTmp(): string {
    return mkdtempSync(join(tmpdir(), 'gmft-paths-'));
  }

  it('sessionDir() honors XDG_CONFIG_HOME', () => {
    const tmp = withTmp();
    try {
      process.env.XDG_CONFIG_HOME = tmp;
      expect(sessionDir()).toBe(join(tmp, 'gmft', 'sessions'));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('sessionDir() falls back to $HOME/.config when XDG is unset', () => {
    const tmp = withTmp();
    const savedXdg = process.env.XDG_CONFIG_HOME;
    const savedHome = process.env.HOME;
    try {
      delete process.env.XDG_CONFIG_HOME;
      process.env.HOME = tmp;
      expect(sessionDir()).toBe(join(tmp, '.config', 'gmft', 'sessions'));
    } finally {
      if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = savedXdg;
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('sessionPath(id) joins correctly', () => {
    process.env.XDG_CONFIG_HOME = withTmp();
    try {
      expect(sessionPath('20260609-120000-abcd12')).toBe(
        join(sessionDir(), '20260609-120000-abcd12.jsonl'),
      );
    } finally {
      // tmp will be removed by the next test or by the test runner
    }
  });

  it('currentSessionPath() and currentSessionIdPath() are stable names', () => {
    process.env.XDG_CONFIG_HOME = withTmp();
    expect(currentSessionPath()).toBe(join(sessionDir(), 'current.jsonl'));
    expect(currentSessionIdPath()).toBe(join(sessionDir(), 'current-session-id'));
  });

  it('currentSessionIdPath() does not throw when the directory is missing', () => {
    // Pure path math — never touches the fs. If this throws, the
    // implementation regressed into a side-effectful function.
    process.env.XDG_CONFIG_HOME = withTmp();
    expect(() => currentSessionIdPath()).not.toThrow();
    // Re-confirm the function is pure: calling it twice returns the same string.
    expect(currentSessionIdPath()).toBe(currentSessionIdPath());
  });

  // The next test in the suite is allowed to leak a tmp dir; the harness
  // cleans up via rmSync in the test bodies. We keep this contract-test
  // explicit so a future refactor doesn't accidentally start mkdir-ing.
  it('does NOT create the directory as a side effect', () => {
    const tmp = withTmp();
    process.env.XDG_CONFIG_HOME = tmp;
    sessionDir();
    sessionPath('whatever');
    currentSessionPath();
    currentSessionIdPath();
    // The directory should not exist; the consumer is responsible for mkdir.
    const { existsSync } = require('node:fs') as typeof import('node:fs');
    expect(existsSync(join(tmp, 'gmft', 'sessions'))).toBe(false);
    // sanity: write a sentinel file and ensure the path function didn't touch it
    writeFileSync(join(tmp, 'sentinel'), 'ok');
    expect(existsSync(join(tmp, 'sentinel'))).toBe(true);
    rmSync(tmp, { recursive: true, force: true });
  });
});
