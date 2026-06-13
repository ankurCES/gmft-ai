import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/shared/runner', () => ({
  run: vi.fn(),
}));

import {
  bettercapTool,
  parseBettercapOutput,
  bettercapToFindings,
} from '../../src/wifi/bettercap.js';
import { run } from '../../src/shared/runner.js';

const SAMPLE = `
[inf] Starting sniffing on wlan0mon (bettercap 2.32)...
[inf] wifi.recon on
[inf] ble.recon on
[inf] wifi.ap "AA:BB:CC:DD:EE:FF" ssid:"CoffeeShop" enc:"WPA2" signal:-42
[inf] wifi.ap "11:22:33:44:55:66" ssid:"GuestNet" enc:"OPEN" signal:-65
[inf] wifi.ap "77:88:99:AA:BB:CC" ssid:"OldWEP" enc:"WEP" signal:-70
[inf] wifi.client "DE:AD:BE:EF:00:01" ap:"AA:BB:CC:DD:EE:FF"
[inf] wifi.client "DE:AD:BE:EF:00:02" ap:"AA:BB:CC:DD:EE:FF"
[inf] wifi.client "DE:AD:BE:EF:00:03" ap:"11:22:33:44:55:66"
[inf] ble.device "C0:FF:EE:C0:FF:EE" name:"Tile Tracker" rssi:-58
[inf] ble.device "12:34:56:78:9A:BC" name:"AirPods Pro" rssi:-71
[inf] events.stream started
`;

describe('bettercap tool', () => {
  beforeEach(() => {
    vi.mocked(run).mockReset();
    vi.mocked(run).mockResolvedValue({
      exitCode: 0,
      stdout: SAMPLE,
      stderr: '',
      durationMs: 30000,
      mode: 'host',
      fellBack: false,
    });
  });

  describe('parseBettercapOutput', () => {
    it('extracts wifi APs', () => {
      const p = parseBettercapOutput(SAMPLE);
      const aps = [...p.aps.values()];
      expect(aps).toHaveLength(3);
      const coffee = aps.find((a) => a.bssid === 'AA:BB:CC:DD:EE:FF')!;
      expect(coffee.ssid).toBe('CoffeeShop');
      expect(coffee.encryption).toBe('WPA2');
      expect(coffee.signal).toBe(-42);
    });

    it('counts wifi clients per AP', () => {
      const p = parseBettercapOutput(SAMPLE);
      const aps = [...p.aps.values()];
      const coffee = aps.find((a) => a.bssid === 'AA:BB:CC:DD:EE:FF')!;
      expect(coffee.clients).toBe(2);
      const guest = aps.find((a) => a.bssid === '11:22:33:44:55:66')!;
      expect(guest.clients).toBe(1);
    });

    it('extracts BLE devices', () => {
      const p = parseBettercapOutput(SAMPLE);
      const devs = [...p.bleDevices.values()];
      expect(devs).toHaveLength(2);
      const tile = devs.find((d) => d.mac === 'C0:FF:EE:C0:FF:EE')!;
      expect(tile.name).toBe('Tile Tracker');
      expect(tile.rssi).toBe(-58);
    });

    it('handles empty output', () => {
      const p = parseBettercapOutput('');
      expect(p.aps.size).toBe(0);
      expect(p.bleDevices.size).toBe(0);
    });
  });

  describe('bettercapToFindings', () => {
    it('emits info severity for WPA2 AP', () => {
      const p = parseBettercapOutput(SAMPLE);
      const findings = bettercapToFindings(p);
      const coffee = findings.find((f) => f.target === 'AA:BB:CC:DD:EE:FF')!;
      expect(coffee.severity).toBe('info');
      expect(coffee.title).toContain('CoffeeShop');
    });

    it('emits medium severity for open AP', () => {
      const p = parseBettercapOutput(SAMPLE);
      const findings = bettercapToFindings(p);
      const guest = findings.find((f) => f.target === '11:22:33:44:55:66')!;
      expect(guest.severity).toBe('medium');
      expect(guest.title).toContain('open network');
    });

    it('emits high severity for WEP AP', () => {
      const p = parseBettercapOutput(SAMPLE);
      const findings = bettercapToFindings(p);
      const wep = findings.find((f) => f.target === '77:88:99:AA:BB:CC')!;
      expect(wep.severity).toBe('high');
      expect(wep.title).toContain('WEP');
    });

    it('emits info findings for BLE devices', () => {
      const p = parseBettercapOutput(SAMPLE);
      const findings = bettercapToFindings(p);
      const ble = findings.filter((f) => f.title.startsWith('BLE device'));
      expect(ble).toHaveLength(2);
      expect(ble.every((b) => b.severity === 'info')).toBe(true);
    });
  });

  describe('tool metadata', () => {
    it('registers with the right name, category, and flags', () => {
      expect(bettercapTool.name).toBe('bettercap');
      expect(bettercapTool.category).toBe('binary');
      expect(bettercapTool.flags).toEqual(['targetRequired']);
    });
  });

  describe('run()', () => {
    it('invokes the runner with the right argv and returns findings', async () => {
      const out = await bettercapTool.run(
        { target: 'wlan0mon', duration: 30, modules: ['wifi', 'ble'] },
        {} as any,
      );
      expect(out.findings.length).toBeGreaterThan(0);
      expect(out.duration).toBe(30);
      expect(out.mode).toBe('host');
      expect(out.fellBack).toBe(false);
      expect(out.aps.length).toBe(3);
      expect(out.bleDevices.length).toBe(2);
      const call = vi.mocked(run).mock.calls[0][0];
      expect(call.argv[0]).toBe('bettercap');
      expect(call.argv[1]).toBe('-eval');
      const expr = call.argv[2];
      expect(expr).toContain('set wifi.interface wlan0mon');
      expect(expr).toContain('wifi.recon on');
      expect(expr).toContain('ble.recon on');
      expect(expr).toContain('sleep 30');
      expect(expr).toContain('quit');
    });

    it('dry-runs in GMFT_DRY=1 without invoking the runner', async () => {
      const origDry = process.env.GMFT_DRY;
      process.env.GMFT_DRY = '1';
      try {
        const out = await bettercapTool.run(
          { target: 'wlan0mon', duration: 10, modules: ['wifi'] },
          {} as any,
        );
        expect(out.dryRun).toBe(true);
        expect(vi.mocked(run)).not.toHaveBeenCalled();
        expect(out.findings).toEqual([]);
        expect(out.aps).toEqual([]);
      } finally {
        if (origDry === undefined) delete process.env.GMFT_DRY;
        else process.env.GMFT_DRY = origDry;
      }
    });

    it('omits modules the user did not request', async () => {
      await bettercapTool.run(
        { target: 'wlan0mon', modules: ['wifi'] },
        {} as any,
      );
      const expr = vi.mocked(run).mock.calls[0][0].argv[2] as string;
      expect(expr).toContain('wifi.recon on');
      expect(expr).not.toContain('ble.recon on');
    });
  });
});
