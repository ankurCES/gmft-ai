# gmft

> **Terminal-first agentic pentest runtime.**
> Chat is the surface. Safety is the floor.

> ⚠ **Authorized use only.** gmft runs real attack tools
> ([`nmap`](https://nmap.org), [`nuclei`](https://github.com/projectdiscovery/nuclei),
> [`sqlmap`](https://sqlmap.org), [`fluxion`](https://github.com/fluxionnetwork/fluxion),
> and friends). Use only on systems you own or have explicit written
> permission to test. Unauthorised use is illegal and unethical. The
> maintainers disclaim all liability.

## What is gmft?

A chat-based TUI that drives a curated catalog of pen-test tools. You
type a goal ("enumerate the web apps on `scanme.nmap.org` and find any
SQL injection"); the LLM picks tools from the catalog, calls them
through a hard-coded safety gate (the *Chokepoint*), and writes findings
to a session-scoped sidecar. Reports render to markdown, JSON, HTML, or
PDF.

The Chokepoint is the floor. Every tool call goes through it; the
audit log records every decision (allow / confirm / type-then-confirm /
deny + reason); the operator's denylist, the private-network filter,
and the session-scope check are the only things standing between an
autonomous LLM and your production network. **Read
[`docs/safety.md`](docs/safety.md) before you point this at anything
real.**

## Status

**v0.1.0 ships.** 374 tests green across 4 packages; pnpm build is
clean; the `.deb` is on the release page. See
[`docs/plans/2026-06-08-gmft-ai-v0.1.md`](docs/plans/2026-06-08-gmft-ai-v0.1.md)
for the full phased plan (6 phases) and
[`docs/superpowers/plans/2026-06-17-gmft-phase6.md`](docs/superpowers/plans/2026-06-17-gmft-phase6.md)
for the phase-6 feature breakdown.

## Quick start

Requires **Node 20+** and **pnpm 9+**. Docker is optional but
recommended for the binary-category tools (nuclei, nikto, gobuster, ffuf,
sqlmap).

```sh
git clone https://github.com/ankurCES/gmft-ai.git
cd gmft-ai
pnpm install
pnpm -r build
pnpm -F gmft start                 # launches the TUI
```

The first launch runs onboarding — provider choice (anthropic, openai,
google, openrouter, ollama), API key (keytar or envfile), sandbox mode
(docker or host). After that, the chat is your surface.

A few seconds in, you'll see a session id, a token counter, and a
findings tally. Run a recon goal; the LLM will call `nmap`, `whatweb`,
or `nuclei`. Each call pops a confirm prompt if it's destructive; deny
or type the literal to proceed.

## Try it (legal, no setup)

```sh
pnpm -F gmft start -- --target scanme.nmap.org
```

`scanme.nmap.org` is the nmap project's intentionally-scannable host;
it's a safe target for testing the LLM's tool-picking. The
`--target` flag binds the chokepoint: the LLM can't drift to a
different host without restarting the session.

## CLI flags

| Flag | What it does |
| --- | --- |
| `--reconfigure` | Re-run onboarding (re-prompts every field). |
| `--theme <name>` | `auto` (default, follows terminal) / `dark` / `light` / `high-contrast`. |
| `--target <host>` | Session target. The chokepoint denies any `targetRequired` tool call whose `args.target` doesn't match. |
| `--resume <id>` | Resume a specific session by id (skips the current-session pointer). |
| `--help` | Show this list. |
| `--version` | Print the version. |

## Slash commands (in TUI)

| Command | Effect |
| --- | --- |
| `/help` | Show the in-TUI help. |
| `/clear` | Clear the chat (the on-disk session log is kept). |
| `/model <id>` | Switch model in-memory. |
| `/provider <id>` | Switch provider (clears the model). |
| `/session new` | Start a new session (clears the chat). |
| `/session list` | List sessions on disk. |
| `/session load <id>` | Load a session and replay turns. |
| `/session clear` | Clear the current-session pointer (logs kept). |
| `/resume` | Alias for `/session load <current>`. |
| `/report [md\|json\|pdf] [path]` | Write a report. Default format is `md`; `pdf` opens the file with `xdg-open`. |
| `/exit` | Exit (alias for `Ctrl-C`). |

## The 15 tools

| Tool | Category | What it does |
| --- | --- | --- |
| `nmap` | recon | Port scan + service fingerprint. |
| `dnsenum` | recon | DNS enumeration (records + zone transfer). |
| `theHarvester` | recon | OSINT: emails, subdomains, names. |
| `whatweb` | recon | Web tech fingerprint. |
| `nuclei` | binary | Vulnerability scanner. |
| `nikto` | binary | Web server scanner. |
| `gobuster` | binary | Directory / DNS / vhost enum. |
| `ffuf` | binary | Web fuzzer. |
| `sqlmap` | binary | SQL injection detection. |
| `evil_twin` | binary | Captive-portal evil-twin (fluxion). |
| `wifi_deauth` | binary | 802.11 deauth. |
| `wifite_scan` | binary | Wifite auto-mode. |
| `shell_exec` | shell | Arbitrary shell command. **The most dangerous tool — confirmed per call.** |
| `attack_chain` | chain | Multi-step playbook. |
| `report_write` | report | Render findings to MD/JSON/HTML. |
| `report_pdf` | report | Render findings to PDF. |

Full schema and prereqs: [`docs/tool-catalog.md`](docs/tool-catalog.md).

## Project layout

```
gmft-ai/
├── apps/gmft/                 # Ink/React TUI (the `gmft` binary)
│   ├── src/cli.tsx            # meow flag parser + onboarding entry
│   ├── src/AgentApp.tsx       # state owner (chokepoint, status, key resolve)
│   ├── src/App.tsx            # tabbed UI (chat / findings / help)
│   ├── src/session/           # SessionStore + slash dispatcher
│   └── src/ui/                # StatusRail, ApprovalPrompt, FindingsTab, ChainPane
├── packages/core/             # Agent loop, chokepoint, executor, findings, session
├── packages/tools/            # The 15-tool catalog + report renderers
├── packages/testkit/          # shared test helpers
├── docs/
│   ├── plans/                 # design + implementation plans
│   ├── superpowers/           # design + decisions + per-phase plans
│   ├── safety.md              # chokepoint + threat model
│   └── tool-catalog.md        # per-tool operator reference
└── scripts/check-tools.mjs    # CI drift detector
```

## Testing

```sh
pnpm -r test                 # all 4 packages
pnpm -C packages/core test   # chokepoint + agent loop + executor
pnpm -C packages/tools test  # catalog + every tool
pnpm -C apps/gmft test       # TUI + slash commands + e2e
```

374 tests, runs in well under 2 minutes on a laptop.

## Contributing

We take PRs. Read [`CONTRIBUTING.md`](CONTRIBUTING.md) first — the
short version is "the plan is the source of truth, ADRs are
immutable, and `pnpm -r test` is the bar." Adding a tool? Three
things: the source, a catalog entry, and a test. If it's
`destructive` or `requiresElevation`, also update
[`docs/safety.md`](docs/safety.md).

## Inspirations

| Repo | What we borrow |
| --- | --- |
| [fluxionnetwork/fluxion](https://github.com/fluxionnetwork/fluxion) | The wifi evil-t twin workflow shape |
| [vxcontrol/pentagi](https://github.com/vxcontrol/pentagi) | Multi-agent + sandbox + supervisor patterns (full supervisor deferred to v0.2) |
| [0x4m4/hexstrike-ai](https://github.com/0x4m4/hexstrike-ai) | The tool catalog shape (we curate 16, not 150+) |
| [xalgord/xalgorix](https://github.com/xalgord/xalgorix) | UX patterns: live telemetry, findings, reports, env-var config |

We are **not** a fork of any of them. We are a new, smaller, focused, safety-first TUI.

## License

MIT — see [LICENSE](LICENSE).
