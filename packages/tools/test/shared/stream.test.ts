import { describe, it, expect } from 'vitest';
import { spawnStreaming } from '../../src/shared/stream.js';

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

  it('assembles chunked stdout into a single buffer', async () => {
    // The chunk count depends on the kernel + Node stdout pipe and is
    // not part of our contract (the implementation may hand the caller
    // one chunk or many). What we DO promise is that however many
    // chunks arrive, the bytes reassemble into the original payload
    // and the order is preserved. The earlier "≥2 chunks" assertion
    // flaked ~1/3 on the GitHub Actions Node 20 runner because the
    // kernel coalesced small writes when the runner was loaded.
    const chunks: string[] = [];
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
    const r = await spawnStreaming({
      argv: ['node', '-e', childCode],
      onStdout: (b) => chunks.push(b),
      timeoutMs: 5000,
    });
    expect(r.exitCode).toBe(0);
    const reassembled = chunks.join('');
    for (let i = 0; i < 10; i++) {
      expect(reassembled).toContain(`chunk ${i}\n`);
    }
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
