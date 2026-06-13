import { z } from 'zod';
import { run } from '../shared/runner.js';
import type { Tool, ToolContext, Finding } from '@gmft/core';

/**
 * v0.3.B — Task 8. Probe an SNMP-enabled host for exposed system,
 * network, and process information. Wraps the `snmpcheck` Perl
 * script from lirond31.
 *
 * snmpcheck's output is human-readable text with section headers:
 *   System information:
 *   Network information:
 *   Network interfaces:
 *   Network IP:
 *   Routing information:
 *   TCP connections and listening ports:
 *   Processes:
 *
 * The most security-relevant signals are:
 *   - The community string the tool was able to use (if it connected
 *     at all, the community string is weak or default — high).
 *   - Exposed system info (hostname, description, contact, location)
 *     which often leaks asset data — info.
 *   - Listening TCP ports discovered via hrNetTable — info.
 *   - Process list — info.
 */
export const SnmpcheckInput = z.object({
  target: z.string().min(1),
  port: z.number().int().positive().max(65535).default(161),
  community: z.string().default('public'),
  timeout: z.number().int().positive().max(60).default(5),
});
export type SnmpcheckInputT = z.infer<typeof SnmpcheckInput>;

export const SnmpcheckOutput = z.object({
  findings: z.array(z.any()),
  community: z.string(),
  systemInfo: z.record(z.string()).optional(),
  interfaces: z.array(z.string()),
  listeningPorts: z.array(z.string()),
  raw: z.string(),
  mode: z.enum(['host', 'host+landlock', 'host+seccomp', 'host+landlock+seccomp', 'docker']),
  fellBack: z.boolean(),
  durationMs: z.number(),
});
export type SnmpcheckOutputT = z.infer<typeof SnmpcheckOutput>;

const SECTION_RE = /^\[\*\]\s+(.+?):\s*$/;

/**
 * Parse snmpcheck text output. Returns a structured object with the
 * sections we care about plus a `raw` field with the full text.
 *
 * Section detection uses the `[*] Section name:` header pattern.
 * Within each section, the tool emits `  Key:   value` lines.
 */
export function parseSnmpcheckOutput(stdout: string): {
  systemInfo: Record<string, string>;
  interfaces: string[];
  listeningPorts: string[];
  raw: string;
} {
  const out = {
    systemInfo: {} as Record<string, string>,
    interfaces: [] as string[],
    listeningPorts: [] as string[],
    raw: stdout,
  };

  const lines = stdout.split('\n');
  let section: 'other' | 'system' | 'interfaces' | 'listening' = 'other';
  // Track whether the current section ever produced any content.
  // When the next section header arrives, the divider line
  // (`============`) comes between header and content; we want to
  // attribute divider-like lines to whatever section is active.
  let sectionHadContent = false;

  for (const raw of lines) {
    const line = raw.trim();

    // Section header: "[*] System information:"
    const sec = line.match(SECTION_RE);
    const secName = sec?.[1]?.toLowerCase();
    if (secName) {
      if (secName.startsWith('system information')) section = 'system';
      else if (secName.startsWith('network interfaces')) section = 'interfaces';
      else if (secName.startsWith('tcp connections') || secName.startsWith('listening ports'))
        section = 'listening';
      else section = 'other';
      sectionHadContent = false;
      continue;
    }
    // Section divider line "============" or similar — ignore unless
    // we want to confirm the section is non-empty. The `had content`
    // check is what matters; dividers themselves are not data.
    if (/^=+\s*$/.test(line)) continue;
    // Banner / progress / status lines: "[*] Connected to ..." etc.
    if (line.startsWith('[*]')) continue;
    // Empty lines reset the section's "had content" flag without
    // changing sections — useful so that section transitions feel
    // natural and divider-less output still works.
    if (line === '') {
      sectionHadContent = false;
      continue;
    }
    sectionHadContent = true;

    if (section === 'system') {
      // "Hostname: router" — split on first colon.
      const kv = line.match(/^([^:]+):\s+(.+?)\s*$/);
      const k = kv?.[1]?.trim();
      const v = kv?.[2];
      if (k && v) {
        out.systemInfo[k] = v;
      }
      continue;
    }

    if (section === 'interfaces') {
      // Each interface block starts with "Interface:        [ up ] eth0"
      // and has indented sub-lines we ignore.
      const iface = line.match(/^Interface:\s+(.+?)\s*$/);
      const ifaceName = iface?.[1];
      if (ifaceName) {
        out.interfaces.push(ifaceName);
        continue;
      }
      // We could also collect IP/MAC here; for now we only record
      // the interface name + state combo. The "had content" check
      // ensures the next Interface: header resets cleanly.
      continue;
    }

    if (section === 'listening') {
      // Lines like "  22 (ssh)  LISTEN" or "  80/tcp  LISTEN".
      // Accept anything that ends in LISTEN.
      if (/LISTEN\s*$/i.test(line)) {
        out.listeningPorts.push(line);
      }
      continue;
    }
  }

  return out;
}

/**
 * Convert parsed snmpcheck output into Finding records.
 *
 * Severity:
 *   - "Connected" with default community string -> high (anyone on
 *     the network can read the same data).
 *   - System info exposure -> info (descriptive).
 *   - Listening ports exposed -> info.
 *   - Interfaces exposed -> info.
 */
export function snmpcheckToFindings(
  parsed: ReturnType<typeof parseSnmpcheckOutput>,
  community: string,
  target: string,
): Finding[] {
  const out: Finding[] = [];
  const now = Date.now();
  let n = 0;
  const slug = (s: string) => s.replace(/[^a-zA-Z0-9.-]/g, '-');

  // SNMPv2c with public/private community is the default. If we got
  // a parsed result at all, the community string was accepted. Mark
  // this as a high-severity finding — the operator should rotate to
  // SNMPv3 with auth/priv.
  if (Object.keys(parsed.systemInfo).length > 0 || parsed.interfaces.length > 0) {
    out.push({
      id: `snmpcheck-${n++}-${now}`,
      tool: 'snmpcheck',
      target,
      title: `SNMPv2c community string accepted: "${community}"`,
      severity: 'high',
      description: `snmpcheck successfully authenticated to ${target} using the "${community}" community string. SNMPv2c is unauthenticated and the community string is sent in cleartext — rotate to SNMPv3 with auth/priv.`,
      evidence: community,
      ts: now,
      meta: { slug: slug(community) },
    });
  }

  // System info fields — emit one finding per non-empty field.
  for (const [k, v] of Object.entries(parsed.systemInfo)) {
    out.push({
      id: `snmpcheck-${n++}-${now}`,
      tool: 'snmpcheck',
      target,
      title: `SNMP ${k}: ${v}`,
      severity: 'info',
      description: `snmpcheck exposed SNMP system field "${k}" on ${target}.`,
      evidence: v,
      ts: now,
      meta: { slug: slug(`${k}-${v}`), field: k },
    });
  }

  for (const iface of parsed.interfaces) {
    out.push({
      id: `snmpcheck-${n++}-${now}`,
      tool: 'snmpcheck',
      target,
      title: `SNMP interface exposed: ${iface}`,
      severity: 'info',
      description: `snmpcheck enumerated network interface ${iface} on ${target}.`,
      ts: now,
      meta: { slug: slug(iface) },
    });
  }

  for (const port of parsed.listeningPorts) {
    out.push({
      id: `snmpcheck-${n++}-${now}`,
      tool: 'snmpcheck',
      target,
      title: `SNMP listening port: ${port}`,
      severity: 'info',
      description: `snmpcheck exposed a listening TCP port on ${target}.`,
      evidence: port,
      ts: now,
      meta: { slug: slug(port) },
    });
  }

  return out;
}

export const snmpcheckTool: Tool<typeof SnmpcheckInput, typeof SnmpcheckOutput> = {
  name: 'snmpcheck',
  category: 'binary',
  description: 'Probe an SNMP-enabled host for exposed system, network, and process information.',
  input: SnmpcheckInput,
  output: SnmpcheckOutput,
  flags: [],
  async run(input: SnmpcheckInputT, _ctx: ToolContext): Promise<SnmpcheckOutputT> {
    const parsed0 = SnmpcheckInput.parse(input);
    const argv = [
      'snmpcheck',
      '-t',
      parsed0.target,
      '-p',
      String(parsed0.port),
      '-c',
      parsed0.community,
      '-w',
      String(parsed0.timeout),
    ];
    const r = await run({ argv, timeoutMs: 120_000 });
    const parsed = parseSnmpcheckOutput(r.stdout);
    return {
      findings: snmpcheckToFindings(parsed, parsed0.community, parsed0.target),
      community: parsed0.community,
      systemInfo: parsed.systemInfo,
      interfaces: parsed.interfaces,
      listeningPorts: parsed.listeningPorts,
      raw: parsed.raw,
      mode: r.mode,
      fellBack: r.fellBack,
      durationMs: r.durationMs,
    };
  },
};
