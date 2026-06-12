import { shellExecTool } from './shell/shell-exec.js';
import { nmapTool } from './network/nmap.js';
import { dnsenumTool } from './network/dnsenum.js';
import { theHarvesterTool } from './network/theharvester.js';
import { whatwebTool } from './network/whatweb.js';
import { nucleiTool } from './web/nuclei.js';
import { niktoTool } from './web/nikto.js';
import { gobusterTool } from './web/gobuster.js';
import { ffufTool } from './web/ffuf.js';
import { sqlmapTool } from './web/sqlmap.js';
import { evilTwinTool } from './wifi/evil-twin.js';
import { wifiDeauthTool } from './wifi/deauth.js';
import { wifiteScanTool } from './wifi/wifite-scan.js';
import { reportWriteTool } from './reports/write.js';
import { reportPdfTool } from './reports/pdf.js';
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
  {
    name: evilTwinTool.name,
    category: evilTwinTool.category,
    flags: evilTwinTool.flags,
  },
  {
    name: wifiDeauthTool.name,
    category: wifiDeauthTool.category,
    flags: wifiDeauthTool.flags,
  },
  {
    name: wifiteScanTool.name,
    category: wifiteScanTool.category,
    flags: wifiteScanTool.flags,
  },
  {
    name: reportWriteTool.name,
    category: reportWriteTool.category,
    flags: reportWriteTool.flags,
  },
  {
    name: reportPdfTool.name,
    category: reportPdfTool.category,
    flags: reportPdfTool.flags,
  },
];

export { shellExecTool };
export { nmapTool } from './network/nmap.js';
export { dnsenumTool } from './network/dnsenum.js';
export { theHarvesterTool } from './network/theharvester.js';
export { whatwebTool } from './network/whatweb.js';
export {
  nucleiTool,
  niktoTool,
  gobusterTool,
  ffufTool,
  sqlmapTool,
} from './web/index.js';
export { evilTwinTool } from './wifi/index.js';
export { wifiDeauthTool } from './wifi/deauth.js';
export { wifiteScanTool } from './wifi/wifite-scan.js';
export { reportWriteTool } from './reports/write.js';
export { reportPdfTool, renderPdfBuffer, ReportPdfInput, ReportPdfOutput, type ReportPdfInputT, type ReportPdfOutputT, type PdfReportMeta } from './reports/pdf.js';
export { readSelections, writeSelections } from './reports/selections.js';
export type { z };
