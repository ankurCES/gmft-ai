import { describe, expect, it } from 'vitest';
import { TESTKIT_VERSION } from '../src/index.js';

describe('@gmft/testkit', () => {
  it('has a version', () => {
    expect(TESTKIT_VERSION).toMatch(/^0\.1\.0/);
  });
});
