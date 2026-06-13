import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/shared/runner', () => ({
  run: vi.fn(),
}));

import { tools } from '../src/catalog.js';
import { wifiDeauthTool } from '../src/wifi/deauth.js';
import { wifiteScanTool } from '../src/wifi/wifite-scan.js';

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

  it('registers v0.3.B network + web + wifi tool additions', () => {
    const names = tools.map((t) => t.name);
    // 7 new network tools
    expect(names).toContain('masscan');
    expect(names).toContain('rustscan');
    expect(names).toContain('subfinder');
    expect(names).toContain('dnsrecon');
    expect(names).toContain('fierce');
    expect(names).toContain('enum4linux');
    expect(names).toContain('ldapsearch');
    // 3 new web tools
    expect(names).toContain('httpx');
    expect(names).toContain('wpscan');
    expect(names).toContain('snmpcheck');
    // 3 new wifi tools
    expect(names).toContain('bettercap');
    expect(names).toContain('aircrack');
    expect(names).toContain('kismet');
    // new report tool
    expect(names).toContain('report_pdf');

    // Categories should reflect the tool kind.
    expect(tools.find((t) => t.name === 'masscan')?.category).toBe('recon');
    expect(tools.find((t) => t.name === 'httpx')?.category).toBe('binary');
    expect(tools.find((t) => t.name === 'aircrack')?.category).toBe('binary');
    expect(tools.find((t) => t.name === 'report_pdf')?.category).toBe('file');
  });
});
