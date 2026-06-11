# Contributing to gmft

> **The plan is the source of truth.** Before you write code, read
> [`docs/plans/2026-06-08-gmft-ai-v0.1.md`](docs/plans/2026-06-08-gmft-ai-v0.1.md)
> to find the phase your change belongs to. The plan numbers tasks;
> PRs that don't reference a task or ADR get a polite "let's discuss
> first" review.

## Local dev — 5 minutes

```sh
git clone https://github.com/ankurCES/gmft-ai.git
cd gmft-ai
pnpm install                 # installs all 4 packages
pnpm -r build                # type-checks every package
pnpm -r test                 # runs every package's test suite
```

If you don't have pnpm, `corepack enable && corepack prepare pnpm@latest --activate`
gets you there. Node 20+ is required (declared in each
`package.json`'s `engines`).

## The one rule

**`pnpm -r test` must be green before you open a PR.** That's the whole
bar. It runs:

- `packages/testkit` — 1 test
- `packages/core` — 148 tests (chokepoint, agent loop, executor, session store, findings)
- `packages/tools` — 106 tests (catalog, every tool, the chain, the report renderers)
- `apps/gmft` — 119 tests (slash commands, StatusRail, ApprovalPrompt, AgentApp e2e)

The CI drift detector at `scripts/check-tools.mjs` runs as part of
the same `pnpm -r test` chain (the `gmft` app's tests import the
catalog) and fails the build if a tool's name/category/flags drift
from `docs/tool-catalog.md` or the catalog source.

## Adding a tool

Three things are required, none optional:

1. **The tool source.** `packages/tools/src/<category>/<name>.ts`,
   exporting `<name>Tool: Tool<typeof Input, typeof Output>` (see any
   existing tool for the shape). Use `zod` for input validation.
   Declare `name`, `category`, and `flags` on the tool object.
2. **The catalog entry.** Add one block to
   `packages/tools/src/catalog.ts` (the `tools` array). The drift
   detector will yell if you skip this.
3. **A test.** `packages/tools/test/<category>/<name>.test.ts` with
   at least:
   - happy path (valid input → expected output shape)
   - one error path (invalid input → thrown or returned error)
   - one chokepoint path (if the tool has any flags: a unit test that
     asserts the chokepoint's decision for that flag combination)

If your tool is `destructive` or `requiresElevation`, also update
[`docs/safety.md`](docs/safety.md) with the threat it introduces and
the operator checklist row that mitigates it. PRs that add a
destructive tool without updating safety.md will be sent back.

## Adding a slash command

`apps/gmft/src/session/commands.ts` is the single source. The
dispatcher takes a `SlashContext`; if your command needs a session,
read it from `ctx.session`; if it needs a report write, use
`ctx.runReport`; if it needs to open a file, use `ctx.openFile`.
Don't import `fs` or `child_process` directly — the slash layer is
pure, the AgentApp wires the I/O.

Tests live in `apps/gmft/test/slash-commands.test.ts`. Cover at least:
- happy path with the canonical arg shape
- one error path (missing required arg, unknown format, etc.)
- the context's edge cases (no session, no runReport, etc.)

## ADRs

Architectural decisions get an ADR in
`docs/superpowers/decisions/NNNN-short-title.md`. The numbering
follows the existing `0001-…` series (look at the directory for the
current count). The format is loose — title, context, decision,
consequences — but it must include the date and the decision is
immutable once merged (you write a new ADR to supersede, not edit).

You need an ADR if your change:

- Reorders the chokepoint's rule sequence
- Changes the audit log shape (additive changes are fine without
  one; a breaking change is not)
- Changes the on-disk config schema (`~/.config/gmft/config.toml`)
- Adds a new category or flag to the chokepoint
- Adds a new entry to the operator's denylist (and it's not a copy
  of an existing entry)

## Style

- TypeScript strict mode is on. `exactOptionalPropertyTypes` is on
  (zod-inferred types often differ from `T | undefined`; spread
  defaults explicitly rather than passing `undefined`).
- Ink/React components in `apps/gmft/src/ui/` are functional. No
  class components.
- ESM throughout. Relative imports use the `.js` suffix even for
  `.ts` source (Node's ESM resolver needs it). `pnpm -r build`
  re-writes the dist files; you only need to remember `.js` in
  source.
- Tests are `vitest`. No Jest. No tap. The whole repo shares one
  config; per-package overrides are a code smell.

## Pull request flow

1. Branch from `master`. Name it `<phase-or-feature>/<short-name>`
   (e.g. `phase6/wifi-deauth` or `docs/safety-md`).
2. Run `pnpm -r test` locally. CI runs the same command.
3. Open the PR with a one-paragraph summary and a "Fixes #N" or
   "Implements plan §X.Y" line. The phase plan references are
   the easy way to land a PR that maps to a known task.
4. The maintainer review is one round. If the PR is small (<200
   lines, single package, no ADR), expect a same-day review. Larger
   PRs go to the next review batch.

## Code of conduct

Be technical. Be brief. Don't be cruel. The maintainer will close
threads that drift into either a flame war or a debate that
belongs in an issue. Issue > thread > PR, in that order.
