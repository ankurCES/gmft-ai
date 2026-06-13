import { z } from 'zod';
import { run } from '../shared/runner.js';
import type { Tool, ToolContext, Finding } from '@gmft/core';

/**
 * v0.3.B — Task 8 (wifi recon expansion). aircrack is a thin wrapper
 * around `airodump-ng` that captures the AP + client table to CSV
 * for a bounded duration and returns the parsed rows.
 *
 * Host-only: airodump-ng needs raw 802.11 frames. The runner picks
 * host mode automatically when no image is specified.
 *
 * airodump-ng writes two CSV files into its output prefix:
 *   <prefix>-01.csv  — APs (BSSID, channel, signal, encryption, ESSID, ...)
 *   <prefix>-01.csv  — clients (a second section in the same file)
 *
 * The CSV is comma-separated with quoted fields. The two sections
 * are separated by a blank line, and the second section's first
 * column is "Station MAC" instead of "BSSID".
 *
 * Output severity:
 *   - WEP AP                  -> high
 *   - OPEN AP                 -> medium
 *   - WPA AP (WPA/WPA2/WPA3)  -> info
 *   - Associated client       -> info
 */
export const AircrackInput = z.object({
  target: z
    .string()
    .min(1)
    .describe('Capture interface (e.g. "wlan0mon"). Chokepoint slug-safe.'),
  duration: z
    .number()
    .int()
    .min(5)
    .max(600)
    .default(30)
    .describe('Capture duration in seconds (5-600, default 30).'),
  channel: z
    .number()
    .int()
    .min(1)
    .max(165)
    .optional()
    .describe('Lock to a specific channel; default = hop.'),
  outputPrefix: z
    .string()
    .default('/tmp/gmft-aircrack')
    .describe('File prefix for airodump CSV output. The "-01.csv" suffix is added by airodump itself.'),
});
export type AircrackInputT = z.infer<typeof AircrackInput>;

export const AircrackAp = z.object({
  bssid: z.string(),
  essid: z.string().optional(),
  channel: z.number().int().optional(),
  privacy: z.string().optional(),
  power: z.number().int().optional(),
});
export type AircrackApT = z.infer<typeof AircrackAp>;

export const AircrackClient = z.object({
  mac: z.string(),
  apBssid: z.string().optional(),
  power: z.number().int().optional(),
});
export type AircrackClientT = z.infer<typeof AircrackClient>;

export const AircrackOutput = z.object({
  findings: z.array(z.any()),
  aps: z.array(AircrackAp),
  clients: z.array(AircrackClient),
  duration: z.number().int().nonnegative(),
  dryRun: z.boolean(),
  mode: z.enum(['host', 'host+landlock', 'host+seccomp', 'host+landlock+seccomp', 'docker']),
  fellBack: z.boolean(),
  durationMs: z.number().int().nonnegative(),
});
export type AircrackOutputT = z.infer<typeof AircrackOutput>;

/**
 * Parse airodump-ng CSV output. The file contains:
 *   line 1: header row (BSSID, First time seen, Last time seen, channel, Speed, ...)
 *   lines 2..N: AP rows
 *   blank line
 *   header row 2 (Station MAC, First time seen, ...)
 *   lines: client rows
 *
 * Some rows may have empty leading fields. We split on the first
 * comma group to get BSSID / Station MAC and read the rest positionally.
 */
export function parseAirodumpCsv(csv: string): { aps: AircrackApT[]; clients: AircrackClientT[] } {
  const aps: AircrackApT[] = [];
  const clients: AircrackClientT[] = [];
  const lines = csv.split('\n');
  let section: 'aps' | 'clients' = 'aps';

  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (line.trim() === '') {
      // Blank line separates AP section from client section.
      section = 'clients';
      continue;
    }
    // Skip header rows: BSSID / Station MAC column header.
    if (/^BSSID,/.test(line)) continue;
    if (/^Station MAC,/.test(line)) continue;

    // Split on commas but keep quoted fields intact, then trim
    // whitespace from each field. airodump emits "field, " (with a
    // trailing space after the comma) for readability, so the trim
    // is essential.
    const fields = line.split(',').map((f) => {
      const unquoted = f.replace(/^"|"$/g, '');
      return unquoted.trim();
    });
    if (fields.length < 1 || !fields[0]) continue;

    if (section === 'aps') {
      // Layout (with positional indices, 0-based, per airodump-ng's
      // own header):
      //   0 BSSID, 1 First time seen, 2 Last time seen, 3 channel,
      //   4 Speed, 5 Privacy, 6 Cipher, 7 Authentication, 8 Power,
      //   9 # beacons, 10 # IV, 11 LAN IP, 12 ID-length, 13 ESSID,
      //   14 Key
      const bssid = fields[0];
      const channel = fields[3] ? Number(fields[3]) : undefined;
      // Privacy: empty string is meaningful — it means "open network"
      // (no encryption). Use ?? undefined to preserve that, and let
      // the severity logic in aircrackToFindings match on ''.
      const privacy = fields[5] !== undefined && fields[5] !== null ? fields[5] : undefined;
      // Power: column 8 in standard output.
      const power = fields[8] && /^-?\d+$/.test(fields[8]) ? Number(fields[8]) : undefined;
      // ESSID is column 13. We pick the second-to-last non-empty
      // position defensively in case the trailing "Key" column is
      // omitted by older airodump versions.
      const essid = fields[13] !== undefined && fields[13] !== ''
        ? fields[13]
        : fields[fields.length - 1] && fields[fields.length - 1] !== fields[14]
        ? fields[fields.length - 1]
        : undefined;
      aps.push({ bssid, channel, privacy, power, essid });
    } else {
      // Client section: 0 Station MAC, 1 First time seen, 2 Last time seen,
      // 3 Power, 4 # packets, 5 BSSID (associated AP)
      const mac = fields[0];
      const power = fields[3] && /^-?\d+$/.test(fields[3]) ? Number(fields[3]) : undefined;
      const apBssid = fields[5] || undefined;
      clients.push({ mac, apBssid, power });
    }
  }

  return { aps, clients };
}

/**
 * Convert parsed airodump output into Finding records.
 *
 * Severity:
 *   - WEP -> high
 *   - OPEN (no privacy) -> medium
 *   - WPA/WPA2/WPA3 -> info
 *   - Client -> info
 */
export function aircrackToFindings(
  aps: AircrackApT[],
  clients: AircrackClientT[],
): Finding[] {
  const out: Finding[] = [];
  const now = Date.now();
  let n = 0;
  const slug = (s: string) => s.replace(/[^a-zA-Z0-9.-]/g, '-');

  for (const ap of aps) {
    const privacy = (ap.privacy ?? '').toUpperCase();
    let severity: Finding['severity'] = 'info';
    let suffix = '';
    if (privacy === '' || privacy === 'OPN' || privacy === 'OPEN') {
      severity = 'medium';
      suffix = ' (open network)';
    } else if (privacy.includes('WEP')) {
      severity = 'high';
      suffix = ' (WEP — broken encryption)';
    } else if (privacy) {
      suffix = ` (${privacy})`;
    }
    out.push({
      id: `aircrack-${n++}-${now}`,
      tool: 'aircrack',
      target: ap.bssid,
      title: `AP captured: ${ap.essid ?? '(hidden)'}${suffix}`,
      severity,
      description: `airodump captured AP ${ap.bssid}` +
        (ap.essid ? ` ESSID "${ap.essid}"` : ' (ESSID hidden)') +
        (ap.channel ? ` channel=${ap.channel}` : '') +
        (ap.privacy ? ` privacy=${ap.privacy}` : ' privacy=OPEN') +
        (ap.power !== undefined ? ` power=${ap.power}` : '') +
        '.',
      ts: now,
      meta: { slug: slug(ap.bssid), essid: ap.essid, channel: ap.channel, privacy: ap.privacy, power: ap.power },
    });
  }

  for (const c of clients) {
    out.push({
      id: `aircrack-${n++}-${now}`,
      tool: 'aircrack',
      target: c.mac,
      title: `Client captured: ${c.mac}${c.apBssid ? ` (associated to ${c.apBssid})` : ''}`,
      severity: 'info',
      description: `airodump captured client ${c.mac}` +
        (c.apBssid ? ` associated to AP ${c.apBssid}` : ' (probing / unassociated)') +
        (c.power !== undefined ? ` power=${c.power}` : '') +
        '.',
      ts: now,
      meta: { slug: slug(c.mac), apBssid: c.apBssid, power: c.power },
    });
  }

  return out;
}

export const aircrackTool: Tool<typeof AircrackInput, typeof AircrackOutput> = {
  name: 'aircrack',
  category: 'binary',
  description:
    'Run airodump-ng for N seconds and capture the AP + client table. ' +
    'Host-only (needs raw 802.11 frames). ' +
    'Emits one Finding per AP (severity bumped for OPEN / WEP) and per client.',
  input: AircrackInput,
  output: AircrackOutput,
  flags: ['targetRequired'],
  async run(input: AircrackInputT, _ctx: ToolContext): Promise<AircrackOutputT> {
    const parsed0 = AircrackInput.parse(input);

    // airodump-ng writes CSV to <prefix>-01.csv. We pass --write so
    // it creates the file. --output-format csv is the default.
    // --background isn't supported, so we use timeoutMs to cap the run.
    const argv = [
      'airodump-ng',
      parsed0.target,
      ...(parsed0.channel !== undefined ? ['-c', String(parsed0.channel)] : []),
      '-w',
      parsed0.outputPrefix,
      '--output-format',
      'csv',
    ];

    if (process.env.GMFT_DRY === '1') {
      return {
        findings: [],
        aps: [],
        clients: [],
        duration: parsed0.duration,
        dryRun: true,
        mode: 'host' as const,
        fellBack: false,
        durationMs: 0,
      };
    }

    // We use SIGINT (sent via the runner's timeout) so airodump flushes
    // its CSV buffers cleanly. timeoutMs is duration + 10s grace.
    const r = await run({ argv, timeoutMs: (parsed0.duration + 10) * 1000 });

    // airodump writes the file to disk; we read it back so we can
    // include only the CSV (not airodump's live terminal output).
    const fs = await import('node:fs/promises');
    const csvPath = `${parsed0.outputPrefix}-01.csv`;
    let csv = '';
    try {
      csv = await fs.readFile(csvPath, 'utf8');
    } catch {
      // If the file isn't there (e.g. no APs seen), fall back to
      // whatever was on stdout.
      csv = r.stdout;
    }

    const parsed = parseAirodumpCsv(csv);
    return {
      findings: aircrackToFindings(parsed.aps, parsed.clients),
      aps: parsed.aps,
      clients: parsed.clients,
      duration: parsed0.duration,
      dryRun: false,
      mode: r.mode,
      fellBack: r.fellBack,
      durationMs: r.durationMs,
    };
  },
};
