/**
 * In-memory tool registry. The app builds one `ToolRegistry` at start
 * (in `useAgent`), registers every `Tool<I,O>` it wants exposed, and
 * passes the result to `runTurn` via `RunTurnOpts.tools`.
 *
 * Validation is strict and fail-fast: a bad name, unknown category,
 * or non-zod schema throws at register time, not at run time. This
 * is intentional — the registry is built once at process start, and
 * a tool author who passes the wrong shape deserves a stack trace
 * pointing at the `register(...)` call, not a cryptic error 100ms
 * into a chat session.
 */

import { z } from 'zod';
import type { Tool, ToolCategory } from './types.js';
import { TOOL_CATEGORIES } from './types.js';

/** Tool names: lowercase letter, then lowercase letters/digits/underscore. */
const NAME_RE = /^[a-z][a-z0-9_]*$/;

export class ToolRegistry {
  private tools = new Map<string, Tool<z.ZodTypeAny, z.ZodTypeAny>>();

  register<I extends z.ZodTypeAny, O extends z.ZodTypeAny>(tool: Tool<I, O>): void {
    if (!NAME_RE.test(tool.name)) {
      throw new Error(`tool name "${tool.name}" must match ${NAME_RE}`);
    }
    if (!TOOL_CATEGORIES.includes(tool.category as ToolCategory)) {
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
    this.tools.set(tool.name, tool as unknown as Tool<z.ZodTypeAny, z.ZodTypeAny>);
  }

  get(name: string): Tool<z.ZodTypeAny, z.ZodTypeAny> | undefined {
    return this.tools.get(name);
  }

  list(): readonly Tool<z.ZodTypeAny, z.ZodTypeAny>[] {
    return [...this.tools.values()];
  }

  /**
   * Convert registered tools to the AI SDK's `tools` record shape. The
   * SDK calls each `execute(args, options)` itself; we wrap that with
   * the chokepoint check in the agent loop (task 3.5) so the SDK's
   * built-in dispatch is the place the gate plugs in.
   */
  toAISDKTools(): Record<string, { description: string; parameters: z.ZodTypeAny }> {
    const out: Record<string, { description: string; parameters: z.ZodTypeAny }> = {};
    for (const t of this.tools.values()) {
      out[t.name] = { description: t.description, parameters: t.input };
    }
    return out;
  }
}
