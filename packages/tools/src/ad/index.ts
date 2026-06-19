/**
 * v0.4-B — AD attack tools barrel.
 *
 * Re-exports the 5 tools declared under `category: 'ad'`. Each
 * tool routes through the `gmft/ad:0.1` Docker image (impacket
 * installed via `Dockerfile.ad` at the repo root). See
 * `docs/plans/adr/0018-v0.4-b-ad-attack-gate.md` for the full
 * threat model + constraint set.
 */

export { psexecTool, buildPsexecArgs, PsexecInput, PsexecOutput, type PsexecInputT, type PsexecOutputT } from './psexec.js';
export { wmiexecTool, buildWmiexecArgs, WmiexecInput, WmiexecOutput, type WmiexecInputT, type WmiexecOutputT } from './wmiexec.js';
export { secretsdumpTool, buildSecretsdumpArgs, SecretsdumpInput, SecretsdumpOutput, type SecretsdumpInputT, type SecretsdumpOutputT } from './secretsdump.js';
export { kerberoastTool, buildKerberoastArgs, KerberoastInput, KerberoastOutput, parseKerberoastHashes, type KerberoastInputT, type KerberoastOutputT } from './kerberoast.js';
export { asreproastTool, buildAsreproastArgs, AsreproastInput, AsreproastOutput, parseAsrepHashes, type AsreproastInputT, type AsreproastOutputT } from './asreproast.js';
export {
  AdInputBase,
  AdOutputBase,
  AD_IMAGE,
  buildImpacketTarget,
  defaultAdFindings,
  type AdInputBaseT,
  type AdOutputBaseT,
} from './shared.js';
