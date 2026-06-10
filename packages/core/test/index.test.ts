import { describe, expect, it } from 'vitest';
import * as Core from '../src/index.js';
import { VERSION, version } from '../src/index.js';

describe('@gmft/core', () => {
  it('exports a version', () => {
    expect(VERSION).toMatch(/^0\.1\.0/);
    expect(version()).toBe(VERSION);
  });

  it('re-exports the session-path helpers', () => {
    expect(typeof Core.sessionDir).toBe('function');
    expect(typeof Core.sessionPath).toBe('function');
    expect(typeof Core.currentSessionPath).toBe('function');
    expect(typeof Core.currentSessionIdPath).toBe('function');
  });
});
