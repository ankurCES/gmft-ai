# Security policy

## Reporting a vulnerability

We take reports of unsafe tool behavior, sandbox escapes, prompt-injection vectors,
and any path through which GMFT-AI could be coerced into harming a non-authorized
target **very seriously**.

Please email **security@ankurCES.dev** (placeholder — replace before tagging v0.1.0)
with:

- A clear reproduction (target, prompt, model, GMFT-AI version).
- The impact you observed.
- Any mitigation ideas.

We will respond within 72 hours. We do not run a paid bug-bounty program in v0.1.

## Scope

**In scope**:

- Any tool that executes commands or network operations when it should have been
  denied by the chokepoint.
- Any sandbox escape from a Docker-isolated tool into the host.
- Any prompt-injection vector that causes GMFT-AI to emit a destructive tool call
  against a target not in scope of the user's explicit session target.
- Any path that leaks secrets (API keys, tokens) into the session log.

**Out of scope**:

- Bugs in upstream tools (nmap, nuclei, sqlmap, fluxion, etc.). Report those upstream.
- Use of GMFT-AI against unauthorized targets — that's a *legal* problem, not a
  security one, and we will not assist.

## Coordinated disclosure

We follow a 90-day disclosure window. We will credit reporters (with their consent)
in `CHANGELOG.md` and the release notes.

## Threat model

See `docs/safety.md` (lands in phase 6).
