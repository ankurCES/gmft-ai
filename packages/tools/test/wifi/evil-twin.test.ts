import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/shared/runner', () => ({
  run: vi.fn(),
}));

vi.mock('../../src/shared/prereq', () => ({
  assertBinary: vi.fn(),
}));

import { evilTwinTool } from '../../src/wifi/evil-twin';
import { run } from '../../src/shared/runner';
import { assertBinary } from '../../src/shared/prereq';

describe('evil_twin tool (destructive + requiresElevation)', () => {
  beforeEach(() => {
    delete process.env.GMFT_DRY;
    vi.mocked(run).mockReset();
    vi.mocked(assertBinary).mockReset();
  });

  it('registers with all high-friction markers and typeToConfirm=attack', () => {
    expect(evilTwinTool.name).toBe('evil_twin');
    expect(evilTwinTool.category).toBe('binary');
    expect(evilTwinTool.flags).toEqual(
      expect.arrayContaining(['destructive', 'requiresElevation']),
    );
    expect(evilTwinTool.typeToConfirm).toBe('attack');
  });

  it('does NOT invoke runner in dry mode', async () => {
    process.env.GMFT_DRY = '1';
    const out = await evilTwinTool.run(
      {
        targetBssid: 'AA:BB:CC:DD:EE:FF',
        targetEssid: 'CorpWiFi',
        interface: 'wlan0',
        channel: 6,
      },
      {} as any,
    );
    expect(out.dryRun).toBe(true);
    expect(out.fluxionArgs).toContain('CorpWiFi');
    expect(out.findings).toEqual([]);
    expect(vi.mocked(run)).not.toHaveBeenCalled();
    expect(vi.mocked(assertBinary)).not.toHaveBeenCalled();
  });

  it('dry mode does not enforce fluxion prereq', async () => {
    process.env.GMFT_DRY = '1';
    // assertBinary would throw — but dry mode never calls it.
    vi.mocked(assertBinary).mockImplementation(() => {
      throw new Error('fluxion not found on PATH');
    });
    const out = await evilTwinTool.run(
      {
        targetBssid: 'AA:BB:CC:DD:EE:FF',
        targetEssid: 'CorpWiFi',
        interface: 'wlan0',
        channel: 6,
      },
      {} as any,
    );
    expect(out.dryRun).toBe(true);
  });

  it('dry mode computes correct fluxion argv', async () => {
    process.env.GMFT_DRY = '1';
    const out = await evilTwinTool.run(
      {
        targetBssid: 'AA:BB:CC:DD:EE:FF',
        targetEssid: 'CorpWiFi',
        interface: 'wlan0',
        channel: 6,
      },
      {} as any,
    );
    expect(out.fluxionArgs).toEqual([
      'sudo',
      './fluxion.sh',
      '-i',
      '--essid',
      'CorpWiFi',
      '--bssid',
      'AA:BB:CC:DD:EE:FF',
      '--channel',
      '6',
      '--interface',
      'wlan0',
    ]);
    expect(out.tmuxSession).toBeUndefined();
  });
});
