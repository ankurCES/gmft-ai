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
    await spawnStreaming({
      argv: [
        'node',
        '-e',
        'for (let i=0;i<10;i++) process.stdout.write(`chunk ${i}\n`)',
      ],
      onStdout: () => count++,
      timeoutMs: 5000,
    });
    expect(count).toBeGreaterThan(1);
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
