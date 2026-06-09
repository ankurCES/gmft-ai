import { describe, expect, it } from 'vitest';
import { VERSION, version } from '../src/index.js';

describe('@gmft/core', () => {
  it('exports a version', () => {
    expect(VERSION).toMatch(/^0\.1\.0/);
    expect(version()).toBe(VERSION);
  });
});
