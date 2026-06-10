import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../src/config/atomic-write.js';

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gmft-atomic-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('atomicWriteFileSync', () => {
  it('writes content to the target path', () => {
    const p = join(dir, 'a.txt');
    atomicWriteFileSync(p, 'hello');
    expect(readFileSync(p, 'utf8')).toBe('hello');
  });

  it('leaves no temp file behind on the happy path', () => {
    const p = join(dir, 'b.txt');
    atomicWriteFileSync(p, 'world');
    const entries = readdirSync(dir);
    expect(entries).toEqual(['b.txt']);
  });

  it('overwrites an existing file in place', () => {
    const p = join(dir, 'c.txt');
    writeFileSync(p, 'OLD');
    atomicWriteFileSync(p, 'NEW');
    expect(readFileSync(p, 'utf8')).toBe('NEW');
    expect(readdirSync(dir)).toEqual(['c.txt']);
  });

  it('preserves the original file if the write fails', () => {
    const p = join(dir, 'd.txt');
    writeFileSync(p, 'KEEP-ME');

    // Force the temp-file open to fail by giving a path inside a
    // non-existent directory. The original file must be untouched.
    const badPath = join(dir, 'no-such-subdir', 'd.txt');
    expect(() => atomicWriteFileSync(badPath, 'BAD')).toThrow();
    expect(readFileSync(p, 'utf8')).toBe('KEEP-ME');
  });

  it('cleans up its temp file when the rename fails', () => {
    // Pre-create the target as a DIRECTORY so the final rename(tmp, p)
    // fails with EISDIR. The temp file (created before the rename) must
    // be cleaned up by the catch block — we should not leak a stray
    // `.f.txt.*.tmp` into the directory.
    const p = join(dir, 'e.txt');
    const { mkdirSync } = fs;
    mkdirSync(p, { recursive: true });

    expect(() => atomicWriteFileSync(p, 'NEW')).toThrow();
    // The "directory-as-file" is still there (the rename never happened)
    expect(existsSync(p)).toBe(true);
    // And no leftover temp files in the dir
    const leftover = readdirSync(dir).filter((f) => f !== 'e.txt');
    expect(leftover).toEqual([]);
  });

  it('uses a unique temp filename per call (no collisions across rapid calls)', () => {
    const p = join(dir, 'f.txt');
    atomicWriteFileSync(p, 'one');
    atomicWriteFileSync(p, 'two');
    atomicWriteFileSync(p, 'three');
    expect(readFileSync(p, 'utf8')).toBe('three');
    expect(readdirSync(dir)).toEqual(['f.txt']);
  });

  it('handles a file inside a nested directory (mkdir not required — caller does that)', () => {
    // atomicWriteFileSync deliberately does NOT mkdir — the caller is
    // responsible for that. We document the contract here.
    const p = join(dir, 'nested', 'g.txt');
    expect(() => atomicWriteFileSync(p, 'x')).toThrow();
  });
});
