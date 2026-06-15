import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/shared/runner', () => ({
  run: vi.fn(),
}));

import {
  aircrackTool,
  parseAirodumpCsv,
  aircrackToFindings,
} from '../../src/wifi/aircrack.js';
import { run } from '../../src/shared/runner.js';

const SAMPLE_CSV = `BSSID, First time seen, Last time seen, channel, Speed, Privacy, Cipher, Authentication, Power, # beacons, # IV, LAN IP, ID-length, ESSID, Key
AA:BB:CC:DD:EE:FF, 2025-01-01 00:00:00, 2025-01-01 00:00:30, 6, 54, WPA2, CCMP, PSK, -42, 100, 0, 0.0.0.0, 10, CoffeeShop,
11:22:33:44:55:66, 2025-01-01 00:00:00, 2025-01-01 00:00:30, 11, 54, , , , -65, 50, 0, 0.0.0.0, 7, GuestNet,
77:88:99:AA:BB:CC, 2025-01-01 00:00:00, 2025-01-01 00:00:30, 1, 54, WEP, WEP, , -70, 30, 100, 0.0.0.0, 8, OldWEP,

Station MAC, First time seen, Last time seen, Power, # packets, BSSID, Probed ESSIDs
DE:AD:BE:EF:00:01, 2025-01-01 00:00:00, 2025-01-01 00:00:30, -55, 50, AA:BB:CC:DD:EE:FF,
DE:AD:BE:EF:00:02, 2025-01-01 00:00:00, 2025-01-01 00:00:30, -60, 25, 11:22:33:44:55:66,
DE:AD:BE:EF:00:03, 2025-01-01 00:00:00, 2025-01-01 00:00:30, -50, 10, , CoffeeShop
`;

describe('aircrack tool', () => {
  beforeEach(() => {
    vi.mocked(run).mockReset();
    vi.mocked(run).mockResolvedValue({
      exitCode: 0,
      stdout: '',
      stderr: '',
      durationMs: 30000,
      mode: 'host',
      fellBack: false,
    });
  });

  describe('parseAirodumpCsv', () => {
    it('extracts APs from the first CSV section', () => {
      const p = parseAirodumpCsv(SAMPLE_CSV);
      expect(p.aps).toHaveLength(3);
      const coffee = p.aps.find((a) => a.bssid === 'AA:BB:CC:DD:EE:FF')!;
      expect(coffee.essid).toBe('CoffeeShop');
      expect(coffee.channel).toBe(6);
      expect(coffee.privacy).toBe('WPA2');
    });

    it('detects open (empty privacy) APs', () => {
      const p = parseAirodumpCsv(SAMPLE_CSV);
      const guest = p.aps.find((a) => a.bssid === '11:22:33:44:55:66')!;
      expect(guest.privacy).toBe('');
      expect(guest.essid).toBe('GuestNet');
    });

    it('detects WEP APs', () => {
      const p = parseAirodumpCsv(SAMPLE_CSV);
      const wep = p.aps.find((a) => a.bssid === '77:88:99:AA:BB:CC')!;
      expect(wep.privacy).toBe('WEP');
    });

    it('extracts clients from the second section', () => {
      const p = parseAirodumpCsv(SAMPLE_CSV);
      expect(p.clients).toHaveLength(3);
      const c1 = p.clients.find((c) => c.mac === 'DE:AD:BE:EF:00:01')!;
      expect(c1.apBssid).toBe('AA:BB:CC:DD:EE:FF');
    });

    it('handles probing (unassociated) clients', () => {
      const p = parseAirodumpCsv(SAMPLE_CSV);
      const probing = p.clients.find((c) => c.mac === 'DE:AD:BE:EF:00:03')!;
      expect(probing.apBssid).toBeUndefined();
    });

    it('handles empty CSV', () => {
      const p = parseAirodumpCsv('');
      expect(p.aps).toHaveLength(0);
      expect(p.clients).toHaveLength(0);
    });
  });

  describe('aircrackToFindings', () => {
    it('emits info severity for WPA2 AP', () => {
      const p = parseAirodumpCsv(SAMPLE_CSV);
      const findings = aircrackToFindings(p.aps, p.clients);
      const coffee = findings.find((f) => f.target === 'AA:BB:CC:DD:EE:FF')!;
      expect(coffee.severity).toBe('info');
      expect(coffee.title).toContain('CoffeeShop');
    });

    it('emits medium severity for open AP', () => {
      const p = parseAirodumpCsv(SAMPLE_CSV);
      const findings = aircrackToFindings(p.aps, p.clients);
      const guest = findings.find((f) => f.target === '11:22:33:44:55:66')!;
      expect(guest.severity).toBe('medium');
      expect(guest.title).toContain('open network');
    });

    it('emits high severity for WEP AP', () => {
      const p = parseAirodumpCsv(SAMPLE_CSV);
      const findings = aircrackToFindings(p.aps, p.clients);
      const wep = findings.find((f) => f.target === '77:88:99:AA:BB:CC')!;
      expect(wep.severity).toBe('high');
      expect(wep.title).toContain('WEP');
    });

    it('emits info findings for each client', () => {
      const p = parseAirodumpCsv(SAMPLE_CSV);
      const findings = aircrackToFindings(p.aps, p.clients);
      const clients = findings.filter((f) => f.title.startsWith('Client captured'));
      expect(clients).toHaveLength(3);
      expect(clients.every((c) => c.severity === 'info')).toBe(true);
    });
  });

  describe('tool metadata', () => {
    it('registers with the right name, category, and flags', () => {
      expect(aircrackTool.name).toBe('aircrack');
      expect(aircrackTool.category).toBe('binary');
      expect(aircrackTool.flags).toEqual(['targetRequired']);
    });
  });

  describe('run()', () => {
    it('invokes the runner with the right argv and returns findings', async () => {
      vi.mocked(run).mockResolvedValueOnce({
        exitCode: 0,
        stdout: SAMPLE_CSV, // used as fallback if file read fails
        stderr: '',
        durationMs: 30000,
        mode: 'host',
        fellBack: false,
      });
      const out = await aircrackTool.run(
        { target: 'wlan0mon', duration: 30, channel: 6, outputPrefix: '/tmp/gmft-test-aircrack' },
        {} as any,
      );
      expect(out.findings.length).toBeGreaterThan(0);
      expect(out.aps.length).toBe(3);
      expect(out.clients.length).toBe(3);
      const call = vi.mocked(run).mock.calls[0][0];
      expect(call.argv).toContain('airodump-ng');
      expect(call.argv).toContain('wlan0mon');
      expect(call.argv).toContain('-c');
      expect(call.argv).toContain('6');
      expect(call.argv).toContain('-w');
      expect(call.argv).toContain('/tmp/gmft-test-aircrack');
    });

    it('omits -c when channel is not provided', async () => {
      await aircrackTool.run({ target: 'wlan0mon' }, {} as any);
      const call = vi.mocked(run).mock.calls[0][0];
      expect(call.argv).not.toContain('-c');
    });

    it('dry-runs in GMFT_DRY=1 without invoking the runner', async () => {
      const origDry = process.env.GMFT_DRY;
      process.env.GMFT_DRY = '1';
      try {
        const out = await aircrackTool.run(
          { target: 'wlan0mon', duration: 10 },
          {} as any,
        );
        expect(out.dryRun).toBe(true);
        expect(vi.mocked(run)).not.toHaveBeenCalled();
        expect(out.findings).toEqual([]);
      } finally {
        if (origDry === undefined) delete process.env.GMFT_DRY;
        else process.env.GMFT_DRY = origDry;
      }
    });
  });
});
