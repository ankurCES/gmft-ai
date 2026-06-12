import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { shellExecTool } from '../../src/shell/shell-exec.js';

const HOST_CTX = {
  cwd: process.cwd(),
  env: { ...process.env },
  cfg: { sandbox: { mode: 'host' as const } },
};

describe('shellExecTool', () => {
  it('has the right metadata', () => {
    expect(shellExecTool.name).toBe('shell_exec');
    expect(shellExecTool.category).toBe('shell');
    expect(shellExecTool.flags).toEqual(['destructive']);
  });

  describe('argv safety', () => {
    it('rejects && in argv', async () => {
      await expect(shellExecTool.run({ argv: ['echo', 'a && b'] }, HOST_CTX)).rejects.toThrow(
        /forbidden character/,
      );
    });

    it('rejects | in argv', async () => {
      await expect(shellExecTool.run({ argv: ['echo', 'a | b'] }, HOST_CTX)).rejects.toThrow(
        /forbidden character/,
      );
    });

    it('rejects ; in argv', async () => {
      await expect(shellExecTool.run({ argv: ['echo', 'a; b'] }, HOST_CTX)).rejects.toThrow(
        /forbidden character/,
      );
    });

    it('rejects $ in argv', async () => {
      await expect(shellExecTool.run({ argv: ['echo', '$HOME'] }, HOST_CTX)).rejects.toThrow(
        /forbidden character/,
      );
    });

    it('rejects backtick in argv', async () => {
      await expect(shellExecTool.run({ argv: ['echo', '`whoami`'] }, HOST_CTX)).rejects.toThrow(
        /forbidden character/,
      );
    });

    it('rejects > in argv', async () => {
      await expect(shellExecTool.run({ argv: ['echo', 'a > b'] }, HOST_CTX)).rejects.toThrow(
        /forbidden character/,
      );
    });

    it('accepts argv without forbidden chars', async () => {
      const r = await shellExecTool.run(
        { argv: ['node', '-e', 'process.stdout.write("42")'] },
        HOST_CTX,
      );
      expect(r.stdout).toMatch(/42/);
      expect(r.exitCode).toBe(0);
    });
  });

  describe('execution', () => {
    it('returns the structured output shape', async () => {
      const r = await shellExecTool.run(
        { argv: ['node', '-e', 'process.stdout.write("x")'] },
        HOST_CTX,
      );
      expect(r).toMatchObject({
        stdout: expect.stringMatching(/x/),
        stderr: expect.any(String),
        exitCode: 0,
        mode: expect.stringMatching(/docker|host/),
        fellBack: expect.any(Boolean),
        durationMs: expect.any(Number),
      });
    });

    it('captures stderr separately', async () => {
      const r = await shellExecTool.run(
        { argv: ['node', '-e', 'process.stderr.write("oops")'] },
        HOST_CTX,
      );
      expect(r.stderr).toMatch(/oops/);
      expect(r.stdout).toBe('');
    });

    it('honors timeoutMs', async () => {
      const r = await shellExecTool.run(
        { argv: ['node', '-e', 'setTimeout(function(){}, 200)'], timeoutMs: 2_000 },
        HOST_CTX,
      );
      expect(r.exitCode).toBe(0);
    });

    it('respects envAllowlist', async () => {
      const orig = process.env.SHELL_EXEC_TEST;
      process.env.SHELL_EXEC_TEST = 'present';
      try {
        const r = await shellExecTool.run(
          {
            argv: [
              'node',
              '-e',
              'process.stdout.write(process.env.SHELL_EXEC_TEST ?? "missing")',
            ],
            envAllowlist: ['SHELL_EXEC_TEST'],
          },
          HOST_CTX,
        );
        expect(r.stdout).toMatch(/present/);
      } finally {
        if (orig === undefined) delete process.env.SHELL_EXEC_TEST;
        else process.env.SHELL_EXEC_TEST = orig;
      }
    });
  });
});
