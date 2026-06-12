import { z } from 'zod';
import { run } from '../shared/runner.js';
import type { Tool, ToolContext, Finding } from '@gmft/core';

/**
 * wifite_scan — enumerate nearby wireless access points.
 *
 * Wraps `wifite` (the de-facto wifi auditor) in PASSIVE mode
 * (`--nodeauths`) for a bounded duration and parses the discovered
 * AP list out of its stdout. No attacks fire — wifite's default
 * behavior is to attack discovered targets, so we pass `--wpat` with
 * a very short timeout to fail any subsequent attack phase, and
 * `--no-pixie --no-wps` to keep the attack surface narrow.
 *
 * Phase 6 — see docs/superpowers/specs/2026-06-17-gmft-phase6-design.md §3.
 *
 * Why `destructive: true` on a scan-only tool:
 *   The wifite binary IS capable of attacks, and the operator's
 *   mental model is "wifi tools need elevation + attack confirmation."
 *   A scan that accidentally auto-attacks is the failure mode we're
 *   guarding against. Documented in the description.
 *
 * Why no `targetRequired` flag:
 *   Same reason as wifi_deauth — wifite operates on radio interfaces,
 *   not specific targets. No chokepoint-level target validation needed.
 */
export const WifiteScanInput = z.object({
  iface: z
    .string()
    .min(1)
    .default('wlan0mon')
    .describe('Monitor-mode interface (default wlan0mon)'),
  duration: z
    .number()
    .int()
    .min(5)
    .max(600)
    .default(60)
    .describe('Scan duration in seconds (5-600, default 60)'),
});
export type WifiteScanInputT = z.infer<typeof WifiteScanInput>;

export const WifiteScanAp = z.object({
  bssid: z.string(),
  essid: z.string(),
  channel: z.number().int().positive(),
  encryption: z.string(),
  power: z.number().int().optional(),
});
export type WifiteScanApT = z.infer<typeof WifiteScanAp>;

export const WifiteScanOutput = z.object({
  aps: z.array(WifiteScanAp),
  iface: z.string(),
  duration: z.number().int().positive(),
  mode: z.enum(['host', 'host+landlock', 'host+seccomp', 'host+landlock+seccomp', 'docker']),
  fellBack: z.boolean(),
  durationMs: z.number().int().nonnegative(),
  dryRun: z.boolean(),
  raw: z.string().optional(),
  findings: z.array(z.any()),
});
export type WifiteScanOutputT = z.infer<typeof WifiteScanOutput>;

/**
 * Parse airodump-ng style output that wifite invokes internally.
 * The format (with column headers) is:
 *
 *   BSSID              PWR  Beacons    #Data, #/s  CH   MB   ENC   CIPHER AUTH ESSID
 *   AA:BB:CC:DD:EE:FF  -45       5        0    0   6  54e  WPA2  CCMP   PSK  CorpWiFi
 *   11:22:33:44:55:66  -72      12        0    0  11  54e  OPN               FreeWiFi
 *
 * The header line is optional; the parser works without it.
 */
export function parseAirodumpTable(stdout: string): WifiteScanApT[] {
  const out: WifiteScanApT[] = [];
  const seen = new Set<string>();
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Match the leading columns of an airodump-ng AP row:
    //   BSSID  PWR  Beacons  #Data  #/s  CH  MB  ENC
    // Header line ("BSSID              PWR  Beacons ...") and the
    // client-station table ("Station MAC ...") are skipped by the
    // BSSID regex (they don't start with a MAC).
    const m = /^((?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2})\s+(-?\d+)\s+\d+\s+\d+\s+\d+\s+(\d+)\s+\S+\s+(\S+)/.exec(
      trimmed,
    );
    if (!m) continue;
    const bssid = m[1]!.toUpperCase();
    if (seen.has(bssid)) continue;
    seen.add(bssid);
    // The trailing columns after ENC are CIPHER (e.g. "CCMP", "TKIP"),
    // AUTH (e.g. "PSK", "MGT", "OPN"), and ESSID. We split on 2+ spaces
    // and take the last segment. For hidden networks, ESSID is empty
    // and airodump shows a literal "<length: N>" — we normalize that
    // to "<hidden>".
    const tail = trimmed.slice(m[0].length).trim();
    const tailParts = tail.split(/\s{2,}/).filter(Boolean);
    const rawEssid = tailParts.length > 0 ? tailParts[tailParts.length - 1]! : '';
    const essid = rawEssid && !/^<length:\s*\d+>$/.test(rawEssid) ? rawEssid : '<hidden>';
    out.push({
      bssid,
      essid,
      channel: Number(m[3]),
      encryption: m[4]!,
      power: Number(m[2]),
    });
  }
  return out;
}

export const wifiteScanTool: Tool<typeof WifiteScanInput, typeof WifiteScanOutput> = {
  name: 'wifite_scan',
  category: 'binary',
  description:
    'Enumerate nearby wireless access points via wifite in passive mode. ' +
    'DESTRUCTIVE + ELEVATED (the wifite binary can attack; we keep it in scan-only mode). ' +
    'The operator must type "attack" to confirm. Pass `--nodeauths` semantics — no clients are deauthenticated.',
  input: WifiteScanInput,
  output: WifiteScanOutput,
  flags: ['destructive', 'requiresElevation'],
  typeToConfirm: 'attack',
  async run(input: WifiteScanInputT, _ctx: ToolContext): Promise<WifiteScanOutputT> {
    // Apply zod defaults (iface, duration) before using.
    const parsed = WifiteScanInput.parse(input);

    // wifite's attack phase has its own long timeouts (--wpat default
    // 500s). We override that with a value just slightly above our
    // scan duration so wifite doesn't continue attacking after the
    // scan completes. `--nodeauths` prevents any deauth; `--no-wps`
    // and `--no-pixie` disable WPS PIN/PixieDust attacks.
    const argv = [
      'wifite',
      '-i',
      parsed.iface,
      '--nodeauths',
      '--no-wps',
      '--no-pixie',
      '--wpat',
      String(parsed.duration + 5),
    ];

    if (process.env.GMFT_DRY === '1') {
      return {
        aps: [],
        iface: parsed.iface,
        duration: parsed.duration,
        mode: 'host' as const,
        fellBack: false,
        durationMs: 0,
        dryRun: true,
        findings: [] as Finding[],
      };
    }

    const r = await run({
      argv,
      image: 'gmft/wifi:0.1',
      timeoutMs: (parsed.duration + 30) * 1000,
    });

    const aps = parseAirodumpTable(r.stdout);

    // Emit one finding per discovered AP. Severity: 'info' for open
    // networks, 'low' for WEP/WPA so they show up in the default
    // severity filter.
    const findings: Finding[] = aps.map((ap) => ({
      id: `wifite-scan-${ap.bssid.replace(/[^0-9A-F]/g, '')}-${Date.now()}`,
      tool: 'wifite_scan',
      target: ap.bssid,
      severity: ap.encryption === 'OPN' ? 'info' : 'low',
      title: `AP ${ap.essid} (${ap.bssid}) on ch${ap.channel} [${ap.encryption}]`,
      description: `Discovered AP "${ap.essid}" with BSSID ${ap.bssid} on channel ${ap.channel}. Encryption: ${ap.encryption}.`,
      evidence: `power=${ap.power}dBm, channel=${ap.channel}`,
      ts: Date.now(),
    }));

    return {
      aps,
      iface: parsed.iface,
      duration: parsed.duration,
      mode: r.mode,
      fellBack: r.fellBack,
      durationMs: r.durationMs,
      dryRun: false,
      raw: r.stdout,
      findings,
    };
  },
};
