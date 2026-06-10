/**
 * Tests for the selection sidecar (read + write). Per plan §B.2.
 * 2 tests: round-trip + missing-file behavior.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSelections, writeSelections } from '../../src/reports/selections';

describe('selections sidecar', () => {
  let baseDir: string;
  const sessionId = 'sess-1';

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'gmft-selections-'));
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it('round-trips checkedIds through write → read', () => {
    writeSelections(baseDir, sessionId, { checkedIds: ['f-1', 'f-2', 'f-3'] });
    const sidecarPath = join(baseDir, `${sessionId}.selections.json`);
    expect(existsSync(sidecarPath)).toBe(true);

    const read = readSelections(baseDir, sessionId);
    expect(read).toEqual({ checkedIds: ['f-1', 'f-2', 'f-3'] });
  });

  it('returns null when the sidecar file does not exist', () => {
    // No prior write → no sidecar
    expect(readSelections(baseDir, 'never-touched')).toBeNull();
  });

  it('returns null on a malformed sidecar (bad JSON)', () => {
    const p = join(baseDir, `${sessionId}.selections.json`);
    writeFileSync(p, '{ this is not json', 'utf8');
    expect(readSelections(baseDir, sessionId)).toBeNull();
  });

  it('returns null on a sidecar with the wrong shape (checkedIds not an array)', () => {
    const p = join(baseDir, `${sessionId}.selections.json`);
    writeFileSync(p, JSON.stringify({ checkedIds: 'not-an-array' }), 'utf8');
    expect(readSelections(baseDir, sessionId)).toBeNull();
  });
});
