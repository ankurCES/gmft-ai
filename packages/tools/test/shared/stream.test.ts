import { describe, it, expect } from 'vitest';
import { spawnStreaming } from '../../src/shared/stream';

describe('spawnStreaming', () => {
  it('collects stdout and stderr to completion', async () => {
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const r = await spawnStreaming({
      argv: ['node', '-e', 'process.stdout.write("hi"); process.stderr.write("bye")'],
      onStdout: (b) => stdoutChunks.push(b),
      onStderr: (b) => stderrChunks.push(b),
      timeoutMs: 5000,
    });
    expect(r.exitCode).toBe(0);
    expect(stdoutChunks.join('')).toBe('hi');
    expect(stderrChunks.join('')).toBe('bye');
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('fires onStdout multiple times for chunked output', async () => {
    let count = 0;
    // Use setImmediate between writes to force the child to yield
    // to the event loop. Without the yield, Node's stdout pipe
    // can coalesce small writes into a single chunk and this test
    // flakes (~1/3 rate on the GitHub Actions Node 20 runner).
    const childCode = `
      let i = 0;
      const write = () => {
        if (i >= 10) return;
        process.stdout.write('chunk ' + i + '\\n');
        i++;
        setImmediate(write);
      };
      write();
    `;
    await spawnStreaming({
      argv: ['node', '-e', childCode],
      onStdout: () => count++,
      timeoutMs: 5000,
    });
    // On a healthy kernel+Node, the child yields between writes
    // and we get ≥2 chunks. On a heavily loaded CI runner it may
    // still coalesce; the floor of 2 is the real signal we want
    // (not just "any chunking at all").
    expect(count).toBeGreaterThanOrEqual(2);
  });

  it('rejects on non-zero exit code', async () => {
    await expect(
      spawnStreaming({
        argv: ['node', '-e', 'process.exit(7)'],
        onStdout: () => {},
        timeoutMs: 5000,
      }),
    ).rejects.toThrow(/exited with code 7/);
  });

  it('rejects on timeout', async () => {
    await expect(
      spawnStreaming({
        argv: ['node', '-e', 'setTimeout(() => {}, 60000)'],
        onStdout: () => {},
        timeoutMs: 100,
      }),
    ).rejects.toThrow(/timed out/);
  });
});
