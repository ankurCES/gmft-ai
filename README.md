# GMFT-AI

> **Good-Made-for-the-World AI** — terminal-first agentic runtime for authorized penetration testing.
> Chat is the surface. Safety is the floor.

> ⚠ **Authorized use only.** GMFT-AI runs real attack tools (nmap, nuclei, sqlmap, etc.) and a
> WiFi evil-twin workflow. Use only on systems you own or have explicit written permission to
> test. Unauthorised use is illegal and unethical. The maintainers disclaim all liability.

## Status

**v0.1.0 in active planning.** See [`docs/plans/2026-06-08-gmft-ai-v0.1.md`](docs/plans/2026-06-08-gmft-ai-v0.1.md) for the full phased implementation plan (6 phases, ~50 tests, ~12 weeks).

The plan is the source of truth. Source code lands phase by phase.

## What it will be (v0.1.0)

- An interactive **Ink/React TUI chat** (no web UI in v0.1).
- A **ReAct agent loop** with Vercel AI SDK, streaming replies into the terminal.
- A **vetted tool catalog**: nmap, nuclei, nikto, gobuster, ffuf, sqlmap, dnsenum,
  theharvester, whatweb, shell_exec, the fluxion wifi evil-twin workflow, and a report
  renderer (MD/JSON/PDF).
- A **single safety gate** (the *Chokepoint*) through which every tool call must pass.
  Read-only tools auto-allow, destructive tools require typed confirmation per call,
  elevated tools require an env-var opt-in.
- A **Docker-first sandbox** (with a loud, persistent warning when host fallback is used).
- **Session persistence**: every turn appended to JSONL; resume on next launch.

## Inspirations

| Repo | What we borrow |
|---|---|
| [fluxionnetwork/fluxion](https://github.com/fluxionnetwork/fluxion) | The wifi evil-twin workflow shape |
| [vxcontrol/pentagi](https://github.com/vxcontrol/pentagi) | Multi-agent + sandbox + supervisor patterns (full supervisor deferred to v0.2) |
| [0x4m4/hexstrike-ai](https://github.com/0x4m4/hexstrike-ai) | The tool catalog shape (we curate 12, not 150+) |
| [xalgord/xalgorix](https://github.com/xalgord/xalgorix) | UX patterns: live telemetry, findings, reports, env-var config |

We are **not** a fork of any of them. We are a new, smaller, focused, safety-first TUI.

## Quick start (target — works after v0.1.0 ships)

```sh
pnpm install
pnpm build
pnpm -F gmft start
```

(Not yet. See the plan.)

## Contributing

We don't have a contributing guide yet — the plan is still in flight. Watch this space.

## License

MIT — see [LICENSE](LICENSE).
