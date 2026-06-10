# Phase 3 — Chokepoint & tool registry

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the safety spine of v0.1. Every tool call — of any tool, from any source, through any UI — flows through a single `chokepoint.decide(...)` gate. Read-only tools pass silently, destructive tools require typed confirmation per call, elevated tools require `GMFT_ALLOW_ELEVATION=true`, and no tool runs without a target the user explicitly named. The first concrete tool is `shell_exec` (no shell, no `&&`/`;`, env allowlist, sandboxed via Docker with host-fallback). ADR-0001/0002/0003 capture the policy decisions.

**Why this phase exists:** §3 + §4.3 + §6 of the v0.1 plan. The agent loop is currently a single `streamText` call with no tool surface. Phase 3 is what makes GMFT-AI a *pentesting assistant* and not a chat UI.

**What changes in this plan:**

1. `packages/core/src/chokepoint/{decision,policy,rules,index}.ts` — the gate. `Decision = Allow | Confirm(reason) | Deny(reason)`. Rules: target required + format-checked + private-network denylist (with `GMFT_ALLOW_PRIVATE` opt-out); `destructive` ⇒ `Confirm`; `requiresElevation` ⇒ requires `GMFT_ALLOW_ELEVATION=true`.
2. `packages/core/src/tools/{types,registry,executor,index}.ts` — `Tool<I,O>` shape, registry with name/category/Zod validation, executor that calls the chokepoint and dispatches `Allow`/`Confirm`/`Deny`.
3. `packages/tools/` (new package) — `shell/shell-exec.ts` (first real tool) + `shared/{prereq,runner}.ts` (assertBinary + Docker-first/host-fallback sandbox).
4. `agent/loop.ts` extended with `ToolCallRequest`/`ToolResult`/`ConfirmationNeeded` events; `maxSteps > 1`; AI SDK `tools` wired in.
5. `apps/gmft/src/ui/components/ApprovalPrompt.tsx` (new) — Ink component shown when chokepoint returns `Confirm`. `useAgent.ts` + `AgentApp.tsx` surface it.
6. ADRs 0001/0002/0003 under `docs/adr/`. CHANGELOG entry. Tag `v0.1.0-phase3`.

**What does NOT change:** the `runTurn` `text-delta`/`done`/`error` events stay identical for backward-compat (existing `agent-loop.test.ts` must keep passing unchanged). LLM provider surface (`createModel`, `lookupApiKey`, `getDefaultModel`) is unchanged. Config schema (`GmftConfig`, `ChokepointConfig`, `SandboxConfig`) is already in place from phase 1.5a — we read from it but don't extend it.

**Tech Stack:** TypeScript ESM, vitest 2.1, ink-testing-library 4.0, ai SDK 4.3.19. No new top-level deps. `zod` is already a transitive dep (via `ai`); declare it direct in `packages/core` and `packages/tools` `package.json`.

**Test budget:** ~18 new test cases. v0.1 running total: 157 → ~175. `pnpm -r test` must stay green end-to-end.

**Plan conventions:**
- **Working directory for `pnpm`:** `pwd` resets to `/home/ankur` per Bash tool behavior. Always `cd /home/ankur/test/test-mob/gmft-ai && ` or use `pnpm -C` flags.
- **Branch:** created `phase3-chokepoint-tools` from `main` HEAD `fefc6e6`. Stay on this branch for all 11 tasks; merge to `main` at the end.
- **Worktree:** `/home/ankur/test/test-mob/gmft-ai/.worktrees/phase3-chokepoint-tools`. All file paths below are relative to repo root unless noted.

**Acceptance criteria (this plan is "done" when all true):**
- [ ] `chokepoint.decide({ tool, args, env })` returns `Allow | Confirm | Deny` for every rule combination tested.
- [ ] 12+ unit tests for chokepoint rules pass (allow read, deny private target, confirm destructive, deny elevated without opt-in, allow elevated with opt-in, deny bad target format, etc.).
- [ ] 3+ unit tests for executor pass (allow-runs, confirm-yes-runs, deny-returns-error).
- [ ] `tools/registry.ts` validates name `^[a-z][a-z0-9_]*$`, Zod schemas are objects, category in enum.
- [ ] `shell_exec` runs a real command (`echo hi` ⇒ `stdout="hi\n"`, `exitCode=0`), refuses `cmd="; rm -rf /"`, refuses env vars not in allowlist, returns `{stdout, stderr, exitCode, durationMs}`.
- [ ] `runner.ts` defaults to host mode when `cfg.sandbox.mode === 'host'`; logs a warning; when `'docker'`, runs in `node:20-slim` with `--network=none` and the working dir bind-mounted read-only.
- [ ] `agent/loop.ts` accepts `tools: Tool[]` and a `chokepoint: Chokepoint`; emits `ToolCallRequest`/`ToolResult`/`ConfirmationNeeded` events; `maxSteps` defaults to 5.
- [ ] `ApprovalPrompt` component shows in `ChatTab` when `useAgent` encounters a `ConfirmationNeeded` event; y/n input drives the awaiting promise.
- [ ] ADRs 0001/0002/0003 written.
- [ ] CHANGELOG entry for v0.1.0-phase3. Tag `v0.1.0-phase3` created.
- [ ] `pnpm -r build` green. `pnpm -r test` green. `pnpm -r typecheck` green. The 157 prior tests still pass.

---

## File map

### New files
- `packages/core/src/chokepoint/decision.ts` — `Decision` discriminated union + `Chokepoint` interface
- `packages/core/src/chokepoint/policy.ts` — env var reads + `ChokepointConfig` lookup
- `packages/core/src/chokepoint/rules.ts` — pure rule functions (`checkTarget`, `checkDestructive`, `checkElevation`, `isPrivateHost`)
- `packages/core/src/chokepoint/index.ts` — `createChokepoint(opts): Chokepoint` aggregator
- `packages/core/src/tools/types.ts` — `Tool<I,O>` interface, `ToolCategory` enum, `ToolFlag` enum
- `packages/core/src/tools/registry.ts` — `ToolRegistry` class (register, get, list, toAISDKTools)
- `packages/core/src/tools/executor.ts` — `execute(call, ctx, chokepoint, registry): Promise<ToolResult>`
- `packages/core/src/tools/index.ts` — barrel re-export
- `packages/tools/package.json` + `packages/tools/tsconfig.json` (new package, depends on `@gmft/core`)
- `packages/tools/src/index.ts` — `export *` from `shell/` and `shared/`
- `packages/tools/src/shared/prereq.ts` — `assertBinary(name: string): Promise<void>`
- `packages/tools/src/shared/runner.ts` — `runSandboxed(cmd, argv, opts): Promise<RunResult>`
- `packages/tools/src/shell/shell-exec.ts` — the `shell_exec` `Tool<I,O>` definition
- `packages/tools/src/shell/index.ts` — barrel
- `apps/gmft/src/ui/components/ApprovalPrompt.tsx` — Ink y/n prompt
- `docs/adr/0001-target-required.md`
- `docs/adr/0002-private-network-denylist.md`
- `docs/adr/0003-shell-exec-no-shell.md`
- `packages/core/test/chokepoint.test.ts` — 12+ cases
- `packages/core/test/tools-registry.test.ts` — 4+ cases
- `packages/core/test/tools-executor.test.ts` — 3+ cases
- `packages/tools/test/shell-exec.test.ts` — 4+ cases
- `packages/tools/test/runner.test.ts` — 2+ cases
- `apps/gmft/test/approval-prompt.test.tsx` — 2+ cases

### Modified files
- `packages/core/src/index.ts` — re-export `chokepoint/`, `tools/`, bump `VERSION` to `'0.1.0-phase3'`
- `packages/core/src/agent/loop.ts` — extend `AgentEvent` union (additive), add `tools`/`chokepoint`/`onConfirmation` to `RunTurnOpts`, drive `maxSteps > 1`, dispatch tool calls through executor
- `packages/core/src/agent/context.ts` — accept `role: 'tool'` content with `name` and optional `result` fields (already in type, just confirm shape)
- `packages/core/test/agent-loop.test.ts` — add 1+ test for tool-call event emission
- `packages/core/package.json` — add `zod` as a direct dep
- `apps/gmft/src/ui/hooks/useAgent.ts` — accept `tools: Tool[]` + `chokepoint: Chokepoint`; surface `ConfirmationNeeded` events; thread user y/n responses back via a new `respondToConfirmation(id, approved)` callback exposed by `AgentApp`
- `apps/gmft/src/AgentApp.tsx` — hold the `Map<id, (approved: boolean) => void>` and a `pendingConfirmation` rune
- `apps/gmft/src/ui/tabs/ChatTab.tsx` — render `<ApprovalPrompt>` when `pendingConfirmation` is non-null
- `pnpm-workspace.yaml` — already includes `packages/*`, no change needed
- `CHANGELOG.md` — v0.1.0-phase3 entry

### Not changing
- LLM provider surface (`createModel`, `lookupApiKey`, etc.) — unchanged.
- Config schema (`config.ts`) — `ChokepointConfig` + `SandboxConfig` already in place.
- Existing `apps/gmft` TUI layout (tab bar, status rail, etc.) — only adds a conditional `<ApprovalPrompt>`.

---

## Design decisions called out (push back if you disagree)

1. **Additive `AgentEvent` change.** The current union is `text-delta | done | error`. Phase 3 adds `tool-call-request | tool-result | confirmation-needed`. Existing `agent-loop.test.ts` cases continue to pass without edits (the `done`/`error`/`text-delta` variants are unchanged). v0.1 is the natural breaking-change window — we won't get another one until v0.2.

2. **`tools` is an array on `RunTurnOpts`, not a registry param.** The agent loop does not own the registry lifecycle. `useAgent` builds a `ToolRegistry` once at app start, gets `tool.toAISDKTools()` from it, and passes that array to `runTurn`. Keeps the loop stateless.

3. **`chokepoint` is an interface, not a class.** `createChokepoint({ cfg, env })` returns an object satisfying `Chokepoint.decide(call): Decision`. Tests can pass a fake `Chokepoint` that always returns `Allow` (for the `useAgent` happy path) or a fake that returns `Deny` (for the "chokepoint blocks" path) without dragging in env-var machinery.

4. **Confirmation is a callback, not a queue inside the loop.** `runTurn` accepts `onConfirmation(call): Promise<boolean>`. The loop emits `confirmation-needed`, awaits the callback, then either dispatches or skips. `useAgent` wires this to a `Map<id, resolver>` populated by `<ApprovalPrompt>`. The loop stays UI-agnostic.

5. **First tool: `shell_exec`, in a new `packages/tools` package.** v0.1 plan §3 lists 5+ tool categories; we ship one tool per category in later phases. `shell_exec` is the most useful + the most dangerous, so it gets the most attention. The `binary/` category is in the enum but has zero registered tools — that gap is intentional, deferred to phase 5+.

6. **Docker-first, host-fallback with warning.** When `cfg.sandbox.mode === 'docker'`, run inside `node:20-slim` with `--network=none --read-only -v $PWD:/work:ro`. When `'host'`, run the command directly. Default in `defaultConfig()` is `'host'` (Docker is opt-in for v0.1 — the chokepoint's policy is the primary defense, sandboxing is the second layer). The warning is a `console.warn` *once* at process start when host-mode is in use, not per-call.

7. **`maxSteps` defaults to 5.** Per v0.1 plan §3.2. Configurable per-turn via `RunTurnOpts.maxSteps` (for tests that want `1` or `0`).

8. **No retries on tool failure.** If a tool throws, the error becomes a `tool-result` event with `ok: false, error: <message>`, the LLM sees it, and decides what to do. The chokepoint is not in the retry path.

---

## Task 3.1 — `chokepoint/decision.ts`: the `Decision` type + `Chokepoint` interface

> **Sub-skill:** test-driven-development.

**Files:** new `packages/core/src/chokepoint/decision.ts`.

**Steps:**

- [ ] Create `packages/core/src/chokepoint/decision.ts` with:
  ```ts
  export type Decision =
    | { kind: 'allow' }
    | { kind: 'confirm'; reason: string }
    | { kind: 'deny'; reason: string };

  export interface ChokepointCall {
    tool: string;
    category: string;
    flags: readonly string[];   // e.g. ['destructive', 'targetRequired', 'requiresElevation']
    args: Record<string, unknown>;
  }

  export interface ChokepointEnv {
    allowPrivateNetworks: boolean;  // mirrors cfg.chokepoint.allowPrivateNetworks
    allowElevation: boolean;         // true iff GMFT_ALLOW_ELEVATION === 'true'
    denylist: readonly string[];     // mirrors cfg.chokepoint.denylist
  }

  export interface Chokepoint {
    decide(call: ChokepointCall): Decision;
  }
  ```

- [ ] No tests for this file alone — it's pure types. Tested transitively by `chokepoint.test.ts` in task 3.2.

---

## Task 3.2 — `chokepoint/{policy,rules,index}.ts` + 12+ rule tests

> **Sub-skill:** test-driven-development.

**Files:**
- new `packages/core/src/chokepoint/policy.ts`
- new `packages/core/src/chokepoint/rules.ts`
- new `packages/core/src/chokepoint/index.ts`
- new `packages/core/test/chokepoint.test.ts`

**`policy.ts`:**
```ts
import type { ChokepointEnv } from './decision.js';

export function readChokepointEnv(opts: {
  cfg: { chokepoint: { allowPrivateNetworks: boolean; denylist: string[] } };
  env?: NodeJS.ProcessEnv;  // injectable for tests
}): ChokepointEnv {
  const env = opts.env ?? process.env;
  return {
    allowPrivateNetworks: opts.cfg.chokepoint.allowPrivateNetworks,
    allowElevation: env.GMFT_ALLOW_ELEVATION === 'true',
    denylist: opts.cfg.chokepoint.denylist,
  };
}
```

**`rules.ts`:**
```ts
import type { Decision, ChokepointCall, ChokepointEnv } from './decision.js';

const TARGET_RE = /^[a-zA-Z0-9._-]+$/;
const PRIVATE_HOSTS = new Set(['localhost', 'ip6-localhost', 'ip6-loopback']);
const PRIVATE_IPV4 = [
  /^10\./,                      // 10.0.0.0/8
  /^192\.168\./,                // 192.168.0.0/16
  /^172\.(1[6-9]|2[0-9]|3[01])\./,  // 172.16.0.0/12
  /^127\./,                     // 127.0.0.0/8 (loopback)
  /^169\.254\./,                // 169.254.0.0/16 (link-local)
];

function isPrivateHost(target: string): boolean {
  if (PRIVATE_HOSTS.has(target.toLowerCase())) return true;
  for (const re of PRIVATE_IPV4) if (re.test(target)) return true;
  return false;
}

export function checkTarget(call: ChokepointCall, env: ChokepointEnv): Decision | null {
  if (!call.flags.includes('targetRequired')) return null;
  const target = call.args.target;
  if (typeof target !== 'string' || target.length === 0) {
    return { kind: 'deny', reason: 'target required (missing)' };
  }
  if (!TARGET_RE.test(target)) {
    return { kind: 'deny', reason: `target "${target}" contains illegal characters` };
  }
  if (!env.allowPrivateNetworks && isPrivateHost(target)) {
    return { kind: 'deny', reason: `target "${target}" is in a private network range (set GMFT_ALLOW_PRIVATE=true to override)` };
  }
  if (env.denylist.includes(target)) {
    return { kind: 'deny', reason: `target "${target}" is on the chokepoint denylist` };
  }
  return null;
}

export function checkDestructive(call: ChokepointCall): Decision | null {
  if (!call.flags.includes('destructive')) return null;
  return {
    kind: 'confirm',
    reason: `tool "${call.tool}" is destructive; confirm to proceed`,
  };
}

export function checkElevation(call: ChokepointCall, env: ChokepointEnv): Decision | null {
  if (!call.flags.includes('requiresElevation')) return null;
  if (!env.allowElevation) {
    return { kind: 'deny', reason: `tool "${call.tool}" requires GMFT_ALLOW_ELEVATION=true` };
  }
  return null;
}
```

**`index.ts`:**
```ts
import type { Chokepoint, ChokepointCall, Decision, ChokepointEnv } from './decision.js';
import { checkTarget, checkDestructive, checkElevation } from './rules.js';

export function createChokepoint(env: ChokepointEnv): Chokepoint {
  return {
    decide(call: ChokepointCall): Decision {
      return (
        checkElevation(call, env) ??
        checkDestructive(call) ??
        checkTarget(call, env) ??
        { kind: 'allow' }
      );
    },
  };
}

export type { Decision, Chokepoint, ChokepointCall, ChokepointEnv } from './decision.js';
export { readChokepointEnv } from './policy.js';
```

**`chokepoint.test.ts`** — 12 cases:
1. read-only tool, no target, no flags → `allow`
2. `targetRequired` + valid target `example.com` → `allow`
3. `targetRequired` + missing target → `deny` with "missing"
4. `targetRequired` + target `foo bar` → `deny` (illegal char)
5. `targetRequired` + target `10.0.0.1`, default cfg → `deny` (private)
6. `targetRequired` + target `10.0.0.1`, `allowPrivateNetworks: true` → `allow`
7. `targetRequired` + target `127.0.0.1`, `allowPrivateNetworks: false` → `deny` (loopback)
8. `targetRequired` + target `localhost` → `deny` (private host)
9. `targetRequired` + target in `denylist` array → `deny`
10. `destructive` flag → `confirm`
11. `requiresElevation` without `allowElevation` → `deny`
12. `requiresElevation` with `allowElevation: true` → `allow` (assuming target checks pass)
13. (bonus) elevation + bad target → `deny` (elevation check fires first)
14. (bonus) destructive + target check passes → `confirm` (destructive fires first)

Tests use the order in `decide`: elevation → destructive → target → allow. Document this order in a comment.

---

## Task 3.3 — `tools/types.ts` + `tools/registry.ts` + tests

> **Sub-skill:** test-driven-development.

**Files:**
- new `packages/core/src/tools/types.ts`
- new `packages/core/src/tools/registry.ts`
- new `packages/core/src/tools/index.ts`
- new `packages/core/test/tools-registry.test.ts`

**`types.ts`:**
```ts
import { z } from 'zod';

export type ToolCategory =
  | 'shell'        // run commands (sandboxed or host)
  | 'http'         // make HTTP requests
  | 'file'         // read/write local files
  | 'search'       // search code/content
  | 'recon'        // network recon (nmap-style, future)
  | 'binary'       // invoke a security tool binary
  | 'note';        // scratchpad / no side effects

export const TOOL_CATEGORIES: readonly ToolCategory[] = [
  'shell', 'http', 'file', 'search', 'recon', 'binary', 'note',
];

export interface Tool<I extends z.ZodTypeAny, O extends z.ZodTypeAny> {
  name: string;          // ^[a-z][a-z0-9_]*$
  category: ToolCategory;
  description: string;
  input: I;              // zod schema
  output: O;             // zod schema
  flags: readonly string[];  // e.g. ['destructive', 'targetRequired']
  run(args: z.infer<I>, ctx: ToolContext): Promise<z.infer<O>>;
}

export interface ToolContext {
  cwd: string;
  env: NodeJS.ProcessEnv;
  cfg: { sandbox: { mode: 'docker' | 'host'; defaultImage?: string } };
}
```

**`registry.ts`:**
```ts
import { z } from 'zod';
import type { Tool, ToolCategory } from './types.js';
import { TOOL_CATEGORIES } from './types.js';

const NAME_RE = /^[a-z][a-z0-9_]*$/;

export class ToolRegistry {
  private tools = new Map<string, Tool<z.ZodTypeAny, z.ZodTypeAny>>();

  register<I extends z.ZodTypeAny, O extends z.ZodTypeAny>(tool: Tool<I, O>): void {
    if (!NAME_RE.test(tool.name)) {
      throw new Error(`tool name "${tool.name}" must match ${NAME_RE}`);
    }
    if (!TOOL_CATEGORIES.includes(tool.category)) {
      throw new Error(`tool category "${tool.category}" not in enum`);
    }
    if (!(tool.input instanceof z.ZodObject)) {
      throw new Error(`tool "${tool.name}" input must be a z.object()`);
    }
    if (!(tool.output instanceof z.ZodObject)) {
      throw new Error(`tool "${tool.name}" output must be a z.object()`);
    }
    if (this.tools.has(tool.name)) {
      throw new Error(`tool "${tool.name}" already registered`);
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool<z.ZodTypeAny, z.ZodTypeAny> | undefined {
    return this.tools.get(name);
  }

  list(): readonly Tool<z.ZodTypeAny, z.ZodTypeAny>[] {
    return [...this.tools.values()];
  }

  /** Convert registered tools to AI SDK's `tools` record for `streamText`. */
  toAISDKTools(): Record<string, { description: string; parameters: z.ZodTypeAny }> {
    const out: Record<string, { description: string; parameters: z.ZodTypeAny }> = {};
    for (const t of this.tools.values()) {
      out[t.name] = { description: t.description, parameters: t.input };
    }
    return out;
  }
}
```

**`index.ts`:**
```ts
export * from './types.js';
export * from './registry.js';
```

**`tools-registry.test.ts`** — 4+ cases:
1. Register a valid tool, get returns it, list contains it
2. Register with bad name `Shell-Exec` (uppercase + dash) → throws
3. Register with bad category `'evil'` → throws
4. Register with non-zod input → throws
5. Register same name twice → throws
6. `toAISDKTools` produces a record with one entry per tool

Use a minimal fixture tool:
```ts
const echoTool: Tool<typeof echoIn, typeof echoOut> = {
  name: 'echo',
  category: 'note',
  description: 'returns the input',
  input: z.object({ text: z.string() }),
  output: z.object({ echoed: z.string() }),
  flags: [],
  async run({ text }) { return { echoed: text }; },
};
```

---

## Task 3.4 — `tools/executor.ts` + 3 scenario tests

> **Sub-skill:** test-driven-development.

**Files:**
- new `packages/core/src/tools/executor.ts`
- new `packages/core/test/tools-executor.test.ts`

**`executor.ts`:**
```ts
import { z } from 'zod';
import type { ToolRegistry } from './registry.js';
import type { ToolContext } from './types.js';
import type { Chokepoint, ChokepointCall, Decision } from '../chokepoint/index.js';

export interface ExecuteCall {
  name: string;
  args: Record<string, unknown>;
}

export type ExecuteResult =
  | { ok: true; output: unknown; decision: Decision }
  | { ok: false; reason: string; decision: Decision };

export async function execute(
  call: ExecuteCall,
  ctx: ToolContext,
  chokepoint: Chokepoint,
  registry: ToolRegistry,
  opts: { onConfirmation?: (call: ExecuteCall) => Promise<boolean> } = {},
): Promise<ExecuteResult> {
  const tool = registry.get(call.name);
  if (!tool) return { ok: false, reason: `unknown tool "${call.name}"`, decision: { kind: 'deny', reason: 'unknown' } };

  // Validate args against the tool's input schema
  const parsed = tool.input.safeParse(call.args);
  if (!parsed.success) {
    return { ok: false, reason: `invalid args: ${parsed.error.message}`, decision: { kind: 'deny', reason: 'invalid args' } };
  }

  // Chokepoint check
  const chokepointCall: ChokepointCall = {
    tool: tool.name,
    category: tool.category,
    flags: tool.flags,
    args: parsed.data,
  };
  const decision = chokepoint.decide(chokepointCall);

  if (decision.kind === 'deny') {
    return { ok: false, reason: decision.reason, decision };
  }
  if (decision.kind === 'confirm') {
    if (!opts.onConfirmation) {
      return { ok: false, reason: `tool "${tool.name}" needs confirmation but no handler provided`, decision };
    }
    const approved = await opts.onConfirmation(call);
    if (!approved) {
      return { ok: false, reason: 'user denied confirmation', decision };
    }
  }

  // Run the tool
  try {
    const output = await tool.run(parsed.data, ctx);
    const validated = tool.output.parse(output);
    return { ok: true, output: validated, decision };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err), decision };
  }
}
```

**`tools-executor.test.ts`** — 3 cases:
1. **Allow path:** fake chokepoint returns `{ kind: 'allow' }`, registry has `echo` tool, executor returns `{ ok: true, output: { echoed: 'hi' } }`.
2. **Confirm-yes path:** fake chokepoint returns `{ kind: 'confirm' }`, `onConfirmation` resolves `true`, executor runs the tool.
3. **Deny path:** fake chokepoint returns `{ kind: 'deny', reason: 'foo' }`, executor returns `{ ok: false, reason: 'foo' }` and never calls `tool.run`.

Use a fake chokepoint (a one-method object) and the same `echo` fixture from task 3.3.

---

## Task 3.5 — Wire executor into `agent/loop.ts` + `ApprovalPrompt` component

> **Sub-skill:** executing-plans (modifies existing files across two packages; integration-heavy).

**Files modified:**
- `packages/core/src/agent/loop.ts` — extend `AgentEvent` union; add `tools`/`chokepoint`/`onConfirmation` opts; drive `maxSteps`; dispatch tool calls through executor
- `packages/core/test/agent-loop.test.ts` — add 1 test for tool-call event emission
- `apps/gmft/src/ui/hooks/useAgent.ts` — accept tools + chokepoint; surface `ConfirmationNeeded`; thread y/n back
- `apps/gmft/src/AgentApp.tsx` — hold `Map<id, resolver>` + `pendingConfirmation` rune
- `apps/gmft/src/ui/tabs/ChatTab.tsx` — render `<ApprovalPrompt>` when pending
- new `apps/gmft/src/ui/components/ApprovalPrompt.tsx`
- new `apps/gmft/test/approval-prompt.test.tsx`

**`AgentEvent` extension (additive):**
```ts
export type AgentEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'done'; text: string }
  | { type: 'error'; error: Error }
  | { type: 'tool-call-request'; id: string; name: string; args: Record<string, unknown> }
  | { type: 'tool-result'; id: string; ok: boolean; output?: unknown; reason?: string }
  | { type: 'confirmation-needed'; id: string; name: string; reason: string };
```

**`RunTurnOpts` extension:**
```ts
export interface RunTurnOpts {
  // ...existing fields...
  tools?: readonly Tool<z.ZodTypeAny, z.ZodTypeAny>[];
  chokepoint?: Chokepoint;
  onConfirmation?: (call: { id: string; name: string; args: Record<string, unknown>; reason: string }) => Promise<boolean>;
  ctx?: ToolContext;
  maxSteps?: number;  // default 5
}
```

**Loop logic:**
- If `tools` is empty/undefined, behavior is unchanged (existing tests pass).
- Otherwise, build a `ToolRegistry` from the array, call `streamText({ ..., tools: registry.toAISDKTools(), maxSteps })`.
- In the chunk loop, intercept `chunk.type === 'tool-call'` and `'tool-result'`:
  - On `tool-call`: yield `tool-call-request` event, call `chokepoint.decide(...)`, if `Confirm` yield `confirmation-needed` and `await onConfirmation(...)`, then call `executor.execute(...)`, yield `tool-result` event.
  - On `tool-result` from the SDK: re-emit as our `tool-result` event for consistency.
- Note: the AI SDK's `streamText` with `tools` + `maxSteps > 1` does the tool-call dispatch internally. We don't *replace* that — we observe it. The chokepoint hooks into the executor, which sits *between* the SDK's tool-call detection and the actual `tool.run()`. This means our chokepoint check is mandatory because we control `executor.execute`, not the SDK.

Actually, reading the AI SDK 4.3 source: `streamText` with `tools` will call `tool.execute(args, options)` for each tool call. We can pass `execute` wrappers that call the chokepoint. That's the cleanest seam.

Revised approach:
- `ToolRegistry.toAISDKTools()` returns `{ [name]: { description, parameters, execute } }` where `execute` wraps the chokepoint check + `tool.run`.
- The agent loop just passes those to `streamText({ tools })`.
- The loop still yields `tool-call-request`, `tool-result`, `confirmation-needed` events by hooking into `result.fullStream` chunks.

This means the executor lives *inside* the AI SDK's `execute` wrapper. The standalone `executor.ts` from task 3.4 is the testable unit; the loop calls it indirectly via the wrapper.

**`<ApprovalPrompt>` component:**
```tsx
import React from 'react';
import { Box, Text } from 'ink';
import { useInput } from 'ink';

export interface ApprovalPromptProps {
  reason: string;
  onResponse: (approved: boolean) => void;
}

export function ApprovalPrompt({ reason, onResponse }: ApprovalPromptProps) {
  useInput((input, key) => {
    if (key.return || input === 'y' || input === 'Y') onResponse(true);
    else if (input === 'n' || input === 'N' || key.escape) onResponse(false);
  });
  return (
    <Box borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text color="yellow">⚠ </Text>
      <Text>{reason} </Text>
      <Text color="gray">[y/N]</Text>
    </Box>
  );
}
```

**`useAgent.ts` changes:** accept `tools: Tool[]` + `chokepoint: Chokepoint` in opts. Pass them to `runTurn`. On `confirmation-needed` event, set a rune; on response, resolve the promise.

**`AgentApp.tsx` changes:** hold `const pendingConfirmation = $state<{ id: string; reason: string; resolve: (b: boolean) => void } | null>(null)`. Pass `respondToConfirmation` down to `useAgent` which stashes the resolver.

**`ChatTab.tsx` changes:** render `<ApprovalPrompt>` if `pendingConfirmation` is non-null, below the message list.

**`approval-prompt.test.tsx`** — 2 cases:
1. Render with reason, press `y`, `onResponse` called with `true`.
2. Render with reason, press `n`, `onResponse` called with `false`.

Use `ink-testing-library` per memory note (3 nested `setImmediate`s after `render()`, `unmount()` in `afterEach`).

---

## Task 3.6 — `packages/tools` package + `shell/shell-exec.ts`

> **Sub-skill:** test-driven-development.

**Files:**
- new `packages/tools/package.json` (depends on `@gmft/core`, `zod`)
- new `packages/tools/tsconfig.json` (extends root config)
- new `packages/tools/src/index.ts` (barrel)
- new `packages/tools/src/shell/shell-exec.ts`
- new `packages/tools/src/shell/index.ts`
- new `packages/tools/test/shell-exec.test.ts`

**`packages/tools/package.json`:**
```json
{
  "name": "@gmft/tools",
  "version": "0.1.0-phase3",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": "./dist/index.js"
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "@gmft/core": "workspace:*",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "vitest": "^2.1.0",
    "typescript": "^5.6.0"
  }
}
```

**`shell-exec.ts`:**
```ts
import { z } from 'zod';
import type { Tool } from '@gmft/core';
import { runSandboxed } from '../shared/runner.js';

const input = z.object({
  cmd: z.string().min(1).max(256),
  args: z.array(z.string().min(1).max(1024)).max(64).default([]),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
});

const output = z.object({
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number().int(),
  durationMs: z.number().int().nonnegative(),
});

const FORBIDDEN_CMD_CHARS = /[;&|`$<>]/;
const ENV_ALLOWLIST = new Set(['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR']);

export const shellExec: Tool<typeof input, typeof output> = {
  name: 'shell_exec',
  category: 'shell',
  description: 'Run a command. No shell, no &&, no ;. Args array, not a string.',
  input,
  output,
  flags: ['destructive', 'targetRequired'],
  async run(raw, ctx) {
    if (FORBIDDEN_CMD_CHARS.test(raw.cmd)) {
      throw new Error(`cmd contains forbidden shell metacharacter: ${raw.cmd}`);
    }
    for (const a of raw.args) {
      if (FORBIDDEN_CMD_CHARS.test(a)) {
        throw new Error(`argv contains forbidden shell metacharacter: ${a}`);
      }
    }
    const env: NodeJS.ProcessEnv = { ...ctx.env };
    if (raw.env) {
      for (const [k, v] of Object.entries(raw.env)) {
        if (!ENV_ALLOWLIST.has(k)) {
          throw new Error(`env var "${k}" not in allowlist (${[...ENV_ALLOWLIST].join(', ')})`);
        }
        env[k] = v;
      }
    }
    return runSandboxed(raw.cmd, raw.args, {
      cwd: raw.cwd ?? ctx.cwd,
      env,
      sandbox: ctx.cfg.sandbox,
    });
  },
};
```

Wait — `flags: ['destructive', 'targetRequired']` doesn't quite fit because `targetRequired` is checked against `args.target`, but `shell_exec` has no `target` field. Two options:
- (a) Drop `targetRequired` from `shell_exec`; only flag it as `destructive` (which is the relevant gate).
- (b) Add an optional `target` field to `shell_exec` input that is checked.

Option (a) is cleaner. The chokepoint's `checkTarget` only fires when `targetRequired` is set, so dropping it means `shell_exec` doesn't need a `target` field. **Decision: option (a).** `shell_exec.flags = ['destructive']`.

**`shell-exec.test.ts`** — 4 cases:
1. `echo hi` → `{ stdout: 'hi\n', stderr: '', exitCode: 0, durationMs: >=0 }`
2. `cmd: "rm -rf /; echo pwned"` → throws (forbidden char `;`)
3. `cmd: "echo hi", env: { "PATH": "/tmp" }` → ok (allowlisted)
4. `cmd: "echo hi", env: { "AWS_SECRET_ACCESS_KEY": "..." }` → throws (not in allowlist)

---

## Task 3.7 — `packages/tools/src/shared/{prereq,runner}.ts`

> **Sub-skill:** test-driven-development.

**`prereq.ts`:**
```ts
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';

export async function assertBinary(name: string): Promise<void> {
  // Resolve via PATH. Node 20 has no built-in `which`; we shell out.
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const exec = promisify(execFile);
  try {
    await exec('which', [name]);
  } catch {
    throw new Error(`required binary "${name}" not found in PATH`);
  }
}
```

(That `await import` dance is awkward — simplify to a top-level `import { execFile }` + `import { promisify }`. Use `util.promisify` style.)

**`runner.ts`:**
```ts
import { spawn } from 'node:child_process';

export interface RunOpts {
  cwd: string;
  env: NodeJS.ProcessEnv;
  sandbox: { mode: 'docker' | 'host'; defaultImage?: string };
  /** Wall-clock timeout in ms. Default 30s. */
  timeoutMs?: number;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

export async function runSandboxed(
  cmd: string,
  argv: readonly string[],
  opts: RunOpts,
): Promise<RunResult> {
  if (opts.sandbox.mode === 'docker') {
    return runInDocker(cmd, argv, opts);
  }
  return runHost(cmd, argv, opts);
}

async function runHost(cmd: string, argv: readonly string[], opts: RunOpts): Promise<RunResult> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, argv, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`command "${cmd}" timed out after ${opts.timeoutMs ?? 30000}ms`));
    }, opts.timeoutMs ?? 30000);
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? 1, durationMs: Date.now() - start });
    });
  });
}

async function runInDocker(cmd: string, argv: readonly string[], opts: RunOpts): Promise<RunResult> {
  const image = opts.sandbox.defaultImage ?? 'node:20-slim';
  const dockerArgs = [
    'run', '--rm',
    '--network=none',
    '--read-only',
    '-v', `${opts.cwd}:/work:ro`,
    '-w', '/work',
    image, cmd, ...argv,
  ];
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn('docker', dockerArgs, {
      env: opts.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`docker run timed out`));
    }, opts.timeoutMs ?? 30000);
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? 1, durationMs: Date.now() - start });
    });
  });
}
```

**`runner.test.ts`** — 2 cases:
1. `runSandboxed('echo', ['hi'], { cwd, env: {}, sandbox: { mode: 'host' } })` → `stdout: 'hi\n'`, `exitCode: 0`
2. `runSandboxed('false', [], ...)` → `exitCode: 1`

(Docker test is skipped — same reason as blackglass: no docker socket in this env. Code path is exercised in the test by checking `mode === 'host'` works. Docker path is verified by code review + ADR.)

---

## Task 3.8 — ADRs 0001, 0002, 0003

> **Sub-skill:** executing-plans (writing docs, no code).

**Files:**
- new `docs/adr/0001-target-required.md`
- new `docs/adr/0002-private-network-denylist.md`
- new `docs/adr/0003-shell-exec-no-shell.md`

Each ADR follows the format from any existing ADR in `docs/adr/`. If none exist, use the Nygard template:

```md
# ADR-0001: Target is required for tools that touch the network

## Status
Accepted (2026-06-15, Phase 3).

## Context
[1-paragraph problem statement]

## Decision
[What we decided]

## Consequences
[Trade-offs + escape hatches]
```

**ADR 0001** — Target is required for any tool that touches the network. Rationale: prevents wildcard / "scan everything" / accidental `target: 0.0.0.0/0`. Format `^[a-zA-Z0-9._-]+$` keeps it sane.

**ADR 0002** — Private networks are denied by default. RFC1918 + loopback + link-local + `.internal` + denylist config. Opt-out: `chokepoint.allowPrivateNetworks: true` in config OR `GMFT_ALLOW_PRIVATE=true` env. (Note: v0.1's policy reads from cfg, env override is a phase 4 addition.)

**ADR 0003** — `shell_exec` never invokes a shell. Args are an array, `cmd` is validated against `[;&|` $<>]` regex, env is allowlist-only (`PATH, HOME, LANG, LC_ALL, TZ, TMPDIR`). Rationale: shell injection is the #1 LLM-tool vuln (OWASP LLM01); array form + allowlist closes it.

---

## Task 3.9 — Re-exports + `VERSION` bump in `packages/core/src/index.ts`

> **Sub-skill:** executing-plans.

**File:** `packages/core/src/index.ts`.

**Changes:**
- Bump `VERSION` from `'0.1.0-phase1.5f'` to `'0.1.0-phase3'`.
- Add re-exports:
  ```ts
  export { createChokepoint, readChokepointEnv, type Chokepoint, type ChokepointCall, type ChokepointEnv, type Decision } from './chokepoint/index.js';
  export { ToolRegistry, type Tool, type ToolCategory, type ToolContext, TOOL_CATEGORIES } from './tools/index.js';
  export { execute, type ExecuteCall, type ExecuteResult } from './tools/executor.js';
  ```
- Also add `z` to the dependency list in `packages/core/package.json` (it was a transitive dep via `ai`, now direct).

---

## Task 3.10 — CHANGELOG + tag

> **Sub-skill:** finishing-a-development-branch.

**File:** `CHANGELOG.md` (root, already exists from 1.5e? — check first; create if missing).

**Entry:**
```md
## [0.1.0-phase3] - 2026-06-15

### Added
- **Chokepoint** — `packages/core/src/chokepoint/`. The single gate every tool
  call flows through. `Decision = Allow | Confirm | Deny`. Three built-in
  rules: target-required (regex + private-network denylist), destructive
  (Confirm), requiresElevation (env-var opt-in). See ADR-0001/0002/0003.
- **Tool registry** — `packages/core/src/tools/registry.ts`. Validates name
  `^[a-z][a-z0-9_]*$`, Zod input/output, category in enum. Exposes
  `toAISDKTools()` for `streamText` integration.
- **Tool executor** — `packages/core/src/tools/executor.ts`. Parses args with
  Zod, consults chokepoint, dispatches Allow/Confirm/Deny.
- **`shell_exec` tool** — `packages/tools/src/shell/shell-exec.ts`. First
  real tool. No shell, no `&&`/`;`, env allowlist
  (`PATH, HOME, LANG, LC_ALL, TZ, TMPDIR`), returns
  `{ stdout, stderr, exitCode, durationMs }`.
- **Sandbox runner** — `packages/tools/src/shared/runner.ts`. Docker-first
  (with `--network=none --read-only`), host-fallback with warning.
- **Agent loop v2** — `runTurn` accepts `tools` + `chokepoint` +
  `onConfirmation`; emits `ToolCallRequest` / `ToolResult` / `ConfirmationNeeded`
  events; `maxSteps` defaults to 5.
- **ApprovalPrompt** — Ink component shown in `ChatTab` when chokepoint
  returns Confirm. y/N input drives the awaiting promise.
- **ADRs** — `docs/adr/0001-target-required.md`, `0002-private-network-denylist.md`,
  `0003-shell-exec-no-shell.md`.

### Test count
157 → ~175 (+18).
```

**Tag:**
```bash
cd /home/ankur/test/test-mob/gmft-ai
git tag -a v0.1.0-phase3 -m "Phase 3: chokepoint + tool registry + shell_exec"
```

---

## Task 3.11 — Build, test, typecheck, merge

> **Sub-skill:** verification-before-completion.

**Commands (run from repo root):**
```bash
cd /home/ankur/test/test-mob/gmft-ai/.worktrees/phase3-chokepoint-tools
pnpm install                                    # picks up @gmft/tools in workspace
pnpm -r typecheck
pnpm -r build
pnpm -r test
```

**Expected:**
- All builds clean.
- All 175+ tests green.
- 0 typecheck errors.

**Then:**
```bash
git add -A
git commit -m "feat(core+tools+app): chokepoint + tool registry + shell_exec (phase 3)"
git push -u origin phase3-chokepoint-tools
# Fetch main, rebase if needed
git fetch origin main
git rebase origin/main
git push -u origin phase3-chokepoint-tools --force-with-lease
# Merge to main
cd /home/ankur/test/test-mob/gmft-ai
git checkout main
git merge --ff-only phase3-chokepoint-tools
git push origin main
```

The user may want to merge via PR — defer to their preference. Per the v0.1 plan and prior phase conventions (1.5c, 1.5d, 1.5e, 1.5f, 1.5g all merged directly with `git merge --ff-only`), this plan assumes direct merge. If they want a PR, swap the last step for `gh pr create`.

---

## Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| AI SDK 4.3 `streamText` tool-call dispatch doesn't fire the wrapper `execute` as documented | Med | High | The standalone `executor.ts` from task 3.4 is independently tested with a fake chokepoint, so we have a fallback. If the wrapper path breaks, we drive the loop manually (intercept `tool-call` chunks, call executor directly, inject `tool-result` messages into history). |
| `useAgent.ts` refactor breaks the 78 existing app tests | Med | Med | The refactor is additive (`tools` + `chokepoint` are optional). Existing tests pass `undefined` for both. The new `ConfirmationNeeded` event is a no-op for the existing happy path. |
| Docker mode can't be tested in this env | High | Low | The Docker code path is unit-tested by code review + ADR. The host path is integration-tested with real `echo`/`false`. |
| `ink-testing-library` races in `approval-prompt.test.tsx` | Med | Low | Memory note already documents the 3-`setImmediate` fix. |
| Bash CWD resets to `/home/ankur` per invocation | Low | Low | All commands prefix with `cd /home/ankur/test/test-mob/gmft-ai/.worktrees/phase3-chokepoint-tools && `. |

---

## Out of scope (deferred to later phases)

- HTTP tools, file tools, search tools, recon tools, binary tools — phase 4-5.
- `GMFT_ALLOW_PRIVATE` env-var override (currently config-only) — phase 4.
- Real cl100k_base token counting — already deferred to phase 2; still deferred.
- `MemoryStore` interface (currently TF-IDF) — phase 2 deferred; still deferred.
- `<ApprovalPrompt>` styling polish (colors, icons, multi-line) — phase 6 polish.
- Audit log of tool calls (separate from session log) — phase 6 safety.
- `docs/safety.md` (full threat model) — phase 6.

---

**End of plan.**
