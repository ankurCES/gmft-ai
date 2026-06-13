import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/shared/runner', () => ({
  run: vi.fn(),
}));

import {
  kismetTool,
  parseKismetLog,
  kismetToFindings,
} from '../../src/wifi/kismet.js';
import { run } from '../../src/shared/runner.js';

const SAMPLE_LOG = `
{"type":"kismet_log_version","version":[4,0,0,0]}
{"type":"kismet_log_timestamp","sec":1704067200,"usec":0}
{"type":"kismet_log_device","kismet_log_device_uuid":"aaaaaaaa-1","kismet_log_device_record":{"kismet.device.base.macaddr":"AA:BB:CC:DD:EE:FF","kismet.device.base.name":"CoffeeShop","kismet.device.base.type":"wi-fi","kismet.device.base.signal":{"last_signal_dbm":-42},"kismet.device.base.channel":"6","kismet.device.base.dot11.device.advertised_ssid_map":{"CoffeeShop":{"crypt":{"WPA2":1,"CCMP":1}}}}}
{"type":"kismet_log_device","kismet_log_device_uuid":"bbbbbbbb-2","kismet_log_device_record":{"kismet.device.base.macaddr":"11:22:33:44:55:66","kismet.device.base.name":"GuestNet","kismet.device.base.type":"wi-fi","kismet.device.base.signal":{"last_signal_dbm":-65},"kismet.device.base.channel":"11","kismet.device.base.dot11.device.advertised_ssid_map":{"GuestNet":{"crypt":{"OPEN":1}}}}}
{"type":"kismet_log_device","kismet_log_device_uuid":"cccccccc-3","kismet_log_device_record":{"kismet.device.base.macaddr":"77:88:99:AA:BB:CC","kismet.device.base.name":"OldWEP","kismet.device.base.type":"wi-fi","kismet.device.base.signal":{"last_signal_dbm":-70},"kismet.device.base.channel":"1","kismet.device.base.dot11.device.advertised_ssid_map":{"OldWEP":{"crypt":{"WEP":1}}}}}
{"type":"kismet_log_device","kismet_log_device_uuid":"dddddddd-4","kismet_log_device_record":{"kismet.device.base.macaddr":"C0:FF:EE:C0:FF:EE","kismet.device.base.name":"Tile Tracker","kismet.device.base.type":"bluetooth","kismet.device.base.signal":{"last_signal_dbm":-58}}}
`;

describe('kismet tool', () => {
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

  describe('parseKismetLog', () => {
    it('extracts wifi APs with mac, name, signal, channel, crypt', () => {
      const devs = parseKismetLog(SAMPLE_LOG);
      const coffee = devs.find((d) => d.mac === 'AA:BB:CC:DD:EE:FF')!;
      expect(coffee.name).toBe('CoffeeShop');
      expect(coffee.type).toBe('wi-fi');
      expect(coffee.signal).toBe(-42);
      expect(coffee.channel).toBe('6');
      expect(coffee.crypt).toEqual(['WPA2', 'CCMP']);
    });

    it('detects OPEN Wi-Fi networks', () => {
      const devs = parseKismetLog(SAMPLE_LOG);
      const guest = devs.find((d) => d.mac === '11:22:33:44:55:66')!;
      expect(guest.crypt).toEqual(['OPEN']);
    });

    it('detects WEP Wi-Fi networks', () => {
      const devs = parseKismetLog(SAMPLE_LOG);
      const wep = devs.find((d) => d.mac === '77:88:99:AA:BB:CC')!;
      expect(wep.crypt).toEqual(['WEP']);
    });

    it('extracts non-wifi devices (bluetooth, etc.)', () => {
      const devs = parseKismetLog(SAMPLE_LOG);
      const tile = devs.find((d) => d.mac === 'C0:FF:EE:C0:FF:EE')!;
      expect(tile.type).toBe('bluetooth');
      expect(tile.crypt).toBeUndefined();
    });

    it('skips non-device log lines', () => {
      const devs = parseKismetLog(SAMPLE_LOG);
      // preamble lines (version, timestamp) should not be parsed as devices
      expect(devs.every((d) => d.mac !== undefined)).toBe(true);
      expect(devs).toHaveLength(4);
    });

    it('handles empty input', () => {
      const devs = parseKismetLog('');
      expect(devs).toEqual([]);
    });

    it('skips malformed lines gracefully', () => {
      const text = `not json at all\n{"type":"kismet_log_device","kismet_log_device_record":{"kismet.device.base.macaddr":"AA:BB:CC:DD:EE:FF","kismet.device.base.type":"wi-fi"}}`;
      const devs = parseKismetLog(text);
      expect(devs).toHaveLength(1);
    });
  });

  describe('kismetToFindings', () => {
    it('emits info severity for WPA2 AP', () => {
      const devs = parseKismetLog(SAMPLE_LOG);
      const findings = kismetToFindings(devs);
      const coffee = findings.find((f) => f.target === 'AA:BB:CC:DD:EE:FF')!;
      expect(coffee.severity).toBe('info');
      expect(coffee.title).toContain('CoffeeShop');
    });

    it('emits medium severity for OPEN AP', () => {
      const devs = parseKismetLog(SAMPLE_LOG);
      const findings = kismetToFindings(devs);
      const guest = findings.find((f) => f.target === '11:22:33:44:55:66')!;
      expect(guest.severity).toBe('medium');
      expect(guest.title).toContain('open network');
    });

    it('emits high severity for WEP AP', () => {
      const devs = parseKismetLog(SAMPLE_LOG);
      const findings = kismetToFindings(devs);
      const wep = findings.find((f) => f.target === '77:88:99:AA:BB:CC')!;
      expect(wep.severity).toBe('high');
      expect(wep.title).toContain('WEP');
    });

    it('emits info severity for non-wifi devices', () => {
      const devs = parseKismetLog(SAMPLE_LOG);
      const findings = kismetToFindings(devs);
      const tile = findings.find((f) => f.target === 'C0:FF:EE:C0:FF:EE')!;
      expect(tile.severity).toBe('info');
      expect(tile.title).toContain('bluetooth seen');
    });
  });

  describe('tool metadata', () => {
    it('registers with the right name, category, and flags', () => {
      expect(kismetTool.name).toBe('kismet');
      expect(kismetTool.category).toBe('binary');
      expect(kismetTool.flags).toEqual(['targetRequired']);
    });
  });

  describe('run()', () => {
    it('invokes the runner with the right argv and returns findings', async () => {
      vi.mocked(run).mockResolvedValueOnce({
        exitCode: 0,
        stdout: SAMPLE_LOG, // fallback if file read fails
        stderr: '',
        durationMs: 30000,
        mode: 'host',
        fellBack: false,
      });
      const out = await kismetTool.run(
        { target: 'wlan0mon', duration: 30, logPrefix: '/tmp/gmft-test-kismet' },
        {} as any,
      );
      expect(out.findings.length).toBeGreaterThan(0);
      expect(out.devices.length).toBe(4);
      const call = vi.mocked(run).mock.calls[0][0];
      expect(call.argv).toContain('kismet');
      expect(call.argv).toContain('-t');
      expect(call.argv).toContain('wlan0mon');
      expect(call.argv).toContain('--no-daemonize');
      expect(call.argv).toContain('--log-prefix');
      expect(call.argv).toContain('/tmp/gmft-test-kismet');
    });

    it('dry-runs in GMFT_DRY=1 without invoking the runner', async () => {
      const origDry = process.env.GMFT_DRY;
      process.env.GMFT_DRY = '1';
      try {
        const out = await kismetTool.run(
          { target: 'wlan0mon', duration: 10 },
          {} as any,
        );
        expect(out.dryRun).toBe(true);
        expect(vi.mocked(run)).not.toHaveBeenCalled();
        expect(out.findings).toEqual([]);
        expect(out.devices).toEqual([]);
      } finally {
        if (origDry === undefined) delete process.env.GMFT_DRY;
        else process.env.GMFT_DRY = origDry;
      }
    });
  });
});
