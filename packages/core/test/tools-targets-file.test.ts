/**
 * Tests for `readTargetsFile`.
 *
 * Two scenarios per the plan:
 *   1. happy path — file with 5 targets + 2 comment lines + 1 blank
 *      line, returns 5 targets in order.
 *   2. size cap — 2 MB file throws before read.
 *
 * We also pin the 10,000-line cap since it's the other half of the
 * "trust boundary" guarantee.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTargetsFile } from '../src/tools/targets-file.js';

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'gmft-targets-'));
}

describe('readTargetsFile', () => {
  it('returns one target per non-blank, non-comment line, in order', async () => {
    const dir = makeTempDir();
    try {
      const file = join(dir, 'targets.txt');
      writeFileSync(
        file,
        [
          '# recon scope for engagement #42',
          '10.0.0.1',
          '',
          '  10.0.0.2  ', // leading/trailing whitespace
          '10.0.0.3',
          '# internal note: avoid 10.0.0.4',
          'scanme.example.com',
        ].join('\n'),
      );
      const out = await readTargetsFile(file);
      expect(out).toEqual([
        '10.0.0.1',
        '10.0.0.2',
        '10.0.0.3',
        'scanme.example.com',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws when the file is larger than 1 MB', async () => {
    const dir = makeTempDir();
    try {
      const file = join(dir, 'huge.txt');
      // Build a 1.5 MB file of repeated target lines. That's well
      // over the 1 MB cap (it triggers before the line cap).
      const line = '10.0.0.1\n';
      const reps = Math.ceil((1.5 * 1024 * 1024) / line.length);
      writeFileSync(file, line.repeat(reps));
      expect(statSync(file).size).toBeGreaterThan(1024 * 1024);
      await expect(readTargetsFile(file)).rejects.toThrow(/too large/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws when the file has more than 10,000 target lines', async () => {
    const dir = makeTempDir();
    try {
      const file = join(dir, 'many.txt');
      // Build a small-but-wide file: 10,001 short lines, no comments
      // or blanks. The 1 MB cap doesn't fire (well under it); the
      // 10k line cap does.
      const lines: string[] = [];
      for (let i = 0; i < 10_001; i++) lines.push(`10.0.0.${i % 250}`);
      writeFileSync(file, lines.join('\n'));
      await expect(readTargetsFile(file)).rejects.toThrow(/too many lines/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws when the file is missing', async () => {
    const dir = makeTempDir();
    try {
      const file = join(dir, 'does-not-exist.txt');
      await expect(readTargetsFile(file)).rejects.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
