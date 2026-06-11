/**
 * v0.2.D — tests for the `--sandbox` CLI flag parser.
 *
 * The parser lives in `sandbox-flag.ts` so it can be unit-tested
 * without booting the whole Ink runtime. The CLI wires the flag
 * into `config.sandbox` after `loadConfig`; this file tests the
 * parser directly.
 */

import { describe, it, expect } from 'vitest';
import { parseSandboxFlag, type SandboxFlag } from '../src/sandbox-flag.js';

describe('parseSandboxFlag', () => {
  it('defaults to "auto" when the flag is undefined', () => {
    expect(parseSandboxFlag(undefined)).toBe<SandboxFlag>('auto');
  });

  it('parses "auto"', () => {
    expect(parseSandboxFlag('auto')).toBe<SandboxFlag>('auto');
  });

  it('parses "docker"', () => {
    expect(parseSandboxFlag('docker')).toBe<SandboxFlag>('docker');
  });

  it('parses "host"', () => {
    expect(parseSandboxFlag('host')).toBe<SandboxFlag>('host');
  });

  it('rejects an invalid value with a clear error', () => {
    expect(() => parseSandboxFlag('foo')).toThrowError(/Invalid --sandbox value: "foo"/);
  });

  it('rejects an empty string with a clear error', () => {
    expect(() => parseSandboxFlag('')).toThrowError(/Invalid --sandbox value: ""/);
  });
});
