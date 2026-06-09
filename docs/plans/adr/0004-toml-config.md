# ADR-0004: TOML config with env-var overrides (XDG)

**Status**: Accepted (proposed 2026-06-08)
**Phase**: Plan (lands in phase 2)

## Context

xalgorix and pentagi both use environment variables for configuration. GMFT-AI
needs a richer config (provider, model, sandbox, target denylist, custom
chokepoint rules) and a more discoverable schema.

## Decision

**TOML config file** at `~/.config/gmft/config.toml` (XDG-respecting), Zod-validated,
with **environment-variable overrides** for the 90% case (`GMFT_PROVIDER`,
`GMFT_API_KEY`, `GMFT_MODEL`, `GMFT_SANDBOX`, `GMFT_ALLOW_PRIVATE`,
`GMFT_ALLOW_ELEVATION`).

## Rationale

1. **TOML is the right tool for a small, typed config.** Comments are first-class,
   which matters for a tool whose users *will* want to read the file and tweak.
   JSON forces line-noise quoting; YAML is famously ambiguous.
2. **XDG Base Directory** (`$XDG_CONFIG_HOME` or `~/.config`) is the Linux
   convention. We respect it; no surprises.
3. **Zod validation at load** catches typos and shape changes immediately, with
   a clear error pointing to the file path and (best-effort) the line.
4. **Env vars win** for CI, containers, and the 90% case where the user just
   wants to point at a different provider. The TOML is for everything else.

## Example `~/.config/gmft/config.toml`

```toml
[llm]
provider = "openai"          # openai | anthropic | google | openai-compatible
model = "gpt-4o-mini"
apiKey = "env:OPENAI_API_KEY" # or literal, but env: prefix is preferred

[sandbox]
mode = "docker"               # docker | host (host shows ⚠)
defaultImage = "gmft/runtime:0.1"

[chokepoint]
allowPrivateNetworks = false  # require GMFT_ALLOW_PRIVATE=true to override
denylist = ["example.com"]    # explicit denylist

[ui]
theme = "auto"                # auto | dark | light | high-contrast
```

## Consequences

- `packages/core/src/config/{load,schema,paths}.ts` is the only file that
  knows about the layout.
- All env-var names are prefixed `GMFT_` (no exceptions — keeps grep simple).
- A `gmft config` slash command prints the resolved, validated config (with
  secrets redacted).
