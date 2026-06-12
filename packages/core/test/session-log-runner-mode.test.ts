/**
 * v0.2.D — tests for the `runnerMode` field on the session log
 * `Turn` record.
 *
 * The field is optional and free-form for now (the agent loop
 * populates it at dispatch time). The contract these tests guard:
 *   - `runnerMode` is written through `appendTurn` and read back
 *     faithfully (no normalization that mangles the literal).
 *   - Older v0.1-shaped turns (no `runnerMode` field) read back with
 *     `runnerMode: undefined`. This is the migration path for any
 *     pre-v0.2.D log.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendTurn, readLog, type Turn } from '../src/session/log.js';

let dir: string;
let logPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gmft-log-runner-mode-'));
  logPath = join(dir, 'session.jsonl');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('session log: runnerMode field (v0.2.D)', () => {
  it('writes and reads back runnerMode: "host+landlock"', async () => {
    const turn: Turn = {
      role: 'tool',
      content: 'shell_exec result',
      runnerMode: 'host+landlock',
    };
    await appendTurn(logPath, turn);
    const got = await readLog(logPath);
    expect(got).toHaveLength(1);
    expect(got[0]?.runnerMode).toBe('host+landlock');
  });

  it('writes and reads back runnerMode: "unsandboxed"', async () => {
    const turn: Turn = {
      role: 'tool',
      content: 'shell_exec result (denied by chokepoint)',
      runnerMode: 'unsandboxed',
    };
    await appendTurn(logPath, turn);
    const got = await readLog(logPath);
    expect(got[0]?.runnerMode).toBe('unsandboxed');
  });

  it('reads a v0.1-shaped turn (no runnerMode) with runnerMode: undefined', async () => {
    // Bypass appendTurn so we can write a v0.1-shaped line directly
    // (no schemaVersion, no runnerMode). This simulates a log that
    // was written by an older version of the code.
    const { appendFile } = await import('node:fs/promises');
    const v1Line = JSON.stringify({ role: 'user', content: 'hello' }) + '\n';
    await appendFile(logPath, v1Line, 'utf8');

    const got = await readLog(logPath);
    expect(got).toHaveLength(1);
    expect(got[0]?.schemaVersion).toBe(1);
    expect(got[0]?.runnerMode).toBeUndefined();
  });

  it('preserves runnerMode alongside supervisor (v0.2.A.3 + v0.2.D fields coexist)', async () => {
    const turn: Turn = {
      role: 'tool',
      content: 'nmap result',
      runnerMode: 'docker',
      supervisor: {
        fires: [],
        postmortem: 'No issues detected.',
      },
    };
    await appendTurn(logPath, turn);
    const got = await readLog(logPath);
    expect(got[0]?.runnerMode).toBe('docker');
    expect(got[0]?.supervisor?.postmortem).toBe('No issues detected.');
  });
});
