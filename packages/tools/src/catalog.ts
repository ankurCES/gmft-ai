import { shellExecTool } from './shell/shell-exec';
import { nmapTool } from './network/nmap';
import { dnsenumTool } from './network/dnsenum';
import { theHarvesterTool } from './network/theharvester';
import { whatwebTool } from './network/whatweb';
import { nucleiTool } from './web/nuclei';
import { niktoTool } from './web/nikto';
import { gobusterTool } from './web/gobuster';
import { ffufTool } from './web/ffuf';
import { sqlmapTool } from './web/sqlmap';
// evilTwinTool is added in Task 5.9
// import { evilTwinTool } from './wifi/evil-twin';
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
  {
    name: nmapTool.name,
    category: nmapTool.category,
    flags: nmapTool.flags,
  },
  {
    name: dnsenumTool.name,
    category: dnsenumTool.category,
    flags: dnsenumTool.flags,
  },
  {
    name: theHarvesterTool.name,
    category: theHarvesterTool.category,
    flags: theHarvesterTool.flags,
  },
  {
    name: whatwebTool.name,
    category: whatwebTool.category,
    flags: whatwebTool.flags,
  },
  {
    name: nucleiTool.name,
    category: nucleiTool.category,
    flags: nucleiTool.flags,
  },
  {
    name: niktoTool.name,
    category: niktoTool.category,
    flags: niktoTool.flags,
  },
  {
    name: gobusterTool.name,
    category: gobusterTool.category,
    flags: gobusterTool.flags,
  },
  {
    name: ffufTool.name,
    category: ffufTool.category,
    flags: ffufTool.flags,
  },
  {
    name: sqlmapTool.name,
    category: sqlmapTool.category,
    flags: sqlmapTool.flags,
  },
  // { name: evilTwinTool.name, category: evilTwinTool.category, flags: evilTwinTool.flags },
];

export { shellExecTool };
export { nmapTool } from './network/nmap';
export { dnsenumTool } from './network/dnsenum';
export { theHarvesterTool } from './network/theharvester';
export { whatwebTool } from './network/whatweb';
export {
  nucleiTool,
  niktoTool,
  gobusterTool,
  ffufTool,
  sqlmapTool,
} from './web/index.js';
export type { z };
