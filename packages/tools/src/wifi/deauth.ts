import { z } from 'zod';
import { run } from '../shared/runner';
import type { Tool, ToolContext, Finding } from '@gmft/core';

/**
 * wifi_deauth — aireplay-ng -0 wrapper. Sends 802.11 deauthentication
 * frames to a target AP. This is a HIGH-FRICTION tool: it can knock
 * clients off a network and is the first step of most WPA handshakes
 * captures. Requires:
 *   - a monitor-mode interface (default `wlan0mon`)
 *   - root or `GMFT_ALLOW_ELEVATION=true`
 *   - the operator to literally type the word "attack" to confirm
 *
 * Phase 6 — see docs/superpowers/specs/2026-06-17-gmft-phase6-design.md §3.
 *
 * Notes on the target arg:
 *   - BSSIDs contain `:` characters, which the chokepoint's `checkTarget`
 *     regex (`^[a-zA-Z0-9._-]+$`) explicitly rejects. So this tool does
 *     NOT set `targetRequired`; the BSSID is validated by zod's regex
 *     below, and per-tool approval (`destructive` + `typeToConfirm`)
 *     covers the chokepoint story for this tool.
 *   - If we later want a chokepoint-level denylist of "known BSSIDs to
 *     never attack," we'll add a separate `checkBssid` rule rather
 *     than try to bend `checkTarget`'s regex to accept colons.
 */
export const WifiDeauthInput = z.object({
  target: z
    .string()
    .regex(
      /^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}$/,
      'target must be a BSSID in aa:bb:cc:dd:ee:ff form',
    )
    .describe('Target AP BSSID (e.g. "AA:BB:CC:DD:EE:FF")'),
  clientMac: z
    .string()
    .regex(/^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}$/)
    .optional()
    .describe('Specific client MAC to deauth; omit = broadcast deauth (default)'),
  count: z
    .number()
    .int()
    .min(0)
    .default(10)
    .describe('Number of deauth frames to send; 0 = continuous'),
  iface: z
    .string()
    .min(1)
    .default('wlan0mon')
    .describe('Monitor-mode interface (default wlan0mon)'),
});
export type WifiDeauthInputT = z.infer<typeof WifiDeauthInput>;

export const WifiDeauthOutput = z.object({
  framesSent: z.number().int().nonnegative(),
  apBssid: z.string(),
  clientMac: z.string().optional(),
  iface: z.string(),
  count: z.number().int().nonnegative(),
  mode: z.enum(['host', 'host+landlock', 'host+seccomp', 'host+landlock+seccomp', 'docker']),
  fellBack: z.boolean(),
  durationMs: z.number().int().nonnegative(),
  dryRun: z.boolean(),
  raw: z.string().optional(),
  findings: z.array(z.any()),
});
export type WifiDeauthOutputT = z.infer<typeof WifiDeauthOutput>;

const DEAUTH_RE = /(\d+)\s+(?:packets?|frames?)\s+sent/i;

function parseFramesSent(stdout: string): number {
  const m = DEAUTH_RE.exec(stdout);
  return m ? Number(m[1]) : 0;
}

export const wifiDeauthTool: Tool<typeof WifiDeauthInput, typeof WifiDeauthOutput> = {
  name: 'wifi_deauth',
  category: 'binary',
  description:
    'Send 802.11 deauthentication frames to a target AP via aireplay-ng -0. ' +
    'DESTRUCTIVE + ELEVATED. The operator must type "attack" to confirm. ' +
    'Use sparingly — broadcast deauths disrupt all clients on the AP.',
  input: WifiDeauthInput,
  output: WifiDeauthOutput,
  flags: ['destructive', 'requiresElevation'],
  typeToConfirm: 'attack',
  async run(input: WifiDeauthInputT, _ctx: ToolContext): Promise<WifiDeauthOutputT> {
    // Apply zod defaults (count, iface) before using.
    const parsed = WifiDeauthInput.parse(input);

    // Build aireplay-ng argv. aireplay -0 takes either a count or 0
    // for "infinite / until SIGINT." We pass the count through verbatim
    // so 0 means "continuous" (the binary's own semantics).
    const argv = [
      'aireplay-ng',
      '-0',
      String(parsed.count),
      ...(parsed.clientMac ? ['-c', parsed.clientMac] : []),
      '-a',
      parsed.target,
      parsed.iface,
    ];

    if (process.env.GMFT_DRY === '1') {
      return {
        framesSent: 0,
        apBssid: parsed.target,
        clientMac: parsed.clientMac,
        iface: parsed.iface,
        count: parsed.count,
        mode: 'host' as const,
        fellBack: false,
        durationMs: 0,
        dryRun: true,
        findings: [] as Finding[],
      };
    }

    // Real mode: run inside the gmft-wifi image (aircrack-ng + aireplay-ng).
    // We don't pre-flight `assertBinary('aireplay-ng')` here because
    // in real deployments aireplay only works on the host with a
    // wifi adapter (it can't see monitor-mode interfaces inside a
    // container). The runner's host-mode fallback will pick that up
    // automatically if docker isn't available.
    const r = await run({
      argv,
      image: 'gmft/wifi:0.1',
      timeoutMs: 60_000,
    });

    const framesSent = parseFramesSent(r.stdout);

    // The "finding" is the deauth itself — an action record, not a vuln.
    // We emit a single low-severity finding so the audit log shows
    // what AP was attacked. (Future versions could escalate based on
    // context — for now, deauth is informational.)
    const finding: Finding = {
      id: `wifi-deauth-${parsed.target.replace(/[^0-9A-Fa-f]/g, '')}-${Date.now()}`,
      tool: 'wifi_deauth',
      target: parsed.target,
      severity: 'low',
      title: `Deauth sent to AP ${parsed.target} (${framesSent} frames)`,
      description: `Sent ${parsed.count} deauth frames to ${parsed.target} on ${parsed.iface}${
        parsed.clientMac ? ` targeting client ${parsed.clientMac}` : ' (broadcast)'
      }.`,
      evidence: r.stdout.slice(0, 200),
      ts: Date.now(),
    };

    return {
      framesSent,
      apBssid: parsed.target,
      clientMac: parsed.clientMac,
      iface: parsed.iface,
      count: parsed.count,
      mode: r.mode,
      fellBack: r.fellBack,
      durationMs: r.durationMs,
      dryRun: false,
      raw: r.stdout,
      findings: [finding],
    };
  },
};
