import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/shared/runner', () => ({
  run: vi.fn(),
}));

import { wifiDeauthTool, WifiDeauthInput } from '../../src/wifi/deauth';
import { run } from '../../src/shared/runner';

describe('wifi_deauth tool (destructive + requiresElevation + attack-confirm)', () => {
  beforeEach(() => {
    delete process.env.GMFT_DRY;
    vi.mocked(run).mockReset();
  });

  it('registers with all high-friction markers and typeToConfirm=attack', () => {
    expect(wifiDeauthTool.name).toBe('wifi_deauth');
    expect(wifiDeauthTool.category).toBe('binary');
    expect(wifiDeauthTool.flags).toEqual(
      expect.arrayContaining(['destructive', 'requiresElevation']),
    );
    expect(wifiDeauthTool.typeToConfirm).toBe('attack');
  });

  it('rejects malformed BSSIDs at the zod schema level', () => {
    // The chokepoint's `checkTarget` regex (`^[a-zA-Z0-9._-]+$`)
    // rejects BSSIDs (they contain `:`), so this tool deliberately
    // does NOT set `targetRequired`. BSSID validation lives in zod.
    expect(() => WifiDeauthInput.parse({ target: 'not-a-mac' })).toThrow();
    expect(() => WifiDeauthInput.parse({ target: 'AA:BB:CC:DD' })).toThrow();
    expect(() => WifiDeauthInput.parse({ target: 'AA:BB:CC:DD:EE:FF' })).not.toThrow();
  });

  it('passes the right argv + image and parses framesSent in live mode', async () => {
    vi.mocked(run).mockResolvedValue({
      mode: 'docker',
      stdout: 'Sending 10 DeAuth\n10 packets sent',
      stderr: '',
      exitCode: 0,
      durationMs: 1234,
      fellBack: false,
    });
    const out = await wifiDeauthTool.run({
      target: 'AA:BB:CC:DD:EE:FF',
      clientMac: '11:22:33:44:55:66',
      count: 10,
      iface: 'wlan0mon',
    });
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        image: 'gmft/wifi:0.1',
        argv: [
          'aireplay-ng',
          '-0',
          '10',
          '-c',
          '11:22:33:44:55:66',
          '-a',
          'AA:BB:CC:DD:EE:FF',
          'wlan0mon',
        ],
      }),
    );
    expect(out.framesSent).toBe(10);
    expect(out.apBssid).toBe('AA:BB:CC:DD:EE:FF');
    expect(out.dryRun).toBe(false);
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]!.tool).toBe('wifi_deauth');
    expect(out.findings[0]!.severity).toBe('low');
  });

  it('passes count=0 through to aireplay-ng (-0 0 = continuous)', async () => {
    vi.mocked(run).mockResolvedValue({
      mode: 'docker',
      stdout: '',
      stderr: '',
      exitCode: 0,
      durationMs: 0,
      fellBack: false,
    });
    await wifiDeauthTool.run({ target: 'AA:BB:CC:DD:EE:FF', count: 0 });
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        argv: expect.arrayContaining(['-0', '0']),
      }),
    );
  });
});
