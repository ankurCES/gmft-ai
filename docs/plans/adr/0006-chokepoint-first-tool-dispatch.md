# ADR-0006: Chokepoint-first tool dispatch

**Status**: Accepted (2026-06-15)
**Phase**: 3 (lands in v0.1.0-phase3)

## Context

v0.1's `runTurn` was a single `streamText` call with `maxSteps: 1`. The
provider's SDK decides when to call tools (or not). For a tool-using
pentesting agent, this is a safety problem: the model can call *any*
tool exposed to it, and there's no place in the host code to ask "is
this OK?" before execution. We need a single seam where every
tool call is funnelled, examined, and either approved, denied, or
mutated before it runs.

The Vercel AI SDK exposes tool execution through `streamText`'s
`experimental_prepareStepTools` (for picking tools per step) and
`experimental_onToolCall` (a stream hook). The SDK still calls the
tool internally, so the hook can observe but not gate. To gate, we
must run our own dispatch loop outside the SDK and feed results back
in.

## Decision

**All tool calls route through `@gmft/core`'s chokepoint.** The
agent loop is a hand-rolled dispatch loop in
`packages/core/src/agent/loop.ts` that:

1. Calls `streamText` for one step at a time.
2. Inspects the resulting `tool-call` chunks.
3. Passes each call through `Chokepoint.evaluate()` → returns
   `Confirm | Allow | Deny | Mutate`.
4. Resolves the decision against the active `Policy` (per-action
   rules) and the user's `Decision` if `Confirm`.
5. Executes approved calls via `ToolRegistry` and feeds the
   `tool-result` back into the next `streamText` step.

Tools in `@gmft/tools` are the *only* tools exposed to the model.
They declare a `riskClass` and an optional `requiresElevation` flag
that the chokepoint reads; the model has no way to call a tool that
isn't registered.

## Rationale

1. **A single chokepoint is auditable.** Logging, redacting, and
   gating all happen in `Chokepoint.evaluate()`. Adding a new
   safety check (e.g. "deny all tools when offline") is a one-line
   policy edit, not a hunt across tool implementations.
2. **The loop is testable without a model.** `tool-dispatch.ts`
   takes a stream of `tool-call` chunks + a registry + a chokepoint
   and produces a stream of `tool-result` chunks deterministically.
   The 4 `tool-dispatch.test.ts` cases cover allow / deny / confirm
   / mutate paths in under 50ms.
3. **The model's view of tools is narrow by construction.** The
   registry is the only thing exposed to `streamText`. The
   `riskClass` / `requiresElevation` metadata is *not* sent to the
   model — the chokepoint owns the policy, the model only sees the
   tool name + schema.
4. **Provider portability.** The hand-rolled loop works identically
   on OpenAI, Anthropic, Google, OpenRouter, and Ollama because we
   never depend on provider-specific tool-calling extensions. We
   only depend on the Vercel AI SDK's normalised chunk types.

## Trade-offs accepted

- **We re-implement loop plumbing.** The SDK's `maxSteps: N` +
   auto tool-call mode is gone. The cost is ~120 LoC of loop code
   in `loop.ts` that we own. The benefit is a single audit point.
- **Tool schemas must be Zod.** The Vercel AI SDK uses Zod for tool
   input schemas, so the registry's `Tool<I, O>` is `Tool<ZodType,
   ZodTypeAny>`. We don't expose raw JSON-schema tools; this is
   fine because Zod is already a dep of `@gmft/core`.
- **The loop is sequential.** No parallel tool calls. v0.1's
   pentesting workflow rarely needs them; v0.2 may add
   `Promise.all` for read-only tools (`whois`, `dig`,
   `tshark_read`).

## Consequences

- `packages/core/src/chokepoint/` is the new safety spine: 4 files
  (`decision.ts`, `policy.ts`, `rules.ts`, `index.ts`), 23 tests.
- `packages/core/src/tools/` provides `Tool<II, OO>`,
  `ToolRegistry`, and `executeTools()`. Tools register at
  construction; unregistering is a no-op for v0.1.
- `runTurn` now emits `tool-call | tool-result | confirmation |
  approve | deny | text-delta | done | error` events. The TUI
  reacts to each.
- The `ApprovalPrompt` component in `apps/gmft/src/ui/components/`
  is the user-facing chokepoint surface. A pending confirmation
  always shows above the active tab.
