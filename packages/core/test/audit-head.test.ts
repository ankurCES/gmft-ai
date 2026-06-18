/**
 * Tests for `readAuditChainHead` (v0.3.C follow-up).
 *
 * The StatusRail breadcrumb shows an "audit #N ✓" / "audit #N ✗ broken"
 * indicator. The reader is sync (called from a React useEffect) and
 * inspects only the last line of the log — full chain verification
 * lives in `gmft audit verify`.
 *
 * We don't touch the real config dir. The function takes the env
 * as its second arg (defaulting to process.env) and reads from
 * `<configDir>/gmft/audit/audit.jsonl`. We override `configDir` via
 * the `GMFT_CONFIG_DIR` / `XDG_CONFIG_HOME` env vars so the tests
 * land in a temp directory.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readAuditChainHead } from '../src/audit/head.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gmft-audit-head-'));
  // The function reads via `configDir()` which honors XDG_CONFIG_HOME
  // on Linux. Pin it to the temp dir so we don't pollute the real
  // ~/.config/gmft.
  process.env.XDG_CONFIG_HOME = tmp;
});

afterEach(() => {
  delete process.env.GMFT_DISABLE_AUDIT_LOG;
  rmSync(tmp, { recursive: true, force: true });
});

function writeAuditLog(contents: string): string {
  const dir = join(tmp, 'gmft', 'audit');
  // mkdirSync recursive would be the usual path, but `fs.mkdirSync`
  // is not imported at the top — keep the test self-contained.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdirSync } = require('node:fs') as typeof import('node:fs');
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'audit.jsonl');
  writeFileSync(p, contents);
  return p;
}

describe('readAuditChainHead', () => {
  it('returns { count: 0, broken: false } when the log file is missing', () => {
    // No writeAuditLog call — file absent.
    const head = readAuditChainHead();
    expect(head).toEqual({ count: 0, broken: false });
  });

  it('returns { count: 0, broken: false } for an empty file', () => {
    writeAuditLog('');
    expect(readAuditChainHead()).toEqual({ count: 0, broken: false });
  });

  it('counts well-formed events from the tail backward', () => {
    // 3 well-formed events. JSON.parse of each is fine; we don't
    // verify hashes here (that's the writer's job, covered in
    // audit-writer.test.ts).
    const event = (n: number) =>
      JSON.stringify({
        ts: `2026-06-19T00:00:0${n}.000Z`,
        kind: 'chokepoint-decision',
        prevHash: '0'.repeat(64),
        hash: String(n).padStart(64, 'a'),
        payload: {},
      });
    writeAuditLog([event(1), event(2), event(3)].join('\n') + '\n');
    expect(readAuditChainHead()).toEqual({ count: 3, broken: false });
  });

  it('reports broken: true when the last line does not parse', () => {
    const event = (n: number) =>
      JSON.stringify({
        ts: `2026-06-19T00:00:0${n}.000Z`,
        kind: 'chokepoint-decision',
        prevHash: '0'.repeat(64),
        hash: String(n).padStart(64, 'a'),
        payload: {},
      });
    writeAuditLog([event(1), event(2), '{not json'].join('\n') + '\n');
    // Last line is broken; the previous 2 are well-formed, so
    // count is 2 (we stop counting at the first bad line from
    // the tail).
    expect(readAuditChainHead()).toEqual({ count: 2, broken: true });
  });

  it('reports broken: true when the last line is missing the hash field', () => {
    writeAuditLog('{"ts":"x","kind":"k","prevHash":"p","payload":{}}\n');
    expect(readAuditChainHead()).toEqual({ count: 0, broken: true });
  });

  it('returns { count: 0, broken: false } when audit is disabled', () => {
    const event = (n: number) =>
      JSON.stringify({
        ts: '2026-06-19T00:00:00.000Z',
        kind: 'chokepoint-decision',
        prevHash: '0'.repeat(64),
        hash: String(n).padStart(64, 'a'),
        payload: {},
      });
    writeAuditLog([event(1), event(2), event(3)].join('\n') + '\n');
    process.env.GMFT_DISABLE_AUDIT_LOG = 'true';
    expect(readAuditChainHead()).toEqual({ count: 0, broken: false });
  });
});
