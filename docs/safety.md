# Safety & threat model — gmft v0.1

> **This is not a toy.** gmft is an agentic pentest runtime. It will
> happily run `nmap`, `sqlmap`, `evilginx`, and friends against whatever
> host you point it at. The safety story is not "we asked the LLM nicely
> to be good." It's a hard-coded gate (`Chokepoint`) in front of every
> tool call, plus an append-only audit log you can replay later.

## 1. The one-paragraph version

Every tool invocation goes through `Chokepoint.decide(call)` before the
executor runs it. The chokepoint returns one of:

| Decision | Meaning |
| --- | --- |
| `allow` | Run the tool, no prompt. |
| `confirm` | Show a y/n prompt; only run on `y`. |
| `type-then-confirm` | Show a "type the literal `xyz`" prompt; only run on exact match. |
| `deny` | Hard refuse. The tool does not run. The reason is logged. |

The decision is recorded in the audit log regardless of the outcome.
The chokepoint is **pure** (no I/O, no time, no randomness) and lives in
`packages/core/src/chokepoint/`. Tests in
`packages/core/test/chokepoint.test.ts` lock down the rule order.

## 2. What the chokepoint does

Five rules, evaluated in this fixed order:

1. **`checkElevation`** — if the tool carries `requiresElevation` and
   `GMFT_ALLOW_ELEVATION` is not `true`, deny. Hardest stop; you can't
   even *see* a destructive-elevated tool's prompt when the env is
   locked down.
2. **`checkTypeToConfirm`** — if the tool declares a `typeToConfirm`
   literal, the user must type that literal to proceed. Replaces (not
   supplements) the plain `confirm` for these tools.
3. **`checkDestructive`** — if the tool is `destructive`, ask for
   confirmation. Always. There is no opt-out.
4. **`checkTarget`** — if the tool is `targetRequired`, the `args.target`
   string must be:
   - present and non-empty
   - format `^[a-zA-Z0-9._-]+$` (no shell metacharacters, no paths)
   - not in a private-network range (`10.0.0.0/8`, `192.168.0.0/16`,
     `172.16.0.0/12`, `127.0.0.0/8`, `169.254.0.0/16`, `0.0.0.0/8`,
     `100.64.0.0/10`, `localhost`, `*.local`) — *unless*
     `chokepoint.allowPrivateNetworks: true` in `~/.config/gmft/config.toml`
   - not in the operator's `chokepoint.denylist`
   - equal to the **session target** when `--target <host>` was passed
     on the CLI (this binds the whole session to one host; a tool call
     that drifts to a different host is denied with a "scope mismatch"
     reason)
5. **`allow`** — default when nothing above fires.

The order matters. The tests in `chokepoint.test.ts` lock it down; any
reorder is a breaking change for operators who have memorized it from
audit logs, and requires an ADR.

## 3. What the chokepoint does NOT do

It is **not** a content filter, intent classifier, or moral compass.
It will not catch a prompt-injection that asks the LLM to
"helpfully run `nmap` against the user's own router." If the LLM
generates a syntactically valid `target` for a `targetRequired` tool,
and that target isn't on the denylist, the chokepoint allows it.

It is also **not** a sandbox. Tools run as you, in the working
directory the LLM chose, with your filesystem and your network. The
"host" / "docker" indicator in the StatusRail is informational, not
enforced. A tool that shells out to `bash -c "..."` will run that
command — the chokepoint is in front of the *tool call*, not inside
the tool's subprocess.

It is also **not** a network firewall. `chokepoint.allowPrivateNetworks`
controls the in-process target-format check; it does not touch
iptables, nftables, AppArmor, or anything below the tool's argv.

## 4. How to disable the chokepoint (and why you shouldn't)

There are two operator-level switches, both in
`~/.config/gmft/config.toml`:

```toml
[chokepoint]
allowPrivateNetworks = true   # lets targetRequired tools hit RFC1918
allowElevation = true         # ONLY via env: GMFT_ALLOW_ELEVATION=true
denylist = ["internal-db.local", "backup-server.corp"]
```

**`allowPrivateNetworks`** is a config flag. Set it when you
intentionally target a `.internal` TLD or a lab network. Don't set it
on a laptop you'll later use against production — the chokepoint won't
catch a typo of an internal hostname.

**`GMFT_ALLOW_ELEVATION=true`** is an env var, not a config flag. The
reason: env vars don't get committed, and you don't want a teammate's
`config.toml` to silently promote a tool to root-equivalent. Tools
that need root (none in v0.1, but `iptables-save`, `tcpdump`, etc. in
later phases) will check this env var at the chokepoint boundary.

**`denylist`** is the safety belt when you need to enumerate "this
group of hosts is off-limits no matter what." v0.1's denylist is exact
match only; wildcard/CIDR support is on the post-v0.1 roadmap (see
`docs/plans/2026-06-08-gmft-ai-v0.1.md` §7).

You can also turn the chokepoint off entirely by editing the
`createChokepoint(...)` call in `apps/gmft/src/AgentApp.tsx` to
`{ allowElevation: true, allowPrivateNetworks: true, denylist: [] }`.
**Don't.** A v0.1 release of gmft without the chokepoint is a v0.1
release that will, with high probability, run something the user did
not intend. If you genuinely need to disable it for development, file
an issue first and link the PR — the audit log will show the call, the
LLM thought process, and the user action; we'd rather have the
receipts than the silence.

## 5. What the audit log contains

The session log is `~/.local/share/gmft/sessions/<id>.jsonl` (one
JSON object per line, append-only). The findings log is
`~/.local/share/gmft/findings/<id>.jsonl` (same shape, separate file
so reports can replay across sessions).

For every tool call, the session log records:

- `id` (turn id), `role` (`user` / `assistant` / `tool`),
  `content` (the message), `ts` (epoch ms)
- For `tool` role: the tool name, the args, the chokepoint's decision
  (`allow` / `confirm` / `type-then-confirm` / `deny` + reason), the
  user's y/n (or typed-literal) response, the tool output (or deny
  reason if denied)
- For `assistant` role: the full text delta, the model id, the
  provider

You can replay a session with `gmft --resume <id>`. The chat history
loads; the chokepoint is re-evaluated for *new* turns only — replayed
turns are display-only, the tools do not re-execute. This is
deliberate: you can re-read an old session without re-running the
nmap scan that found the open port.

For findings, each line is one `Finding` (`{id, tool, target,
severity, title, description?, evidence?, ts}`). The `evidence` field
is whatever the tool chose to capture — a curl response, a curl
request, a screenshot path. Treat it as you would any operator note.

## 6. What the chokepoint does not protect against

| Threat | Mitigated? |
| --- | --- |
| LLM runs an unauthorized destructive tool | Yes — `checkDestructive` confirms. |
| LLM runs a destructive tool as root | Yes — `checkElevation` denies. |
| LLM targets a private RFC1918 host by accident | Yes (when `allowPrivateNetworks=false`). |
| LLM targets an off-limits host from the denylist | Yes. |
| LLM drifts to a different host mid-session (with `--target` set) | Yes — session-scope check. |
| Prompt-injection in a tool's output that tricks the LLM | No. The chokepoint is a *gate*, not a *parser*. |
| Tool subprocess (`bash -c "..."`) doing something the args didn't say | No. AppArmor / container isolation is post-v0.1. |
| Filesystem damage from a destructive tool the user confirmed | No — `confirm` means the user opted in. The audit log has the receipt. |
| Secrets exfiltration (e.g. a tool that reads `~/.ssh/id_rsa` and ships it via a follow-up curl) | Partially — `targetRequired` blocks arbitrary outbound by default; but read-only filesystem tools (`shell_exec`, `file_read`) are not in scope of any chokepoint rule. |
| Model provider exfiltrating the conversation | No — provider trust is out of scope. Use a local model (ollama) if you care. |

## 7. Hardening checklist for operators

Before you point gmft at a real target:

1. **Set the denylist** in `config.toml`. Include the production
   network you definitely don't want enumerated (the corp VPN, the
   Jenkins controller, the prod database).
2. **Leave `allowPrivateNetworks` at `false`** unless you have a
   specific reason.
3. **Don't set `GMFT_ALLOW_ELEVATION=true`** in your shell rc. Set it
   inline (`GMFT_ALLOW_ELEVATION=true gmft ...`) only when you need
   the one elevated tool, and unset immediately after.
4. **Use `--target <host>`** for every session that has a known
   target. The session-scope check is the strongest binding gmft
   offers — without it, the LLM is free to drift.
5. **Run inside a container or VM** if you want real sandboxing. The
   StatusRail's "sandbox" field is informational; the actual
   isolation comes from the host. A `Dockerfile` for a hardened
   network namespace is in `docker/Dockerfile.web` (phase 5) and
   `docker/Dockerfile.wifi` (phase 6).
6. **Tail the audit log.** `tail -F
   ~/.local/share/gmft/sessions/$(date +%Y%m%d)*.jsonl` in a
   side-window. The log is append-only and small.
7. **Have an out-of-band rollback plan.** Confirmations are deliberate
   user actions. If the user clicks `y` on the wrong prompt, gmft
   does not have an undo. Restore from backup.

## 8. Reporting a safety bug

Email `ankur.nairit@gmail.com` with subject `[gmft-safety]`. Include
the session log path, the turn id, and the expected vs. actual
chokepoint decision. Critical-severity findings (chokepoint
bypass, audit-log tampering, secret exfiltration) get a fix within 7
days; a CVE is filed if the fix requires a config change for safe
operation.

## 9. Versioning

The chokepoint's rule order, the audit log shape, and the on-disk
config schema are all part of gmft's **public contract** for v0.1.
Breaking any of them requires a major version bump. Adding a new
rule is fine as long as the order of the existing rules is preserved
(or a migration ADR is filed that explains the reorder and the
audit-log implications).
