import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/shared/runner', () => ({
  run: vi.fn(),
}));

import {
  snmpcheckTool,
  parseSnmpcheckOutput,
  snmpcheckToFindings,
} from '../../src/web/snmpcheck.js';
import { run } from '../../src/shared/runner.js';

const SAMPLE = `
snmpcheck v1.9 - SNMP arbitrary cause read
[*] Try to connect to 192.168.1.1
[*] Connected to 192.168.1.1

[*] System information:

  Hostname:               router
  Description:            Linux 3.10.0
  Contact:                admin@example.com
  Location:               Server room
  Uptime:                 12 days
  Motd:                   -

[*] Network information:

  IP forwarding enabled: YES

[*] Network interfaces:

  Interface:        [ up ] eth0
  Mac Address:      aa:bb:cc:dd:ee:ff
  IP address:       192.168.1.1
  Netmask:          255.255.255.0

  Interface:        [ down ] eth1
  Mac Address:      11:22:33:44:55:66
  IP address:       10.0.0.1
  Netmask:          255.255.255.0

[*] Network IP:

  IP forwarding enabled: YES
  Default TTL: 64

[*] TCP connections and listening ports:

  22 (ssh)  LISTEN
  80 (http) LISTEN
  443 (https) LISTEN

[*] Processes:

  1: init
  100: sshd
`;

describe('snmpcheck tool', () => {
  beforeEach(() => {
    vi.mocked(run).mockReset();
    vi.mocked(run).mockResolvedValue({
      exitCode: 0,
      stdout: SAMPLE,
      stderr: '',
      durationMs: 2000,
      mode: 'host',
      fellBack: false,
    });
  });

  describe('parseSnmpcheckOutput', () => {
    it('extracts system info fields', () => {
      const p = parseSnmpcheckOutput(SAMPLE);
      expect(p.systemInfo).toEqual({
        Hostname: 'router',
        Description: 'Linux 3.10.0',
        Contact: 'admin@example.com',
        Location: 'Server room',
        Uptime: '12 days',
        Motd: '-',
      });
    });

    it('extracts network interfaces', () => {
      const p = parseSnmpcheckOutput(SAMPLE);
      expect(p.interfaces).toEqual(['[ up ] eth0', '[ down ] eth1']);
    });

    it('extracts listening TCP ports', () => {
      const p = parseSnmpcheckOutput(SAMPLE);
      expect(p.listeningPorts).toEqual([
        '22 (ssh)  LISTEN',
        '80 (http) LISTEN',
        '443 (https) LISTEN',
      ]);
    });

    it('preserves raw output', () => {
      const p = parseSnmpcheckOutput(SAMPLE);
      expect(p.raw).toBe(SAMPLE);
    });

    it('handles empty output', () => {
      const p = parseSnmpcheckOutput('');
      expect(p.systemInfo).toEqual({});
      expect(p.interfaces).toEqual([]);
      expect(p.listeningPorts).toEqual([]);
    });
  });

  describe('snmpcheckToFindings', () => {
    it('emits a high-severity finding when community string is accepted', () => {
      const p = parseSnmpcheckOutput(SAMPLE);
      const findings = snmpcheckToFindings(p, 'public', '192.168.1.1');
      const auth = findings.find((f) => f.title.includes('community string'));
      expect(auth).toBeDefined();
      expect(auth!.severity).toBe('high');
      expect(auth!.target).toBe('192.168.1.1');
      expect(auth!.evidence).toBe('public');
    });

    it('emits info findings for each system info field', () => {
      const p = parseSnmpcheckOutput(SAMPLE);
      const findings = snmpcheckToFindings(p, 'public', '192.168.1.1');
      const hostname = findings.find((f) => f.title === 'SNMP Hostname: router');
      expect(hostname).toBeDefined();
      expect(hostname!.severity).toBe('info');
      const desc = findings.find((f) => f.title === 'SNMP Description: Linux 3.10.0');
      expect(desc).toBeDefined();
    });

    it('emits info findings for each network interface', () => {
      const p = parseSnmpcheckOutput(SAMPLE);
      const findings = snmpcheckToFindings(p, 'public', '192.168.1.1');
      const ifaces = findings.filter((f) => f.title.startsWith('SNMP interface'));
      expect(ifaces).toHaveLength(2);
      expect(ifaces.every((i) => i.severity === 'info')).toBe(true);
    });

    it('emits info findings for each listening port', () => {
      const p = parseSnmpcheckOutput(SAMPLE);
      const findings = snmpcheckToFindings(p, 'public', '192.168.1.1');
      const ports = findings.filter((f) => f.title.startsWith('SNMP listening port'));
      expect(ports).toHaveLength(3);
    });

    it('does not emit a high-severity auth finding when no system info was discovered', () => {
      const p = parseSnmpcheckOutput('[*] No answer from 10.0.0.99');
      const findings = snmpcheckToFindings(p, 'public', '10.0.0.99');
      const auth = findings.find((f) => f.severity === 'high');
      expect(auth).toBeUndefined();
    });
  });

  describe('tool metadata', () => {
    it('registers with the right name, category, and flags', () => {
      expect(snmpcheckTool.name).toBe('snmpcheck');
      expect(snmpcheckTool.category).toBe('binary');
      expect(snmpcheckTool.flags).toEqual([]);
    });
  });

  describe('run()', () => {
    it('invokes the runner with the right argv and returns findings', async () => {
      const out = await snmpcheckTool.run(
        { target: '192.168.1.1', port: 161, community: 'public', timeout: 5 },
        {} as any,
      );
      expect(out.findings.length).toBeGreaterThan(0);
      expect(out.community).toBe('public');
      expect(out.systemInfo?.Hostname).toBe('router');
      expect(out.mode).toBe('host');
      expect(vi.mocked(run)).toHaveBeenCalledWith(
        expect.objectContaining({
          argv: expect.arrayContaining([
            'snmpcheck',
            '-t',
            '192.168.1.1',
            '-p',
            '161',
            '-c',
            'public',
            '-w',
            '5',
          ]),
        }),
      );
    });

    it('uses default community and port when not provided', async () => {
      await snmpcheckTool.run({ target: '10.0.0.1' }, {} as any);
      const call = vi.mocked(run).mock.calls[0][0];
      expect(call.argv).toContain('-c');
      expect(call.argv).toContain('public');
      expect(call.argv).toContain('-p');
      expect(call.argv).toContain('161');
    });
  });
});
