# gmft v0.1 — Tool catalog

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

If the catalog and the code drift, the CI drift detector
(`scripts/check-tools.mjs`) fails the build. The doc is generated
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

## Quick reference — all 15 tools

| Tool | Category | Flags |
| --- | --- | --- |
| `nmap` | recon | `targetRequired` |
| `dnsenum` | recon | `targetRequired` |
| `theHarvester` | recon | `targetRequired` |
| `whatweb` | recon | `targetRequired` |
| `nuclei` | binary | — |
| `nikto` | binary | — |
| `gobuster` | binary | — |
| `ffuf` | binary | — |
| `sqlmap` | binary | `destructive` |
| `evil_twin` | binary | `destructive`, `requiresElevation` |
| `wifi_deauth` | binary | `destructive`, `requiresElevation` |
| `wifite_scan` | binary | `destructive`, `requiresElevation` |
| `shell_exec` | shell | `destructive` |
| `attack_chain` | chain | — |
| `report_write` | report | — |
| `report_pdf` | report | — |

(16 entries, counting `attack_chain` — the table omits the
duplicates. The CI drift detector counts the actual `tools: [...]`
array in `packages/tools/src/catalog.ts`.)

## What's not in v0.1

These are deferred (see `docs/plans/2026-06-08-gmft-ai-v0.1.md` §7):

- A2L (assess-to-learn) — out of scope; gmft stays operator-driven
- A burp-style proxy — `ffuf` + `nuclei` cover the common cases
- A wordlist generator — operators ship the wordlist
- Active directory tooling — the catalog has a placeholder, no
  v0.1 tool

If you want one of these, open an issue with the use case; the
catalog is opt-in (one entry in `catalog.ts`), not opt-out.
