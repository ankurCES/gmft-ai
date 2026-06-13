import { z } from 'zod';
import { run } from '../shared/runner.js';
import type { Tool, ToolContext, Finding } from '@gmft/core';

/**
 * v0.3.B — Task 8 (wifi recon expansion). bettercap is a Swiss-army
 * network monitor / mitm framework. For wifi recon we use its
 * `wifi.recon` and `ble.recon` modules to discover APs, stations,
 * and BLE devices in the vicinity.
 *
 * Flags: targetRequired (the chokepoint's `^[a-zA-Z0-9._-]+$` check
 * requires a target string; we accept an interface name like
 * "wlan0mon" — the chokepoint does not validate the *meaning* of the
 * target, only its shape).
 *
 * bettercap MUST run on the host (not in docker) because it needs
 * raw 802.11 frames. The runner's host-mode fallback handles this
 * automatically when the wifi image is not available.
 *
 * Output format (bettercap default):
 *   [inf] wifi.ap "AA:BB:CC:DD:EE:FF" ssid:"CoffeeShop" ...
 *   [inf] wifi.client "AA:BB:CC:DD:EE:FF" ap:"11:22:33:44:55:66" ...
 *   [inf] ble.device "AA:BB:CC:DD:EE:FF" name:"Tile" ...
 *
 * We parse the `wifi.ap` and `ble.device` events and emit one
 * Finding per discovered entity.
 */
export const BettercapInput = z.object({
  target: z
    .string()
    .min(1)
    .describe('Capture interface (e.g. "wlan0mon"). The chokepoint will see this as a slug-safe target.'),
  duration: z
    .number()
    .int()
    .positive()
    .max(600)
    .default(30)
    .describe('How long to run recon in seconds (default 30, max 600).'),
  modules: z
    .array(z.enum(['wifi', 'ble']))
    .default(['wifi', 'ble'])
    .describe('Which recon modules to enable. Default: both.'),
});
export type BettercapInputT = z.infer<typeof BettercapInput>;

export const BettercapOutput = z.object({
  findings: z.array(z.any()),
  aps: z.array(
    z.object({
      bssid: z.string(),
      ssid: z.string().optional(),
      encryption: z.string().optional(),
      signal: z.number().int().optional(),
      clients: z.number().int().nonnegative(),
    }),
  ),
  bleDevices: z.array(
    z.object({
      mac: z.string(),
      name: z.string().optional(),
      rssi: z.number().int().optional(),
    }),
  ),
  duration: z.number().int().nonnegative(),
  dryRun: z.boolean(),
  raw: z.string().optional(),
  mode: z.enum(['host', 'host+landlock', 'host+seccomp', 'host+landlock+seccomp', 'docker']),
  fellBack: z.boolean(),
  durationMs: z.number().int().nonnegative(),
});
export type BettercapOutputT = z.infer<typeof BettercapOutput>;

const WIFI_AP_RE = /\[(?:inf|wrn)\]\s+wifi\.ap\s+"(?<bssid>[0-9A-Fa-f:]{17})"(?:\s+ssid:"(?<ssid>[^"]*)")?(?:\s+enc:"?(?<enc>[^"\s]+)"?)?(?:\s+signal:(?<signal>-?\d+))?/;
const WIFI_CLIENT_RE = /\[(?:inf|wrn)\]\s+wifi\.client\s+"(?<client>[0-9A-Fa-f:]{17})"\s+ap:"(?<ap>[0-9A-Fa-f:]{17})"/g;
const BLE_DEVICE_RE = /\[(?:inf|wrn)\]\s+ble\.device\s+"(?<mac>[0-9A-Fa-f:]{17})"(?:\s+name:"(?<name>[^"]*)")?(?:\s+rssi:(?<rssi>-?\d+))?/;

/**
 * Parse bettercap log output. Captures wifi.ap events, counts
 * wifi.client events per AP, and captures ble.device events.
 */
export function parseBettercapOutput(stdout: string): {
  aps: Map<string, { bssid: string; ssid?: string; encryption?: string; signal?: number; clients: number }>;
  bleDevices: Map<string, { mac: string; name?: string; rssi?: number }>;
} {
  const aps = new Map<
    string,
    { bssid: string; ssid?: string; encryption?: string; signal?: number; clients: number }
  >();
  const ble = new Map<string, { mac: string; name?: string; rssi?: number }>();

  for (const line of stdout.split('\n')) {
    const apMatch = line.match(WIFI_AP_RE);
    if (apMatch?.groups) {
      const { bssid, ssid, enc, signal } = apMatch.groups;
      if (bssid && !aps.has(bssid)) {
        aps.set(bssid, {
          bssid,
          ssid: ssid || undefined,
          encryption: enc || undefined,
          signal: signal ? Number(signal) : undefined,
          clients: 0,
        });
      }
      continue;
    }
    const bleMatch = line.match(BLE_DEVICE_RE);
    if (bleMatch?.groups) {
      const { mac, name, rssi } = bleMatch.groups;
      if (mac && !ble.has(mac)) {
        ble.set(mac, {
          mac,
          name: name || undefined,
          rssi: rssi ? Number(rssi) : undefined,
        });
      }
      continue;
    }
    // Count clients per AP. Match all client events line-by-line.
    const clientMatch = [...line.matchAll(WIFI_CLIENT_RE)];
    for (const m of clientMatch) {
      const ap = m.groups?.ap;
      if (ap && aps.has(ap)) {
        const apRec = aps.get(ap)!;
        apRec.clients += 1;
      }
    }
  }

  return { aps, bleDevices: ble };
}

/**
 * Convert parsed bettercap output into Finding records.
 *
 * Severity:
 *   - Open/unencrypted AP (enc="OPEN" or enc="OPN") -> medium
 *   - WEP AP -> high
 *   - Other AP -> info
 *   - BLE device -> info
 */
export function bettercapToFindings(
  parsed: ReturnType<typeof parseBettercapOutput>,
): Finding[] {
  const out: Finding[] = [];
  const now = Date.now();
  let n = 0;
  const slug = (s: string) => s.replace(/[^a-zA-Z0-9.-]/g, '-');

  for (const ap of parsed.aps.values()) {
    const enc = (ap.encryption ?? '').toUpperCase();
    let severity: Finding['severity'] = 'info';
    let titleSuffix = '';
    if (enc === 'OPEN' || enc === 'OPN' || enc === '') {
      severity = 'medium';
      titleSuffix = ' (open network)';
    } else if (enc.includes('WEP')) {
      severity = 'high';
      titleSuffix = ' (WEP — broken encryption)';
    } else if (enc.includes('WPA')) {
      titleSuffix = ` (${enc})`;
    }
    out.push({
      id: `bettercap-${n++}-${now}`,
      tool: 'bettercap',
      target: ap.bssid,
      title: `AP discovered: ${ap.ssid ?? '(hidden)'}${titleSuffix}`,
      severity,
      description: `bettercap discovered AP ${ap.bssid}` +
        (ap.ssid ? ` with SSID "${ap.ssid}"` : ' (SSID hidden)') +
        (ap.encryption ? ` encryption=${ap.encryption}` : '') +
        (ap.signal !== undefined ? ` signal=${ap.signal}` : '') +
        ` and ${ap.clients} client(s).`,
      ts: now,
      meta: { slug: slug(ap.bssid), ssid: ap.ssid, encryption: ap.encryption, signal: ap.signal, clients: ap.clients },
    });
  }

  for (const dev of parsed.bleDevices.values()) {
    out.push({
      id: `bettercap-${n++}-${now}`,
      tool: 'bettercap',
      target: dev.mac,
      title: `BLE device discovered: ${dev.name ?? '(unnamed)'}`,
      severity: 'info',
      description: `bettercap discovered BLE device ${dev.mac}` +
        (dev.name ? ` named "${dev.name}"` : '') +
        (dev.rssi !== undefined ? ` rssi=${dev.rssi}` : ''),
      ts: now,
      meta: { slug: slug(dev.mac), name: dev.name, rssi: dev.rssi },
    });
  }

  return out;
}

export const bettercapTool: Tool<typeof BettercapInput, typeof BettercapOutput> = {
  name: 'bettercap',
  category: 'binary',
  description:
    'Run bettercap wifi + BLE recon for N seconds. Host-only (needs raw 802.11 frames). ' +
    'Emits one Finding per discovered AP (severity bumped for open / WEP) and per BLE device.',
  input: BettercapInput,
  output: BettercapOutput,
  flags: ['targetRequired'],
  async run(input: BettercapInputT, _ctx: ToolContext): Promise<BettercapOutputT> {
    const parsed0 = BettercapInput.parse(input);
    const enableWifi = parsed0.modules.includes('wifi');
    const enableBle = parsed0.modules.includes('ble');

    // Build the bettercap -eval command. We use `events.stream` to print
    // structured events as they arrive, then sleep, then stop and quit.
    // The eval is a single string so the shell doesn't see a multi-line
    // script.
    const cmds: string[] = [];
    if (enableWifi) cmds.push('set wifi.interface ' + parsed0.target);
    if (enableBle) cmds.push('set ble.interface ' + parsed0.target);
    if (enableWifi) cmds.push('wifi.recon on');
    if (enableBle) cmds.push('ble.recon on');
    cmds.push('events.stream');
    cmds.push(`sleep ${parsed0.duration}`);
    cmds.push('events.stop');
    cmds.push('wifi.recon off');
    cmds.push('ble.recon off');
    cmds.push('quit');
    const evalExpr = cmds.join('; ');

    const argv = ['bettercap', '-eval', evalExpr, '-no-colors', '-silent'];

    if (process.env.GMFT_DRY === '1') {
      return {
        findings: [],
        aps: [],
        bleDevices: [],
        duration: parsed0.duration,
        dryRun: true,
        mode: 'host' as const,
        fellBack: false,
        durationMs: 0,
      };
    }

    // Host-only: bettercap needs raw 802.11 frames which docker cannot
    // provide. We pass no `image` so the runner picks host mode.
    const r = await run({ argv, timeoutMs: (parsed0.duration + 30) * 1000 });
    const parsed = parseBettercapOutput(r.stdout);
    return {
      findings: bettercapToFindings(parsed),
      aps: [...parsed.aps.values()],
      bleDevices: [...parsed.bleDevices.values()],
      duration: parsed0.duration,
      dryRun: false,
      raw: r.stdout,
      mode: r.mode,
      fellBack: r.fellBack,
      durationMs: r.durationMs,
    };
  },
};
