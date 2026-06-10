import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/shared/runner', () => ({
  run: vi.fn(),
}));

import {
  wifiteScanTool,
  WifiteScanInput,
  parseAirodumpTable,
} from '../../src/wifi/wifite-scan';
import { run } from '../../src/shared/runner';

describe('wifite_scan tool (destructive + requiresElevation + attack-confirm)', () => {
  beforeEach(() => {
    delete process.env.GMFT_DRY;
    vi.mocked(run).mockReset();
  });

  it('registers with all high-friction markers and typeToConfirm=attack', () => {
    expect(wifiteScanTool.name).toBe('wifite_scan');
    expect(wifiteScanTool.category).toBe('binary');
    expect(wifiteScanTool.flags).toEqual(
      expect.arrayContaining(['destructive', 'requiresElevation']),
    );
    expect(wifiteScanTool.typeToConfirm).toBe('attack');
  });

  it('clamps duration to 5..600 via zod', () => {
    expect(() => WifiteScanInput.parse({ duration: 4 })).toThrow();
    expect(() => WifiteScanInput.parse({ duration: 601 })).toThrow();
    expect(() => WifiteScanInput.parse({ duration: 5 })).not.toThrow();
    expect(() => WifiteScanInput.parse({ duration: 600 })).not.toThrow();
  });

  it('passes the right argv and image to wifite in live mode', async () => {
    vi.mocked(run).mockResolvedValue({
      mode: 'docker',
      stdout:
        'BSSID              PWR  Beacons    #Data, #/s  CH   MB   ENC   CIPHER AUTH ESSID\n' +
        'AA:BB:CC:DD:EE:FF  -45       5        0    0   6  54e  WPA2  CCMP   PSK  CorpWiFi',
      stderr: '',
      exitCode: 0,
      durationMs: 5000,
      fellBack: false,
    });
    const out = await wifiteScanTool.run({
      iface: 'wlan0mon',
      duration: 60,
    });
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        image: 'gmft/wifi:0.1',
        argv: [
          'wifite',
          '-i',
          'wlan0mon',
          '--nodeauths',
          '--no-wps',
          '--no-pixie',
          '--wpat',
          '65',
        ],
      }),
    );
    expect(out.aps).toHaveLength(1);
    expect(out.aps[0]!.bssid).toBe('AA:BB:CC:DD:EE:FF');
    expect(out.aps[0]!.essid).toBe('CorpWiFi');
    expect(out.aps[0]!.channel).toBe(6);
    expect(out.aps[0]!.encryption).toBe('WPA2');
    expect(out.aps[0]!.power).toBe(-45);
    expect(out.dryRun).toBe(false);
    // One finding per AP — severity 'low' for WPA2
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]!.severity).toBe('low');
  });

  it('emits info-severity findings for OPN (open) networks', async () => {
    vi.mocked(run).mockResolvedValue({
      mode: 'docker',
      stdout:
        'BSSID              PWR  Beacons    #Data, #/s  CH   MB   ENC   CIPHER AUTH ESSID\n' +
        '11:22:33:44:55:66  -72      12        0    0  11  54e  OPN               FreeWiFi',
      stderr: '',
      exitCode: 0,
      durationMs: 1000,
      fellBack: false,
    });
    const out = await wifiteScanTool.run({ duration: 30 });
    expect(out.aps[0]!.encryption).toBe('OPN');
    expect(out.findings[0]!.severity).toBe('info');
  });
});

describe('parseAirodumpTable (pure parser)', () => {
  it('parses multiple APs, dedupes, and skips header / client-station lines', () => {
    const stdout = [
      'CH  6 ][ Elapsed: 10 s ][ 2024-01-01 12:00',
      '',
      'BSSID              PWR  Beacons    #Data, #/s  CH   MB   ENC   CIPHER AUTH ESSID',
      'AA:BB:CC:DD:EE:FF  -45       5        0    0   6  54e  WPA2  CCMP   PSK  CorpWiFi',
      '11:22:33:44:55:66  -72      12        0    0  11  54e  OPN               FreeWiFi',
      'AA:BB:CC:DD:EE:FF  -45       5        0    0   6  54e  WPA2  CCMP   PSK  CorpWiFi', // duplicate
      'Station MAC           PWR   Rate    Lost    Frames  Notes  Probes',
      'AA:BB:CC:DD:EE:FF  -45       0        0      12',
    ].join('\n');
    const aps = parseAirodumpTable(stdout);
    expect(aps).toHaveLength(2);
    expect(aps.map((a) => a.bssid)).toEqual(['AA:BB:CC:DD:EE:FF', '11:22:33:44:55:66']);
    expect(aps[0]!.essid).toBe('CorpWiFi');
    expect(aps[1]!.essid).toBe('FreeWiFi');
  });

  it('returns an empty array for empty / header-only input', () => {
    expect(parseAirodumpTable('')).toEqual([]);
    expect(
      parseAirodumpTable('BSSID              PWR  Beacons    #Data, #/s  CH   MB   ENC'),
    ).toEqual([]);
  });
});
