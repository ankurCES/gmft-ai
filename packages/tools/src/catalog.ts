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
import {
  psexecTool,
  wmiexecTool,
  secretsdumpTool,
  kerberoastTool,
  asreproastTool,
} from './ad/index.js';
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
export const tools: Array<{
  name: string;
  category: string;
  flags: readonly string[];
  description: string;
}> = [
  {
    name: shellExecTool.name,
    category: shellExecTool.category,
    flags: shellExecTool.flags,
    description: shellExecTool.description,
  },
  {
    name: nmapTool.name,
    category: nmapTool.category,
    flags: nmapTool.flags,
    description: nmapTool.description,
  },
  {
    name: dnsenumTool.name,
    category: dnsenumTool.category,
    flags: dnsenumTool.flags,
    description: dnsenumTool.description,
  },
  {
    name: theHarvesterTool.name,
    category: theHarvesterTool.category,
    flags: theHarvesterTool.flags,
    description: theHarvesterTool.description,
  },
  {
    name: whatwebTool.name,
    category: whatwebTool.category,
    flags: whatwebTool.flags,
    description: whatwebTool.description,
  },
  {
    name: masscanTool.name,
    category: masscanTool.category,
    flags: masscanTool.flags,
    description: masscanTool.description,
  },
  {
    name: rustscanTool.name,
    category: rustscanTool.category,
    flags: rustscanTool.flags,
    description: rustscanTool.description,
  },
  {
    name: subfinderTool.name,
    category: subfinderTool.category,
    flags: subfinderTool.flags,
    description: subfinderTool.description,
  },
  {
    name: dnsreconTool.name,
    category: dnsreconTool.category,
    flags: dnsreconTool.flags,
    description: dnsreconTool.description,
  },
  {
    name: fierceTool.name,
    category: fierceTool.category,
    flags: fierceTool.flags,
    description: fierceTool.description,
  },
  {
    name: enum4linuxTool.name,
    category: enum4linuxTool.category,
    flags: enum4linuxTool.flags,
    description: enum4linuxTool.description,
  },
  {
    name: ldapsearchTool.name,
    category: ldapsearchTool.category,
    flags: ldapsearchTool.flags,
    description: ldapsearchTool.description,
  },
  {
    name: nucleiTool.name,
    category: nucleiTool.category,
    flags: nucleiTool.flags,
    description: nucleiTool.description,
  },
  {
    name: niktoTool.name,
    category: niktoTool.category,
    flags: niktoTool.flags,
    description: niktoTool.description,
  },
  {
    name: gobusterTool.name,
    category: gobusterTool.category,
    flags: gobusterTool.flags,
    description: gobusterTool.description,
  },
  {
    name: ffufTool.name,
    category: ffufTool.category,
    flags: ffufTool.flags,
    description: ffufTool.description,
  },
  {
    name: sqlmapTool.name,
    category: sqlmapTool.category,
    flags: sqlmapTool.flags,
    description: sqlmapTool.description,
  },
  {
    name: httpxTool.name,
    category: httpxTool.category,
    flags: httpxTool.flags,
    description: httpxTool.description,
  },
  {
    name: wpscanTool.name,
    category: wpscanTool.category,
    flags: wpscanTool.flags,
    description: wpscanTool.description,
  },
  {
    name: snmpcheckTool.name,
    category: snmpcheckTool.category,
    flags: snmpcheckTool.flags,
    description: snmpcheckTool.description,
  },
  {
    name: evilTwinTool.name,
    category: evilTwinTool.category,
    flags: evilTwinTool.flags,
    description: evilTwinTool.description,
  },
  {
    name: wifiDeauthTool.name,
    category: wifiDeauthTool.category,
    flags: wifiDeauthTool.flags,
    description: wifiDeauthTool.description,
  },
  {
    name: wifiteScanTool.name,
    category: wifiteScanTool.category,
    flags: wifiteScanTool.flags,
    description: wifiteScanTool.description,
  },
  {
    name: bettercapTool.name,
    category: bettercapTool.category,
    flags: bettercapTool.flags,
    description: bettercapTool.description,
  },
  {
    name: aircrackTool.name,
    category: aircrackTool.category,
    flags: aircrackTool.flags,
    description: aircrackTool.description,
  },
  {
    name: kismetTool.name,
    category: kismetTool.category,
    flags: kismetTool.flags,
    description: kismetTool.description,
  },
  {
    name: reportWriteTool.name,
    category: reportWriteTool.category,
    flags: reportWriteTool.flags,
    description: reportWriteTool.description,
  },
  {
    name: reportPdfTool.name,
    category: reportPdfTool.category,
    flags: reportPdfTool.flags,
    description: reportPdfTool.description,
  },
  // v0.4-B — 5 AD attack tools. Each is `category: 'ad'`
  // (additive per ADR-0018 §10.4) with `destructive` +
  // `targetRequired` flags and `typeToConfirm: 'attack'` so
  // the chokepoint's `checkTypeToConfirm` returns
  // `type-then-confirm` (user must type the literal "attack"
  // before the run fires). See `safety.md` §10.1 for the
  // full constraint set; `Dockerfile.ad` for the impacket
  // image used by all 5 tools.
  {
    name: psexecTool.name,
    category: psexecTool.category,
    flags: psexecTool.flags,
    description: psexecTool.description,
  },
  {
    name: wmiexecTool.name,
    category: wmiexecTool.category,
    flags: wmiexecTool.flags,
    description: wmiexecTool.description,
  },
  {
    name: secretsdumpTool.name,
    category: secretsdumpTool.category,
    flags: secretsdumpTool.flags,
    description: secretsdumpTool.description,
  },
  {
    name: kerberoastTool.name,
    category: kerberoastTool.category,
    flags: kerberoastTool.flags,
    description: kerberoastTool.description,
  },
  {
    name: asreproastTool.name,
    category: asreproastTool.category,
    flags: asreproastTool.flags,
    description: asreproastTool.description,
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
// v0.4-B — AD attack tools (category: 'ad'). See ADR-0018 §10.1
// for the chokepoint constraint set and `Dockerfile.ad` for the
// impacket image used by all 5 tools.
export {
  psexecTool,
  wmiexecTool,
  secretsdumpTool,
  kerberoastTool,
  asreproastTool,
} from './ad/index.js';
export type { z };
