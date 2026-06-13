import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/shared/runner', () => ({
  run: vi.fn(),
}));

import {
  httpxTool,
  parseHttpxOutput,
  httpxToFindings,
} from '../../src/web/httpx.js';
import { run } from '../../src/shared/runner.js';

const SIMPLE_OUTPUT = `https://example.com
https://example.org
`;

const RICH_OUTPUT = `https://example.com [200] [1234] [Example Domain]
https://example.org [404] [99] [Not Found]
https://example.net [500] [512] [Internal Server Error]
`;

describe('httpx tool', () => {
  beforeEach(() => {
    vi.mocked(run).mockReset();
    vi.mocked(run).mockResolvedValue({
      exitCode: 0,
      stdout: SIMPLE_OUTPUT,
      stderr: '',
      durationMs: 42,
      mode: 'host',
      fellBack: false,
    });
  });

  describe('parseHttpxOutput', () => {
    it('parses plain URL output', () => {
      const lines = parseHttpxOutput(SIMPLE_OUTPUT);
      expect(lines).toHaveLength(2);
      expect(lines[0].url).toBe('https://example.com');
      expect(lines[0].statusCode).toBeUndefined();
    });

    it('parses enriched output with status, length, title', () => {
      const lines = parseHttpxOutput(RICH_OUTPUT);
      expect(lines).toHaveLength(3);
      expect(lines[0]).toEqual({
        url: 'https://example.com',
        statusCode: 200,
        contentLength: 1234,
        title: 'Example Domain',
      });
      expect(lines[1].statusCode).toBe(404);
      expect(lines[2].statusCode).toBe(500);
    });

    it('skips blank lines', () => {
      const lines = parseHttpxOutput('\n\nhttps://x.com\n\n');
      expect(lines).toHaveLength(1);
      expect(lines[0].url).toBe('https://x.com');
    });
  });

  describe('httpxToFindings', () => {
    it('marks 2xx/3xx as info', () => {
      const lines = parseHttpxOutput(RICH_OUTPUT);
      const findings = httpxToFindings(lines);
      expect(findings[0].severity).toBe('info');
      expect(findings[0].tool).toBe('httpx');
      expect(findings[0].target).toBe('https://example.com');
      expect(findings[0].title).toContain('200');
      expect(findings[0].title).toContain('Example Domain');
    });

    it('marks 4xx/5xx as medium', () => {
      const lines = parseHttpxOutput(RICH_OUTPUT);
      const findings = httpxToFindings(lines);
      expect(findings[1].severity).toBe('medium');
      expect(findings[2].severity).toBe('medium');
    });

    it('marks entries without a status code as info', () => {
      const lines = parseHttpxOutput(SIMPLE_OUTPUT);
      const findings = httpxToFindings(lines);
      expect(findings[0].severity).toBe('info');
      expect(findings[0].title).toBe('HTTP unknown');
    });

    it('builds a slug-based id (matches ldapsearch convention)', () => {
      const lines = parseHttpxOutput('https://x.com/foo.bar?q=1');
      const findings = httpxToFindings(lines);
      expect(findings[0].meta?.slug).toBe('https---x.com-foo.bar-q-1');
    });
  });

  describe('tool metadata', () => {
    it('registers with the right name, category, and flags', () => {
      expect(httpxTool.name).toBe('httpx');
      expect(httpxTool.category).toBe('binary');
      expect(httpxTool.flags).toEqual([]);
    });
  });

  describe('run()', () => {
    it('invokes the runner with the right argv and returns parsed findings', async () => {
      vi.mocked(run).mockResolvedValueOnce({
        exitCode: 0,
        stdout: RICH_OUTPUT,
        stderr: '',
        durationMs: 99,
        mode: 'host+landlock',
        fellBack: false,
      });
      const out = await httpxTool.run(
        {
          target: 'https://example.com',
          statusCode: true,
          contentLength: true,
          title: true,
          followRedirects: true,
        },
        {} as any,
      );
      expect(out.findings).toHaveLength(3);
      expect(out.mode).toBe('host+landlock');
      expect(out.fellBack).toBe(false);
      expect(vi.mocked(run)).toHaveBeenCalledWith(
        expect.objectContaining({
          argv: expect.arrayContaining([
            'httpx',
            '-u',
            'https://example.com',
            '-silent',
            '-status-code',
            '-content-length',
            '-title',
            '-follow-redirects',
          ]),
        }),
      );
    });

    it('omits optional flags when not provided', async () => {
      await httpxTool.run({ target: 'https://example.com' }, {} as any);
      const call = vi.mocked(run).mock.calls[0][0];
      expect(call.argv).not.toContain('-status-code');
      expect(call.argv).not.toContain('-content-length');
      expect(call.argv).not.toContain('-title');
      expect(call.argv).not.toContain('-ports');
      expect(call.argv).not.toContain('-method');
    });

    it('passes ports and method when provided', async () => {
      await httpxTool.run(
        {
          target: 'https://example.com',
          ports: '80,443,8080',
          method: 'POST',
        },
        {} as any,
      );
      const call = vi.mocked(run).mock.calls[0][0];
      expect(call.argv).toContain('-ports');
      expect(call.argv).toContain('80,443,8080');
      expect(call.argv).toContain('-method');
      expect(call.argv).toContain('POST');
    });
  });
});
