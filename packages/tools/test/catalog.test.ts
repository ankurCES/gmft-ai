import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/shared/runner', () => ({
  run: vi.fn(),
}));

import { tools } from '../src/catalog';
import { wifiDeauthTool } from '../src/wifi/deauth';
import { wifiteScanTool } from '../src/wifi/wifite-scan';

describe('tools catalog — wifi tools registered', () => {
  it('registers wifi_deauth and wifite_scan in the default tool list', () => {
    const names = tools.map((t) => t.name);
    expect(names).toContain('wifi_deauth');
    expect(names).toContain('wifite_scan');
    expect(names).toContain('report_write');

    const deauth = tools.find((t) => t.name === 'wifi_deauth');
    const scan = tools.find((t) => t.name === 'wifite_scan');
    const report = tools.find((t) => t.name === 'report_write');
    expect(deauth?.category).toBe('binary');
    expect(scan?.category).toBe('binary');
    expect(report?.category).toBe('file');
    expect(deauth?.flags).toEqual(
      expect.arrayContaining(['destructive', 'requiresElevation']),
    );
    expect(scan?.flags).toEqual(
      expect.arrayContaining(['destructive', 'requiresElevation']),
    );
    expect(report?.flags).toEqual(expect.arrayContaining(['destructive']));
  });

  it('exports the wifi tool definitions for direct import', () => {
    // The catalog exports them; consumers can use them by name or import directly.
    expect(wifiDeauthTool.name).toBe('wifi_deauth');
    expect(wifiteScanTool.name).toBe('wifite_scan');
  });
});
