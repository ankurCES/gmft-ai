import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/shared/runner', () => ({
  run: vi.fn(),
}));

import {
  wpscanTool,
  parseWpscanOutput,
  wpscanToFindings,
} from '../../src/web/wpscan.js';
import { run } from '../../src/shared/runner.js';

const SAMPLE = `
        \\_\\____\\___\\_______ \\____ ______ _______  ____  __ _____  ___
         / / / ____/   |  \\/  \\/    \\      \\/  \\/    \\/  \\/    \\/  \\
        / ___\\___ \\___|  / / / /\\  |  / / / /\\  |  / / /\\  |  / /\\/\\ \\
       /_/   /____/_____/__/\\__/__/\\__/__/\\__/__/__/__/\\__/__/  \\__/

        WordPress Security Scanner by the WPScan Team
        Sponsored by Automattic — https://automattic.com

[+] URL: https://wp.example.com/ [10.10.10.10]
[+] Started: Mon Jan  1 00:00:00 2025

Interesting Finding(s):

[+] Headers
 | Interesting Entry: Server: nginx/1.18.0
 | Found By: Headers (Passive Detection)
 | Confidence: 100%

[+] WordPress version 6.4.2 identified (Insecure, but no exact version)
 | Detected By: Rss Generator (Passive Detection)
 |  - https://wp.example.com/feed/, <generator>https://wordpress.org/?v=6.4.2</generator>
 | Reference: https://wordpress.org/

[i] The WordPress version could not be automatically detected.

[+] WordPress theme in use: twentytwentyfour
 | Location: https://wp.example.com/wp-content/themes/twentytwentyfour/
 | Latest Version: 1.1 (outdated)
 | Status: Outdated
 | Style URL: https://wp.example.com/wp-content/themes/twentytwentyfour/style.css
 | Style Name: Twenty Twenty-Four
 | Description: ...
 | Author: WordPress Team

[+] Plugin(s) Identified:

[+] akismet
 | Location: https://wp.example.com/wp-content/plugins/akismet/
 | Latest Version: 5.3
 | Status: Up To Date

[+] woocommerce
 | Location: https://wp.example.com/wp-content/plugins/woocommerce/
 | Latest Version: 8.5.0
 | Status: Outdated
 |
 | Found By: Known Vulnerabilities
 |
 | [!] Title: WooCommerce < 8.6 — Authenticated SQL Injection
 |     Reference: https://wpscan.com/vulnerability/CVE-2024-1234
 |     Fixed in: 8.6.0

[+] WordPress user : admin
 | Detected By: Rss Generator (Passive Detection)
 | Confirm By: Author Archive (Passive Detection)

[i] User(s) Identified:

[+] admin
 | Detected By: Rss Generator (Passive Detection)

[+] editor
 | Detected By: Author Id Brute Forcing - 1 Time(s)
`;

describe('wpscan tool', () => {
  beforeEach(() => {
    vi.mocked(run).mockReset();
    vi.mocked(run).mockResolvedValue({
      exitCode: 0,
      stdout: SAMPLE,
      stderr: '',
      durationMs: 1000,
      mode: 'host',
      fellBack: false,
    });
  });

  describe('parseWpscanOutput', () => {
    it('extracts WordPress version', () => {
      const p = parseWpscanOutput(SAMPLE);
      expect(p.wordpressVersion).toBe('6.4.2');
    });

    it('extracts plugins with version and outdated flag', () => {
      const p = parseWpscanOutput(SAMPLE);
      expect(p.plugins).toHaveLength(2);
      const akismet = p.plugins.find((pl) => pl.name === 'akismet')!;
      expect(akismet.version).toBe('5.3');
      expect(akismet.outdated).toBe(false);
      const woocommerce = p.plugins.find((pl) => pl.name === 'woocommerce')!;
      expect(woocommerce.version).toBe('8.5.0');
      expect(woocommerce.outdated).toBe(true);
    });

    it('extracts themes with version and outdated flag', () => {
      const p = parseWpscanOutput(SAMPLE);
      expect(p.themes).toHaveLength(1);
      expect(p.themes[0].name).toBe('twentytwentyfour');
      expect(p.themes[0].version).toBe('1.1');
      expect(p.themes[0].outdated).toBe(true);
    });

    it('extracts plugin vulnerabilities', () => {
      const p = parseWpscanOutput(SAMPLE);
      expect(p.vulnerabilities).toHaveLength(1);
      expect(p.vulnerabilities[0].component).toBe('woocommerce');
      expect(p.vulnerabilities[0].componentType).toBe('plugin');
      expect(p.vulnerabilities[0].title).toContain('SQL Injection');
    });

    it('extracts enumerated usernames', () => {
      const p = parseWpscanOutput(SAMPLE);
      expect(p.usernames).toHaveLength(2);
      const names = p.usernames.map((u) => u.username);
      expect(names).toContain('admin');
      expect(names).toContain('editor');
    });

    it('handles empty output', () => {
      const p = parseWpscanOutput('');
      expect(p.wordpressVersion).toBeUndefined();
      expect(p.plugins).toHaveLength(0);
      expect(p.themes).toHaveLength(0);
      expect(p.vulnerabilities).toHaveLength(0);
      expect(p.usernames).toHaveLength(0);
    });
  });

  describe('wpscanToFindings', () => {
    it('assigns info severity to WP version detection', () => {
      const p = parseWpscanOutput(SAMPLE);
      const findings = wpscanToFindings(p);
      const wpFinding = findings.find((f) => f.title.startsWith('WordPress'));
      expect(wpFinding).toBeDefined();
      expect(wpFinding!.severity).toBe('info');
    });

    it('marks outdated plugin as medium', () => {
      const p = parseWpscanOutput(SAMPLE);
      const findings = wpscanToFindings(p);
      const wc = findings.find((f) => f.target === 'woocommerce');
      expect(wc).toBeDefined();
      expect(wc!.severity).toBe('medium');
      expect(wc!.title).toContain('8.5.0');
      expect(wc!.title).toContain('outdated');
    });

    it('marks up-to-date plugin as info', () => {
      const p = parseWpscanOutput(SAMPLE);
      const findings = wpscanToFindings(p);
      const ak = findings.find((f) => f.target === 'akismet');
      expect(ak!.severity).toBe('info');
    });

    it('marks outdated theme as medium', () => {
      const p = parseWpscanOutput(SAMPLE);
      const findings = wpscanToFindings(p);
      const t = findings.find((f) => f.target === 'twentytwentyfour');
      expect(t!.severity).toBe('medium');
    });

    it('marks vulnerabilities as high', () => {
      const p = parseWpscanOutput(SAMPLE);
      const findings = wpscanToFindings(p);
      const v = findings.find((f) => f.severity === 'high');
      expect(v).toBeDefined();
      expect(v!.target).toBe('woocommerce');
      expect(v!.title).toContain('SQL Injection');
    });

    it('marks enumerated usernames as medium', () => {
      const p = parseWpscanOutput(SAMPLE);
      const findings = wpscanToFindings(p);
      const users = findings.filter((f) => f.title.startsWith('Enumerated WordPress user'));
      expect(users).toHaveLength(2);
      expect(users.every((u) => u.severity === 'medium')).toBe(true);
    });
  });

  describe('tool metadata', () => {
    it('registers with the right name, category, and flags', () => {
      expect(wpscanTool.name).toBe('wpscan');
      expect(wpscanTool.category).toBe('binary');
      expect(wpscanTool.flags).toEqual([]);
    });
  });

  describe('run()', () => {
    it('invokes the runner with the right argv and returns findings', async () => {
      const out = await wpscanTool.run(
        {
          target: 'https://wp.example.com',
          enumerate: 'vp,vt,u',
          detectPluginVersion: true,
          userscan: true,
        },
        {} as any,
      );
      expect(out.findings.length).toBeGreaterThan(0);
      expect(out.mode).toBe('host');
      expect(vi.mocked(run)).toHaveBeenCalledWith(
        expect.objectContaining({
          argv: expect.arrayContaining([
            'wpscan',
            '--url',
            'https://wp.example.com',
            '--no-banner',
            '--enumerate',
            'vp,vt,u',
            '--plugins-detection',
            'aggressive',
            '--userscan',
            'stealthy',
          ]),
        }),
      );
    });

    it('passes api token when provided', async () => {
      await wpscanTool.run(
        { target: 'https://wp.example.com', apiToken: 'abc123' },
        {} as any,
      );
      const call = vi.mocked(run).mock.calls[0][0];
      expect(call.argv).toContain('--api-token');
      expect(call.argv).toContain('abc123');
    });

    it('omits optional flags when not provided', async () => {
      await wpscanTool.run({ target: 'https://wp.example.com' }, {} as any);
      const call = vi.mocked(run).mock.calls[0][0];
      expect(call.argv).not.toContain('--enumerate');
      expect(call.argv).not.toContain('--api-token');
      expect(call.argv).not.toContain('--plugins-detection');
      expect(call.argv).not.toContain('--userscan');
    });
  });
});
