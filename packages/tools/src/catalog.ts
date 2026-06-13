import { shellExecTool } from './shell/shell-exec.js';
import { nmapTool } from './network/nmap.js';
import { dnsenumTool } from './network/dnsenum.js';
import { theHarvesterTool } from './network/theharvester.js';
import { whatwebTool } from './network/whatweb.js';
import { masscanTool } from './network/masscan.js';
import { rustscanTool } from './network/rustscan.js';
import { subfinderTool } from './network/subfinder.js';
import { dnsreconTool } from './network/dnsrecon.js';
import { fierceTool } from './network/fierce.js';
import { enum4linuxTool } from './network/enum4linux.js';
import { ldapsearchTool } from './network/ldapsearch.js';
import { nucleiTool } from './web/nuclei.js';
import { niktoTool } from './web/nikto.js';
import { gobusterTool } from './web/gobuster.js';
import { ffufTool } from './web/ffuf.js';
import { sqlmapTool } from './web/sqlmap.js';
import { httpxTool } from './web/httpx.js';
import { wpscanTool } from './web/wpscan.js';
import { snmpcheckTool } from './web/snmpcheck.js';
import { evilTwinTool } from './wifi/evil-twin.js';
import { wifiDeauthTool } from './wifi/deauth.js';
import { wifiteScanTool } from './wifi/wifite-scan.js';
import { bettercapTool } from './wifi/bettercap.js';
import { aircrackTool } from './wifi/aircrack.js';
import { kismetTool } from './wifi/kismet.js';
import { reportWriteTool } from './reports/write.js';
import { reportPdfTool } from './reports/pdf.js';
import type { z } from 'zod';

/**
 * Default tool registry exposed by @gmft/tools. Apps that want a
 * different set of tools can build their own ToolRegistry via
 * `@gmft/core`.
 *
 * v0.3.B adds 13 new tools:
 *   - network: masscan, rustscan, subfinder, dnsrecon, fierce,
 *     enum4linux, ldapsearch
 *   - web:    httpx, wpscan, snmpcheck
 *   - wifi:   bettercap, aircrack, kismet
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
    name: masscanTool.name,
    category: masscanTool.category,
    flags: masscanTool.flags,
  },
  {
    name: rustscanTool.name,
    category: rustscanTool.category,
    flags: rustscanTool.flags,
  },
  {
    name: subfinderTool.name,
    category: subfinderTool.category,
    flags: subfinderTool.flags,
  },
  {
    name: dnsreconTool.name,
    category: dnsreconTool.category,
    flags: dnsreconTool.flags,
  },
  {
    name: fierceTool.name,
    category: fierceTool.category,
    flags: fierceTool.flags,
  },
  {
    name: enum4linuxTool.name,
    category: enum4linuxTool.category,
    flags: enum4linuxTool.flags,
  },
  {
    name: ldapsearchTool.name,
    category: ldapsearchTool.category,
    flags: ldapsearchTool.flags,
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
    name: httpxTool.name,
    category: httpxTool.category,
    flags: httpxTool.flags,
  },
  {
    name: wpscanTool.name,
    category: wpscanTool.category,
    flags: wpscanTool.flags,
  },
  {
    name: snmpcheckTool.name,
    category: snmpcheckTool.category,
    flags: snmpcheckTool.flags,
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
    name: bettercapTool.name,
    category: bettercapTool.category,
    flags: bettercapTool.flags,
  },
  {
    name: aircrackTool.name,
    category: aircrackTool.category,
    flags: aircrackTool.flags,
  },
  {
    name: kismetTool.name,
    category: kismetTool.category,
    flags: kismetTool.flags,
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
export {
  nmapTool,
  dnsenumTool,
  theHarvesterTool,
  whatwebTool,
  masscanTool,
  rustscanTool,
  subfinderTool,
  dnsreconTool,
  fierceTool,
  enum4linuxTool,
  ldapsearchTool,
} from './network/index.js';
export {
  nucleiTool,
  niktoTool,
  gobusterTool,
  ffufTool,
  sqlmapTool,
  httpxTool,
  wpscanTool,
  snmpcheckTool,
} from './web/index.js';
export {
  evilTwinTool,
  wifiDeauthTool,
  wifiteScanTool,
  bettercapTool,
  aircrackTool,
  kismetTool,
} from './wifi/index.js';
export { reportWriteTool } from './reports/write.js';
export { reportPdfTool, renderPdfBuffer, ReportPdfInput, ReportPdfOutput, type ReportPdfInputT, type ReportPdfOutputT, type PdfReportMeta } from './reports/pdf.js';
export { readSelections, writeSelections } from './reports/selections.js';
export type { z };
