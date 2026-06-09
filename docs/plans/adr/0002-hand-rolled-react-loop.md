# ADR-0002: Hand-rolled ReAct loop, not LangChain

**Status**: Accepted (proposed 2026-06-08)
**Phase**: Plan (lands in phase 2)

## Context

GMFT-AI is a chat-first TUI. The agent loop is on the hot path — every streamed
delta hits the renderer. We must pick how to drive the LLM and tool calls.

## Decision

**Hand-rolled ReAct loop** built around Vercel AI SDK's `streamText`. ~80 lines
in `packages/core/src/agent/loop.ts`.

## Rationale

1. **Streaming is a first-class concern.** LangChain.js streams, but its tool-call
   abstractions are sync, and the message-shape conversions leak through the API.
   Vercel AI SDK exposes `streamText` as an `AsyncIterable` of typed events; we
   can `for await` and re-render at each delta.
2. **TUI state model**: each event is a typed `AgentEvent` (`Delta | ToolCallRequest
   | ToolResult | ConfirmationNeeded | Done | Error`). The TUI subscribes via a
   `useAgent` hook and renders. No opaque framework internals.
3. **Chokepoint integration**: the loop *must* be able to pause for human approval
   on a destructive tool call. A hand-rolled loop makes this a 5-line `await` on a
   `Promise<boolean>`. A framework would force us to invent a callback registry.
4. **Testability**: a scripted `fake-llm` returning canned streams drives
   deterministic tests of the full loop. No LLM in the loop for unit tests.
5. **Bundle size**: Vercel AI SDK + a thin loop is ~150 KB minified. LangChain.js
   is ~2 MB. Matters less for a CLI binary; matters more for the TUI's render
   budget.

## Trade-offs accepted

- **We re-invent a few things LangChain gives free**: prompt templates, output
  parsers, retry policies, token counting. For each: we accept the re-implementation
  cost (each is ~30 lines) in exchange for the simpler model.
- **No built-in agent observability.** v0.2 may add Langfuse, but only because we
  control the loop, not because we adopted the framework.

## Consequences

- `packages/core/src/agent/loop.ts` is the most important file in the repo.
  Treat it like a kernel.
- The `tool()` helper from Vercel AI SDK is used for tool definitions; we own the
  execution path.
- A `fake-llm` test helper in `packages/testkit` exists from day 1.
