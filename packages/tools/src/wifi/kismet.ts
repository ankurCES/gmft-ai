import { z } from 'zod';
import { run } from '../shared/runner.js';
import type { Tool, ToolContext, Finding } from '@gmft/core';

/**
 * v0.3.B — Task 8 (wifi recon expansion). kismet is a passive
 * 802.11 / bluetooth / adsb sensor. The wrapper spawns `kismet -t
 * <iface>` for a bounded duration, lets it write its standard
 * `.kismet` JSON log, then reads the log back and converts the
 * discovered devices to Findings.
 *
 * Host-only: kismet needs raw 802.11 frames. The runner picks host
 * mode automatically when no image is specified.
 *
 * kismet's `.kismet` log format is JSON-Lines (NDJSON) where each
 * line is one of:
 *   - `{"type":"kismet_log_version", ...}` (preamble)
 *   - `{"type":"kismet_log_device", "kismet_log_device_record": {...}}`
 *   - `{"type":"kismet_log_data", ...}` (per-packet records, not
 *     useful for recon)
 *   - close/flush markers
 *
 * Inside `kismet_log_device_record`, the device's properties use
 * dotted keys like:
 *   - kismet.device.base.macaddr  (the BSSID or client MAC)
 *   - kismet.device.base.name     (the SSID for wifi APs)
 *   - kismet.device.base.type     ("wi-fi", "bluetooth", etc.)
 *   - kismet.device.base.signal   (last seen signal, dBm)
 *   - kismet.device.base.freq     (frequency in kHz)
 *   - kismet.device.base.channel  ("6", "36", etc.)
 *   - kismet.device.base.crypt     (set of cipher strings)
 *
 * For wifi APs we also want to know the encryption. kismet stores
 * the SSID/crypt in a nested record keyed by phy type:
 *   - kismet.device.base.dot11.device.advertised_ssid_map
 *       (a map of SSID -> {crypt: set, ...})
 *
 * We pick the first SSID we find and use its crypt set to decide
 * the encryption tier.
 *
 * Severity:
 *   - WEP crypt -> high
 *   - OPEN / no crypt -> medium
 *   - WPA/WPA2/WPA3 -> info
 *   - Non-wifi device (bluetooth, etc.) -> info
 */
export const KismetInput = z.object({
  target: z
    .string()
    .min(1)
    .describe('Capture source (e.g. "wlan0mon"). Chokepoint slug-safe.'),
  duration: z
    .number()
    .int()
    .min(5)
    .max(600)
    .default(30)
    .describe('Capture duration in seconds (5-600, default 30).'),
  logPrefix: z
    .string()
    .default('/tmp/gmft-kismet')
    .describe('File prefix for kismet log output. The ".kismet" suffix is added by kismet itself.'),
});
export type KismetInputT = z.infer<typeof KismetInput>;

export const KismetDevice = z.object({
  mac: z.string(),
  name: z.string().optional(),
  type: z.string().optional(),
  signal: z.number().int().optional(),
  channel: z.string().optional(),
  crypt: z.array(z.string()).optional(),
});
export type KismetDeviceT = z.infer<typeof KismetDevice>;

export const KismetOutput = z.object({
  findings: z.array(z.any()),
  devices: z.array(KismetDevice),
  duration: z.number().int().nonnegative(),
  dryRun: z.boolean(),
  mode: z.enum(['host', 'host+landlock', 'host+seccomp', 'host+landlock+seccomp', 'docker']),
  fellBack: z.boolean(),
  durationMs: z.number().int().nonnegative(),
});
export type KismetOutputT = z.infer<typeof KismetOutput>;

/**
 * Parse a kismet .kismet log (JSON-Lines NDJSON format). Returns
 * the deduplicated list of devices. Devices are keyed by MAC —
 * kismet emits a separate log line per device update, so the same
 * MAC can appear multiple times. We keep the last-seen record.
 */
export function parseKismetLog(text: string): KismetDeviceT[] {
  const byMac = new Map<string, KismetDeviceT>();

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec.type !== 'kismet_log_device') continue;
    const dev = rec.kismet_log_device_record;
    if (!dev) continue;
    const mac = dev['kismet.device.base.macaddr'];
    if (!mac) continue;
    const type = dev['kismet.device.base.type'];
    const name = dev['kismet.device.base.name'] || undefined;
    const signalRaw = dev['kismet.device.base.signal'];
    const signal =
      typeof signalRaw === 'number'
        ? signalRaw
        : typeof signalRaw === 'object' && signalRaw !== null
        ? signalRaw.last_signal_dbm
        : undefined;
    const channel = dev['kismet.device.base.channel'] || undefined;
    // Encryption: pull the first advertised SSID's crypt set.
    const ssidMap = dev['kismet.device.base.dot11.device.advertised_ssid_map'];
    let crypt: string[] | undefined;
    if (ssidMap && typeof ssidMap === 'object') {
      for (const ssid of Object.keys(ssidMap)) {
        const entry = ssidMap[ssid];
        if (entry && entry.crypt && typeof entry.crypt === 'object') {
          crypt = Object.keys(entry.crypt);
          break;
        }
      }
    }
    byMac.set(mac, {
      mac,
      name: name && name.length > 0 ? name : undefined,
      type: typeof type === 'string' ? type : undefined,
      signal: typeof signal === 'number' ? Math.round(signal) : undefined,
      channel: typeof channel === 'string' ? channel : undefined,
      crypt,
    });
  }

  return [...byMac.values()];
}

/**
 * Convert parsed kismet devices into Finding records.
 *
 * Severity:
 *   - Wifi AP with WEP crypt       -> high
 *   - Wifi AP with OPEN crypt      -> medium
 *   - Wifi AP with WPA/WPA2/WPA3   -> info
 *   - Other device (btle, etc.)    -> info
 */
export function kismetToFindings(devices: KismetDeviceT[]): Finding[] {
  const out: Finding[] = [];
  const now = Date.now();
  let n = 0;
  const slug = (s: string) => s.replace(/[^a-zA-Z0-9.-]/g, '-');

  for (const d of devices) {
    const isWifi = d.type === 'wi-fi' || d.type === 'Wi-Fi' || d.type === 'wifi';
    let severity: Finding['severity'] = 'info';
    let titleSuffix = '';
    if (isWifi && d.crypt) {
      const crypt = d.crypt.map((c) => c.toUpperCase()).join(',');
      if (crypt.includes('WEP')) {
        severity = 'high';
        titleSuffix = ' (WEP — broken encryption)';
      } else if (crypt.includes('OPEN') || crypt === '' || crypt === 'NONE') {
        severity = 'medium';
        titleSuffix = ' (open network)';
      } else if (crypt) {
        titleSuffix = ` (${crypt})`;
      }
    } else if (isWifi && !d.crypt) {
      // No crypt info — wifi AP without encryption details
      severity = 'medium';
      titleSuffix = ' (no encryption info)';
    }

    const titlePrefix = isWifi ? 'AP seen' : `${d.type ?? 'Device'} seen`;
    out.push({
      id: `kismet-${n++}-${now}`,
      tool: 'kismet',
      target: d.mac,
      title: `${titlePrefix}: ${d.name ?? '(unnamed)'}${titleSuffix}`,
      severity,
      description: `kismet discovered device ${d.mac}` +
        (d.name ? ` named "${d.name}"` : '') +
        (isWifi ? ' (Wi-Fi)' : d.type ? ` (${d.type})` : '') +
        (d.signal !== undefined ? ` signal=${d.signal}` : '') +
        (d.channel ? ` channel=${d.channel}` : '') +
        (d.crypt && d.crypt.length > 0 ? ` crypt=${d.crypt.join(',')}` : '') +
        '.',
      ts: now,
      meta: { slug: slug(d.mac), name: d.name, type: d.type, signal: d.signal, channel: d.channel, crypt: d.crypt },
    });
  }

  return out;
}

export const kismetTool: Tool<typeof KismetInput, typeof KismetOutput> = {
  name: 'kismet',
  category: 'binary',
  description:
    'Run kismet for N seconds and parse the .kismet JSON log for discovered devices. ' +
    'Host-only (needs raw 802.11 frames). ' +
    'Emits one Finding per device (severity bumped for OPEN / WEP Wi-Fi APs).',
  input: KismetInput,
  output: KismetOutput,
  flags: ['targetRequired'],
  async run(input: KismetInputT, _ctx: ToolContext): Promise<KismetOutputT> {
    const parsed0 = KismetInput.parse(input);

    // kismet options used here:
    //   -t <source>          : source interface / capture type
    //   --no-daemonize       : run in foreground (so timeout can SIGINT)
    //   --no-logging         : disable kismetdb / pcap logging
    //   --log-prefix <path>  : base path for .kismet / .pcap log
    //   --silent             : less stdout chatter
    // We DO need logging on for the .kismet file to exist, so we
    // drop --no-logging and rely on --log-prefix to control the
    // destination.
    const argv = [
      'kismet',
      '-t',
      parsed0.target,
      '--no-daemonize',
      '--log-prefix',
      parsed0.logPrefix,
      '--silent',
    ];

    if (process.env.GMFT_DRY === '1') {
      return {
        findings: [],
        devices: [],
        duration: parsed0.duration,
        dryRun: true,
        mode: 'host' as const,
        fellBack: false,
        durationMs: 0,
      };
    }

    // timeoutMs is duration + 10s grace. The runner sends SIGINT
    // on timeout, which kismet handles gracefully (flushes its log
    // files).
    const r = await run({ argv, timeoutMs: (parsed0.duration + 10) * 1000 });

    // kismet writes <logPrefix>-<sanitized-source>.kismet; we
    // also accept the plain <logPrefix>.kismet form as a fallback.
    const fs = await import('node:fs/promises');
    const safeSource = parsed0.target.replace(/[^a-zA-Z0-9._-]/g, '_');
    const candidates = [
      `${parsed0.logPrefix}-${safeSource}.kismet`,
      `${parsed0.logPrefix}.kismet`,
    ];
    let text = '';
    for (const path of candidates) {
      try {
        text = await fs.readFile(path, 'utf8');
        if (text) break;
      } catch {
        // try next
      }
    }
    if (!text) {
      // Fall back to whatever was on stdout (kismet does emit some
      // log lines there too).
      text = r.stdout;
    }

    const devices = parseKismetLog(text);
    return {
      findings: kismetToFindings(devices),
      devices,
      duration: parsed0.duration,
      dryRun: false,
      mode: r.mode,
      fellBack: r.fellBack,
      durationMs: r.durationMs,
    };
  },
};
