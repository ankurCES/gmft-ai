/**
 * The single chokepoint + dispatch path. Every tool invocation
 * — from the agent loop, from a test, from a future REST/gRPC
 * surface — funnels through `execute(call, ctx, chokepoint, registry)`.
 *
 * Steps:
 *   1. Look up the tool in the registry. Unknown tool ⇒ deny.
 *   2. Validate `args` against the tool's Zod input schema.
 *   3. Ask the chokepoint for a `Decision`.
 *      - `deny`        ⇒ return `{ ok: false, reason, decision, denied: true }`
 *      - `confirm`     ⇒ call `opts.onConfirmation(call, decision)`.
 *      - `type-then-confirm` ⇒ same; UI uses `decision.prompt` to render
 *                         a type-to-confirm input.
 *      - `allow`       ⇒ run `tool.run(parsed.data, ctxWithInnerRunner)`.
 *   4. Validate the runner's output against the tool's Zod output schema.
 *   5. If the tool's output has a `findings: Finding[]` field, append
 *      each finding to `opts.findingsStore` (when provided).
 *   6. Return `{ ok: true, output, decision, findings }`.
 *
 * The executor does *not* retry on tool failure; the LLM sees the
 * error via the `tool-result` event and decides what to do next.
 *
 * v0.1 phase 6 — `runInner` is the public seam the `attack_chain` tool
 * recurses through. The chain tool sets `suppressTypeToConfirm: true`
 * on its innerRunner calls so the per-step elevated friction is
 * covered by the chain's own `typeToConfirm: 'attack'` literal. The
 * destructive + target checks still fire per step.
 */

import type { z } from 'zod';
import type { ToolRegistry } from './registry.js';
import type { ToolContext } from './types.js';
import type { Chokepoint, ChokepointCall, Decision } from '../chokepoint/index.js';
import type { FindingsStore } from '../findings/store.js';
import type { Finding } from '../findings/index.js';

export interface ExecuteCall {
  name: string;
  args: Record<string, unknown>;
}

/**
 * The executor's result. On success, the tool's validated output is
 * returned along with any `findings` extracted from the output (a
 * convention: if the tool's output shape has a `findings: Finding[]`
 * field, `runInner` reads it and (a) attaches it to the result and
 * (b) appends each finding to the session's findings.jsonl sidecar
 * when `findingsStore` is provided).
 *
 * On failure, `denied: true` distinguishes a chokepoint denial (or
 * user-rejected confirmation) from a runner exception (which sets
 * `error` to the exception's message).
 */
export type ExecuteResult =
  | { ok: true; output: unknown; decision: Decision; findings?: readonly Finding[] }
  | { ok: false; reason: string; decision: Decision; denied?: boolean; error?: string };

export interface ExecuteOpts {
  /**
   * Handler for `confirm` and `type-then-confirm` decisions. The
   * second argument is the decision itself, so the handler can tell
   * the two apart and render the right UI (simple y/n vs. type-input).
   *
   * If absent, a confirm-required call is denied with a clear reason
   * ("no handler provided"). The agent loop wires this to a
   * `Map<id, resolver>` in `useAgent`; tests can pass a stub that
   * resolves `true` or `false` directly.
   */
  onConfirmation?: (
    call: ExecuteCall,
    decision: Extract<Decision, { kind: 'confirm' | 'type-then-confirm' }>,
  ) => Promise<boolean>;
}

/**
 * v0.1 phase 6 — extended opts for `runInner`. The chain tool needs
 * `suppressTypeToConfirm` (to skip per-step type prompts) and
 * `findingsStore` (to propagate the per-step findings sidecar).
 * Plain `execute()` calls (no chain) use the default values.
 */
export interface RunInnerOpts extends ExecuteOpts {
  /**
   * When true, skip the `typeToConfirm` check. Destructive + target
   * checks still fire. The chain tool sets this to `true` for each
   * step so the chain's own `typeToConfirm: 'attack'` covers the
   * whole chain (not per-step).
   */
  suppressTypeToConfirm?: boolean;
  /**
   * Optional findings store. When set, `runInner` reads the tool's
   * `output.findings` (if any) and appends each `Finding` to the
   * store. This is the path the chain tool's per-step findings
   * propagate to the session's findings.jsonl sidecar.
   */
  findingsStore?: FindingsStore;
}

/**
 * Public seam. Called by the agent loop (via `execute`'s wrapper) and
 * by the `attack_chain` tool (via `ctx.innerRunner`, which closes
 * over a `runInner` invocation with the chain's `findingsStore` +
 * `onConfirmation` propagated).
 *
 * Tests can call this directly to assert the chokepoint integration
 * without going through `execute()`'s thin wrapper.
 */
export async function runInner(
  tool: string,
  args: Record<string, unknown>,
  registry: ToolRegistry,
  chokepoint: Chokepoint,
  ctx: ToolContext,
  opts: RunInnerOpts = {},
): Promise<ExecuteResult> {
  const entry = registry.get(tool);
  if (!entry) {
    return {
      ok: false,
      reason: `unknown tool "${tool}"`,
      decision: { kind: 'deny', reason: 'unknown tool' },
      denied: true,
    };
  }

  // 1. Zod-validate the args
  const parsed = entry.input.safeParse(args);
  if (!parsed.success) {
    return {
      ok: false,
      reason: `invalid args for "${tool}": ${parsed.error.message}`,
      decision: { kind: 'deny', reason: 'invalid args' },
      denied: true,
    };
  }

  // 2. Chokepoint. The chain tool sets `suppressTypeToConfirm: true`
  //    for each sub-step so the per-step typed prompt is covered by
  //    the chain's own `typeToConfirm: 'attack'`. We honor that by
  //    dropping `entry.typeToConfirm` from the call we hand to the
  //    chokepoint. Destructive + target checks still fire.
  const chokepointCall: ChokepointCall = {
    tool: entry.name,
    category: entry.category,
    flags: entry.flags,
    args: parsed.data,
    ...(opts.suppressTypeToConfirm ? {} : { typeToConfirm: entry.typeToConfirm }),
  };
  const decision = chokepoint.decide(chokepointCall);

  if (decision.kind === 'deny') {
    return { ok: false, reason: decision.reason, decision, denied: true };
  }
  if (decision.kind === 'confirm' || decision.kind === 'type-then-confirm') {
    if (!opts.onConfirmation) {
      return {
        ok: false,
        reason: `tool "${entry.name}" needs confirmation but no handler provided`,
        decision,
        denied: true,
      };
    }
    const approved = await opts.onConfirmation({ name: tool, args }, decision);
    if (!approved) {
      return { ok: false, reason: 'user denied confirmation', decision, denied: true };
    }
  }

  // 3. Build a child ctx with `innerRunner` set up. The closure
  //    recurses through `runInner` with the same registry/chokepoint/
  //    findingsStore, so a chain tool can orchestrate sub-steps.
  //    We do NOT include `innerRunner` in the closure's identity to
  //    avoid unbounded recursion if a tool tries to call itself.
  //    The `emit` field is forwarded unchanged — a chain tool's
  //    sub-step runner doesn't emit chain events itself (only the
  //    outer chain run does), but we still forward so a child tool
  //    that emits its own non-chain lifecycle events (future) would
  //    work without re-wiring.
  const innerRunner = ((
    subTool: string,
    subArgs: Record<string, unknown>,
    subOpts?: { suppressTypeToConfirm?: boolean },
  ) =>
    runInner(subTool, subArgs, registry, chokepoint, ctx, {
      ...opts,
      ...(subOpts?.suppressTypeToConfirm !== undefined
        ? { suppressTypeToConfirm: subOpts.suppressTypeToConfirm }
        : {}),
    })) as ToolContext['innerRunner'];
  const childCtx: ToolContext = {
    ...ctx,
    innerRunner,
    ...(ctx.emit ? { emit: ctx.emit } : {}),
  };

  // 4. Run the tool. The `as never` is safe because the registry
  //    enforced `output instanceof z.ZodObject` and we just validated
  //    the input.
  let output: unknown;
  try {
    output = await entry.run(parsed.data as never, childCtx);
    const validated = entry.output.parse(output);
    output = validated;
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
      decision,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // 5. Convention: tools that produce findings return them in the
  //    `findings` field of their output. We extract + persist.
  const findings = extractFindings(output);
  if (findings && opts.findingsStore) {
    for (const f of findings) {
      try {
        await opts.findingsStore.append(f);
      } catch {
        // Findings-store failures (disk full, malformed sidecar) are
        // surfaced as tool-result warnings by the caller; we do not
        // fail the tool on them, since the tool itself succeeded.
      }
    }
  }

  return findings
    ? { ok: true, output, decision, findings }
    : { ok: true, output, decision };
}

/**
 * The simple, chain-less entry point. v0.1 callers that don't need
 * chain support (e.g. shell_exec) go through this. The wrapper
 * forwards to `runInner` with the same opts.
 *
 * Kept as a separate function (not just an alias) so the test
 * surface for the "no chain" case is identical to before phase 6.
 */
export async function execute(
  call: ExecuteCall,
  ctx: ToolContext,
  chokepoint: Chokepoint,
  registry: ToolRegistry,
  opts: ExecuteOpts = {},
): Promise<ExecuteResult> {
  return runInner(call.name, call.args, registry, chokepoint, ctx, opts);
}

/**
 * Best-effort `findings` extractor. The chain tool's nested-step
 * output may have a `findings` array; we read it if it's a non-empty
 * array of `Finding`-shaped objects. Returns `undefined` when the
 * output doesn't carry findings (the common case for non-recon tools).
 */
function extractFindings(output: unknown): readonly Finding[] | undefined {
  if (!output || typeof output !== 'object') return undefined;
  const findings = (output as { findings?: unknown }).findings;
  if (!Array.isArray(findings) || findings.length === 0) return undefined;
  return findings as readonly Finding[];
}
