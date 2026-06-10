import { shellExecTool } from './shell/shell-exec';
import type { z } from 'zod';

/**
 * Default tool registry exposed by @gmft/tools. Apps that want a
 * different set of tools can build their own ToolRegistry via
 * `@gmft/core`.
 */
export const tools: Array<{ name: string; category: string; flags: readonly string[] }> = [
  {
    name: shellExecTool.name,
    category: shellExecTool.category,
    flags: shellExecTool.flags,
  },
];

export { shellExecTool };
export type { z };
