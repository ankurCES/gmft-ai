# gmft v0.3 — Tool catalog

> **Read [docs/safety.md](./safety.md) first.** Every tool in this
> catalog is gated by the chokepoint; that doc explains what that
> means, what the chokepoint does *not* catch, and how to disable it
> (and why you shouldn't).

This document is the operator reference for the tools gmft v0.1 ships
with. For each tool:

- **Name** — the tool's identifier; the LLM calls it by this string.
- **Category** — `recon` (read-only enumeration), `binary` (executes a
  third-party tool in a container or on the host), `note`
  (bookkeeping), `shell` (arbitrary command execution), `chain`
  (orchestrates other tools), `report` (renders findings).
- **Flags** — chokepoint behavior. `targetRequired` is checked against
  the session target + denylist + private-network filter;
  `destructive` always asks for confirmation;
  `requiresElevation` denies unless `GMFT_ALLOW_ELEVATION=true`.
- **Input** — the tool's zod schema. Required fields are listed
  first; optional fields in italics.
- **Output** — a sketch of the shape. Every tool that produces
  findings emits a `findings: Finding[]` field; the report tools read
  this.
- **Prereqs** — what the operator needs on the host. Phase 5+ tools
  run inside the alpine Docker image; phase 4 tools need the
  binary on PATH or in a venv. See `docker/Dockerfile.*` for the
  exact apt/pip lists.

If the catalog and the code drift, the `catalog.test.ts` guard
re-asserts the table above matches the actual `tools: [...]`
array in `packages/tools/src/catalog.ts`. The doc is generated
from the source, not hand-written.

---

## recon — read-only enumeration

### `nmap`

- **Category:** `recon`
- **Flags:** `targetRequired`
- **Description:** Port scan + service fingerprint with nmap. Default
  profile is `-sV -T4 --top-ports 1000`; the `profile` arg selects
  other templates (`syn`, `ack`, `udp`, `comprehensive`).
- **Input:** `{ target: string, profile?: 'syn'|'ack'|'udp'|'comprehensive', ports?: string, targetsFile?: string }`
- **Output:** `{ openPorts: Array<{port,protocol,service,product?}> }` plus per-port `Finding` records.
- **Prereqs:** `nmap` binary on PATH (or in the network container).

### `dnsenum`

- **Category:** `recon`
- **Flags:** `targetRequired`
- **Description:** DNS enumeration. Queries the apex for common SRV/CAA
  records, attempts zone transfer, brute-forces a small subdomain
  list.
- **Input:** `{ target: string, wordlist?: string }`
- **Output:** `{ records: Array<{type,name,value}> }` plus
  `findings: Finding[]` for any record that's unusual.
- **Prereqs:** `dnsenum` binary, or the `dnsrecon` Python package.

### `theHarvester`

- **Category:** `recon`
- **Flags:** `targetRequired`
- **Description:** Email / subdomain / name harvest from public
  sources (Bing, Censys, crt.sh, etc.). Default source is `all`.
- **Input:** `{ target: string, source?: 'bing'|'censys'|'crtsh'|'all', limit?: number }`
- **Output:** `{ emails: string[], hosts: string[] }` plus
  per-record findings.
- **Prereqs:** `theHarvester` Python package; some sources need API
  keys (env: `BING_API_KEY`, `CENSYS_API_ID`+`CENSYS_API_SECRET`).

### `whatweb`

- **Category:** `recon`
- **Flags:** `targetRequired`
- **Description:** Web tech fingerprint. Identifies CMS, JS
  frameworks, server software, and any obvious security headers
  that are missing.
- **Input:** `{ target: string, aggression?: 1|2|3|4 }`
- **Output:** `{ technologies: Array<{name,version?,category}> }`
  plus findings for missing headers and outdated software.
- **Prereqs:** `whatweb` binary, or the Ruby gem (`gem install
  whatweb`).

### `masscan`

- **Category:** `recon`
- **Flags:** `targetRequired`
- **Description:** Internet-scale port scanner. Use when `nmap` is
  too slow for the target range (masscan can sustain ~10 Mpps
  with `--rate`). Less accurate than nmap (no service/version
  detection) — pair with nmap for the interesting hosts it
  surfaces.
- **Input:** `{ target: string, ports: string, rate?: number, targetsFile?: string }`
- **Output:** `{ openPorts: Array<{port,protocol}> }` with one
  `Finding` per open port.
- **Prereqs:** `masscan` binary (in the `gmft/network:0.3` image).

### `rustscan`

- **Category:** `recon`
- **Flags:** `targetRequired`
- **Description:** Fast port scanner written in Rust that hands
  found ports off to nmap for service detection. Faster startup
  than masscan for moderate ranges; the `nmapArgs` field controls
  what gets piped through to nmap.
- **Input:** `{ target: string, ports?: string, nmapArgs?: string[], batchSize?: number, targetsFile?: string }`
- **Output:** `{ openPorts: Array<{port,service?}> }` with one
  `Finding` per open port.
- **Prereqs:** `rustscan` binary (in the `gmft/network:0.3` image).

### `subfinder`

- **Category:** `recon`
- **Flags:** `targetRequired`
- **Description:** Passive subdomain enumeration — queries
  Certificate Transparency logs, DNS datasets, and ~30 passive
  sources to find subdomains without ever sending a packet to
  the target. Pair with `dnsenum` for the brute-force complement.
- **Input:** `{ target: string, recursive?: boolean, timeoutSec?: number }`
- **Output:** `{ subdomains: string[] }` with one `Finding` per
  discovered subdomain.
- **Prereqs:** `subfinder` binary (in the `gmft/network:0.3` image).

### `dnsrecon`

- **Category:** `recon`
- **Flags:** `targetRequired`
- **Description:** Active DNS enumeration — SOA/NS/MX/TXT lookups,
  zone-transfer attempts, SRV record enumeration, and
  (optionally) a reverse-lookup sweep of the discovered NS range.
  Complements `dnsenum`'s brute-force wordlist with structured
  record-type coverage.
- **Input:** `{ target: string, types?: ('soa'|'ns'|'mx'|'txt'|'srv'|'ptr')[], zoneTransfer?: boolean, reverseLookup?: boolean }`
- **Output:** `{ records: Array<{name,type,value}> }` with one
  `Finding` per interesting record (MX, TXT, zone-transfer
  success).
- **Prereqs:** `dnsrecon` Python package (in the
  `gmft/network:0.3` image).

### `fierce`

- **Category:** `recon`
- **Flags:** `targetRequired`
- **Description:** DNS zone-walk + adjacent-network scanner. After
  a zone transfer attempt, fierce uses the discovered NS records
  to walk nearby IP space (the "find that other domain on the
  same /24" use case). Often the first recon tool that finds
  forgotten dev/staging hosts.
- **Input:** `{ target: string, dnsServer?: string, wideScan?: boolean, timeoutMs?: number }`
- **Output:** `{ hosts: Array<{name,ip?}> }` with one `Finding`
  per discovered host.
- **Prereqs:** `fierce` (Perl, in the `gmft/network:0.3` image).

### `enum4linux`

- **Category:** `recon`
- **Flags:** `targetRequired`
- **Description:** SMB/Samba enumeration — null session, user
  lists, share lists, group lists, OS fingerprint, and printer
  enumeration. Default is "everything"; pass `mode` to narrow.
  **Authorization required** — SMB is loud and a null session
  is a red flag in most environments.
- **Input:** `{ target: string, mode?: 'all'|'users'|'shares'|'groups'|'os', timeoutMs?: number }`
- **Output:** `{ users?: string[], shares?: Array<{name,comment?}> }`
  plus `Finding` records for each enumerated user/share/group
  and a `severity: 'high'` finding on admin shares (C$, IPC$).
- **Prereqs:** `enum4linux` (Perl, in the `gmft/network:0.3`
  image).

### `ldapsearch`

- **Category:** `recon`
- **Flags:** `targetRequired`
- **Description:** Query an LDAP directory. Defaults to anonymous
  bind with a `base` of the domain's default naming context
  (discovered via the root DSE). Use the `filter` and `attrs`
  fields to scope to a particular object class.
- **Input:** `{ target: string, base?: string, filter?: string, attrs?: string[], bindDn?: string, bindPassword?: string, scope?: 'base'|'one'|'sub' }`
- **Output:** `{ entries: Array<{dn,attrs: Record<string,string[]>}> }`
  with one `Finding` per returned entry (capped at the first
  1000).
- **Prereqs:** `ldapsearch` binary (in the `gmft/network:0.3`
  image).

---

## binary — runs a third-party tool

These tools shell out to a binary or container image. The chokepoint
flags control who can run them. None of them are read-only — even
`nuclei` sends a real request to the target.

### `nuclei`

- **Category:** `binary`
- **Flags:** none (no `targetRequired` — the LLM may legitimately want
  to scan a host it learned about, not just the session target).
- **Description:** Run nuclei vulnerability scanner with the
  community templates. Default severity filter is `medium,high,critical`.
- **Input:** `{ target: string, severity?: string, tags?: string[] }`
- **Output:** `{ findings: Array<{template,severity,matched_at,evidence}> }`
  with one `Finding` per template match.
- **Prereqs:** `nuclei` binary; the `docker/Dockerfile.web` image
  installs it at build time.

### `nikto`

- **Category:** `binary`
- **Flags:** none
- **Description:** Run nikto web server scanner.
- **Input:** `{ target: string, port?: number, ssl?: boolean }`
- **Output:** `findings: Finding[]` parsed from the nikto JSON
  output.
- **Prereqs:** `nikto` binary.

### `gobuster`

- **Category:** `binary`
- **Flags:** none
- **Description:** Directory / DNS / vhost enumeration. Default mode
  is `dir` with the `common.txt` wordlist (shipped in the container).
- **Input:** `{ target: string, mode: 'dir'|'dns'|'vhost', wordlist?: string, extensions?: string }`
- **Output:** `findings: Finding[]` — one per discovered path/host.
- **Prereqs:** `gobuster` binary; wordlist in
  `/usr/share/wordlists/dirb/common.txt` or a path passed via `wordlist`.

### `ffuf`

- **Category:** `binary`
- **Flags:** none
- **Description:** Web fuzzer. Default mode is `directory` with
  common wordlist.
- **Input:** `{ target: string, mode: 'directory'|'subdomain'|'vhost', wordlist?: string, matchStatus?: number[] }`
- **Output:** `findings: Finding[]` per match.
- **Prereqs:** `ffuf` binary.

### `sqlmap`

- **Category:** `binary`
- **Flags:** `destructive` (it sends real payloads)
- **Description:** Automated SQL injection detection and (when
  confirmed) exploitation. Default level is `1`, risk is `1`. The
  LLM is expected to escalate these for confirmed injection points.
- **Input:** `{ target: string, param?: string, level?: 1|2|3|4|5, risk?: 1|2|3 }`
- **Output:** `findings: Finding[]` per confirmed injection.
- **Prereqs:** `sqlmap` Python package.

### `httpx`

- **Category:** `binary`
- **Flags:** none (no `targetRequired` — httpx is the right tool
  to probe hosts the LLM learned about from a prior scan, not
  just the session target).
- **Description:** Probe a list of HTTP(S) endpoints for liveness,
  status code, page title, and content length. The LLM's typical
  use is to feed `subfinder` output into httpx to find which
  subdomains actually serve a web app.
- **Input:** `{ target: string | string[], followRedirects?: boolean, timeoutSec?: number }`
- **Output:** `{ live: Array<{url,statusCode,title,contentLength}> }`
  with one `Finding` per live host.
- **Prereqs:** `httpx` binary (in the `gmft/web:0.3` image).

### `wpscan`

- **Category:** `binary`
- **Flags:** none
- **Description:** WordPress security scanner — detects the core
  version, plugins, themes, and known CVEs (from WPScan's
  vulnerability feed). Default is `--enumerate ap,at,u` (all
  plugins, all themes, users); pass `enumerate` to narrow.
  Aggressive enumeration is loud; expect WAF friction on shared
  hosting.
- **Input:** `{ target: string, enumerate?: 'vp'|'ap'|'p'|'vt'|'at'|'t'|'u'|'d'|'db'|'m', apiToken?: string, detectionMode?: 'mixed'|'passive'|'aggressive' }`
- **Output:** `{ wordpressVersion?, plugins: [...], themes: [...],
  users: [...] }` with a `Finding` per vulnerable component and
  one per enumerated username.
- **Prereqs:** `wpscan` Ruby gem (in the `gmft/web:0.3` image).
  A WPScan API token unlocks the vulnerability feed; pass it via
  `apiToken` or `WPSCAN_API_TOKEN` env.

### `snmpcheck`

- **Category:** `binary`
- **Flags:** none
- **Description:** Probe an SNMP-enabled host. The default
  community string is `public` (the universal default; if it
  works, the host is misconfigured). Each field snmpcheck
  exposes (system description, network interfaces, listening
  ports, processes, storage) becomes a `Finding`.
- **Input:** `{ target: string, port?: number, community?: string | string[], timeoutSec?: number }`
- **Output:** `{ exposed: Array<{key,value}>, listeningPorts?: number[] }`
  with a `severity: 'high'` finding when the community string
  is the default `public`.
- **Prereqs:** `snmpcheck` Perl module + `snmpwalk` (in the
  `gmft/web:0.3` image).

### `evil_twin`

- **Category:** `binary`
- **Flags:** `destructive`, `requiresElevation` (needs raw 802.11 frames)
- **Description:** Run fluxion to host a captive-portal evil-twin.
  **For authorized pentest engagements only.** This tool actively
  interferes with the target network; the chokepoint's
  `typeToConfirm` literal is the user's explicit "I have
  authorization" attestation.
- **Input:** `{ ssid: string, channel: number, interface: string }`
- **Output:** `{ capturePath?: string }` plus a single
  `severity: 'critical'` finding when the AP comes up.
- **Prereqs:** `fluxion` (or the alpine wifi image's bundled
  version); a wireless NIC in monitor mode; root.

### `wifi_deauth`

- **Category:** `binary`
- **Flags:** `destructive`, `requiresElevation`
- **Description:** Send 802.11 deauth frames to a target client
  (kicking it off an AP). Useful for forcing WPA handshake
  capture.
- **Input:** `{ bssid: string, clientMac?: string, count?: number, interface: string }`
- **Output:** `{ framesSent: number }` plus a finding if a handshake
  was captured.
- **Prereqs:** `aireplay-ng` (in the wifi image); monitor-mode NIC;
  root.

### `wifite_scan`

- **Category:** `binary`
- **Flags:** `destructive`, `requiresElevation`
- **Description:** Wifite's "auto" mode — scan for weak WPA / WEP
  networks, optionally attack. The default is scan-only; the
  `attack: true` arg is what triggers the destructive path.
- **Input:** `{ interface: string, attack?: boolean, timeoutSec?: number }`
- **Output:** `{ networks: Array<{ssid,bssid,encryption,signal}> }`
  plus findings for weak encryption.
- **Prereqs:** `wifite`; monitor-mode NIC; root.

### `bettercap`

- **Category:** `binary`
- **Flags:** `targetRequired`
- **Description:** Passive WiFi + BLE discovery with bettercap.
  Scans for access points and BLE devices in monitor mode and
  returns a list of discovered entities. **Does not transmit.**
  This is recon, not attack — for deauth or evil-twin see the
  `wifi_deauth` and `evil_twin` tools.
- **Input:** `{ interface: string, scanBle?: boolean, timeoutSec?: number }`
- **Output:** `{ aps: Array<{bssid,ssid?,channel,encryption,signal}>,
  bleDevices?: Array<{mac,name?,rssi}> }` with one `Finding` per
  AP and one per BLE device.
- **Prereqs:** `bettercap` binary on the host (host-only tool —
  not in the `gmft/wifi` image). Monitor-mode NIC; root for raw
  802.11 frames.

### `aircrack`

- **Category:** `binary`
- **Flags:** `targetRequired`
- **Description:** Passive WiFi capture with `airodump-ng` (the
  capture half of the aircrack-ng suite). Runs `airodump-ng`
  for `timeoutSec` seconds, parses the CSV, and returns the APs
  and clients observed. **Does not transmit and does not
  attempt to crack** — see `aircrack-ng` directly for the
  offline crack step.
- **Input:** `{ interface: string, channel?: number, bssid?: string, timeoutSec?: number, outputPath?: string }`
- **Output:** `{ aps: Array<{bssid,essid?,channel,privacy,signal}>,
  clients: Array<{mac,bssid,signal}> }` with one `Finding` per
  AP and a `severity: 'high'` finding for open / WEP networks.
- **Prereqs:** `airodump-ng` on the host (host-only). Monitor-
  mode NIC; root.

### `kismet`

- **Category:** `binary`
- **Flags:** `targetRequired`
- **Description:** Passive WiFi / BLE / Zigbee capture by parsing
  a Kismet `.kismet` log file. Kismet itself runs as a long-lived
  daemon on the host; this tool ingests the log it produces and
  returns the discovered devices. Useful for "what did kismet
  see while I was at lunch" post-hoc analysis.
- **Input:** `{ kismetLog: string, types?: ('wifi'|'ble'|'zigbee')[] }`
- **Output:** `{ devices: Array<{mac,type,ssid?,manufacturer?}> }`
  with one `Finding` per discovered device.
- **Prereqs:** A kismet log file (host-only tool — the operator
  must run kismet separately and point the tool at its `.kismet`
  log). No special privileges to *parse* the log; the operator's
  kismet config determines capture permissions.

---

## shell — direct command execution

### `shell_exec`

- **Category:** `shell`
- **Flags:** `destructive` (any command can rm -rf /)
- **Description:** Run an arbitrary shell command. **This is the
  single most dangerous tool in the catalog.** The LLM has
  unrestricted filesystem + network access through this tool. The
  chokepoint confirms before running; the audit log records the
  full argv + exit code.
- **Input:** `{ command: string, cwd?: string, timeoutMs?: number }`
- **Output:** `{ stdout: string, stderr: string, exitCode: number }`
- **Prereqs:** none (you already have a shell).

---

## chain — orchestration

### `attack_chain`

- **Category:** `chain`
- **Flags:** none at the top level (each step is re-checked)
- **Description:** Run a list of tool steps in order. The chain tool
  is the LLM's "playbook" primitive: it lets the model express
  multi-step recon+exploit flows declaratively. Each step is
  re-evaluated by the chokepoint, so destructive + elevated steps
  still confirm; the chain's `findings` is the concatenation of
  the per-step findings.
- **Input:** `{ steps: Array<{tool: string, args: Record<string,unknown>, name?: string}> }`
- **Output:** `{ results: Array<{tool,ok,output,findings?,durationMs}> }`
- **Prereqs:** none.

---

## report — render findings to a file

### `report_write`

- **Category:** `report`
- **Flags:** none
- **Description:** Render the current session's findings into
  markdown, JSON, or HTML. JSON output is the canonical
  machine-readable form; markdown is the human default; HTML is
  there for `xdg-open` integration.
- **Input:** `{ format: 'markdown'|'json'|'html', includeEvidence?: boolean, outputPath?: string }`
- **Output:** `{ path: string, byteLength: number }`
- **Prereqs:** the findings sidecar at
  `~/.local/share/gmft/findings/<sessionId>.jsonl` must exist (the
  LLM is expected to have run at least one recon tool first).

### `report_pdf`

- **Category:** `report`
- **Flags:** none
- **Description:** Render the current session's findings to a PDF
  using `@react-pdf/renderer`. Same input shape as `report_write`
  except `format` is fixed at `pdf`.
- **Input:** `{ format: 'pdf', includeEvidence?: boolean, outputPath?: string }`
- **Output:** `{ path: string, byteLength: number }`
- **Prereqs:** `@react-pdf/renderer` (a `@gmft/tools` dep).

---

## Quick reference — all 29 tools

| Tool | Category | Flags |
| --- | --- | --- |
| `nmap` | recon | `targetRequired` |
| `dnsenum` | recon | `targetRequired` |
| `theHarvester` | recon | `targetRequired` |
| `whatweb` | recon | `targetRequired` |
| `masscan` | recon | `targetRequired` |
| `rustscan` | recon | `targetRequired` |
| `subfinder` | recon | `targetRequired` |
| `dnsrecon` | recon | `targetRequired` |
| `fierce` | recon | `targetRequired` |
| `enum4linux` | recon | `targetRequired` |
| `ldapsearch` | recon | `targetRequired` |
| `nuclei` | binary | — |
| `nikto` | binary | — |
| `gobuster` | binary | — |
| `ffuf` | binary | — |
| `sqlmap` | binary | `destructive` |
| `httpx` | binary | — |
| `wpscan` | binary | — |
| `snmpcheck` | binary | — |
| `evil_twin` | binary | `destructive`, `requiresElevation` |
| `wifi_deauth` | binary | `destructive`, `requiresElevation` |
| `wifite_scan` | binary | `destructive`, `requiresElevation` |
| `bettercap` | binary | `targetRequired` |
| `aircrack` | binary | `targetRequired` |
| `kismet` | binary | `targetRequired` |
| `shell_exec` | shell | `destructive` |
| `attack_chain` | chain | — |
| `report_write` | report | — |
| `report_pdf` | report | — |

(29 entries. The CI drift detector counts the actual
`tools: [...]` array in `packages/tools/src/catalog.ts`.)

## What's not in v0.3.B

These are deferred (see
`docs/superpowers/plans/2026-06-17-gmft-v0.3-run-polish-and-tool-surface.md`
§Risks / §Open questions):

- **A2L (assess-to-learn)** — out of scope; gmft stays operator-
  driven. The LLM suggests a plan, the operator confirms.
- **A burp-style intercepting proxy** — `ffuf` + `httpx` + `nuclei`
  cover the common cases. A full MITM proxy is a v0.4+ ergonomic.
- **A wordlist generator** — operators ship the wordlist. The
  container ships `common.txt` for `gobuster` / `ffuf` defaults;
  custom wordlists come from the operator's filesystem.
- **Active directory attack tooling** — `enum4linux` + `ldapsearch`
  cover SMB/LDAP enumeration. Post-exploitation AD tooling
  (BloodHound, mimikatz, etc.) is intentionally out of scope;
  gmft is an assessment / recon platform, not a C2 / post-exploit
  framework.
- **WPA handshake cracking** — `aircrack` captures the handshake;
  the offline crack step is out of scope (operators use
  `aircrack-ng` / `hashcat` directly with their own wordlists).
- **Long-lived daemons as managed tools** — kismet's daemon is
  run by the operator, gmft ingests its logs. Wrapping kismet
  (and other daemons) as supervised tools is a v0.4+ ergonomic.

If you want one of these, open an issue with the use case; the
catalog is opt-in (one entry in `catalog.ts`), not opt-out.
