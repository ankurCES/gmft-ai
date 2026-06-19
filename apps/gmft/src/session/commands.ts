/**
 * Slash-command dispatcher.
 *
 * The TUI's InputBox yields a string. If it starts with `/`, this
 * module dispatches it to a command handler; otherwise the caller
 * forwards it to the LLM (AgentApp / useAgent). The dispatcher is
 * pure with respect to React — it takes callbacks for state changes
 * and returns a structured `SlashResult`. App.tsx calls it inside
 * `handleSubmit`.
 *
 * Commands (phase 1.5e + phase 6):
 *   /help                       — show help
 *   /clear                      — clear chat messages
 *   /model <id>                 — switch model in-memory (no LLM call)
 *   /provider <id>              — switch provider + clear model in-memory
 *   /exit                       — request clean exit
 *   /session new                — start a new session, clear chat
 *   /session list               — show available sessions
 *   /session load <id>          — load + replay a session into chat
 *   /session clear              — clear current pointer (logs kept on disk)
 *   /resume                     — alias for /session load current
 *   /report [md|json|pdf] [path] — generate a report from current session findings
 *
 * Anything starting with `/` that we don't recognize is a `handled:error`
 * — we never forward unknown slash input to the LLM.
 */

import type { Message as Msg } from '../ui/components/Message.js';
import type { SessionInfo, SessionStore } from './store.js';
import { formatToolList, findTool } from './tool-picker.js';
import { parseRunCommand } from './run-command.js';
import type { SupervisorFire, SupervisorTurnRecord } from '@gmft/core';

export type ReportFormat = 'md' | 'json' | 'pdf';

export interface RunReportOpts {
  format: ReportFormat;
  outputPath?: string;
  severityFilter?: 'info' | 'low' | 'medium' | 'high' | 'critical';
  includeEvidence?: boolean;
}

export interface RunReportResult {
  path: string;
  format: ReportFormat;
  findingCount: number;
  bytesWritten: number;
}

export type SlashResult =
  | { kind: 'sent' } // not a slash command — caller forwards to LLM
  | {
      kind: 'handled';
      /**
       * Optional reply to push into the chat (e.g. `/help` text,
       * `/session list` table, error for an unknown sub-command).
       */
      reply?: Msg;
      /**
       * Optional side effect: clear the current messages in the chat
       * pane (`/clear`, `/session new`, `/session load`).
       */
      clearMessages?: boolean;
      /**
       * Optional replacement for the current messages. Used by
       * `/session load <id>` to hydrate the chat with the loaded turns.
       */
      replaceMessages?: Msg[];
      /**
       * Optional update to the in-memory provider+model. Used by
       * `/model` and `/provider`. Caller pushes a status update to
       * the rail; the change does NOT touch disk.
       */
      setModel?: { provider: string; model: string };
      /**
       * v0.3.B — optional rich tool-result message. Used by
       * `/run <tool> [args...]` so the chat can render the actual
       * tool output (not just a text summary). When set, the caller
       * pushes this Msg in addition to (or instead of) the `reply`.
       * Distinct from `reply` because tool output is `role: 'tool'`
       * with structured content (findings, stdout excerpts, etc.).
       */
      toolResult?: Msg;
    }
  | { kind: 'exited' }; // /exit was typed

export interface SlashContext {
  /** Current messages in the chat (used by `/clear` to count what was wiped). */
  messages: readonly Msg[];
  /** Current provider id (for `/model` validation + `/provider` toggle). */
  currentProvider: string;
  /** Current model id (for the help text + status updates). */
  currentModel: string;
  /** Session store (used by `/session new|list|load|clear`). */
  session: SessionStore;
  /**
   * Replace the in-memory provider+model. Phase 1.5e keeps the change
   * in memory only — the config is not rewritten. Persisted switches
   * land in 1.5f if we want them.
   */
  onSwitchModel: (next: { provider: string; model: string }) => void;
  /**
   * Clean exit — App calls useApp().exit() AND invokes onExit() so
   * tests can assert the path.
   */
  onExit: () => void;
  /**
   * Run a report tool against the current session's findings. Wired
   * in by `AgentApp` so the slash command stays pure-ish (it doesn't
   * import `@gmft/tools` directly). If absent, `/report` returns a
   * friendly "report tool unavailable" reply.
   */
  runReport?: (opts: RunReportOpts) => Promise<RunReportResult>;
  /**
   * Open a file in the OS's default handler. Used by `/report pdf`
   * so the operator can preview without leaving the TUI. If absent,
   * the reply still shows the path — the operator can open it
   * manually. Best-effort: errors are surfaced as a reply.
   */
  openFile?: (path: string) => Promise<void>;
  /**
   * v0.3.C — invoke an audit operation (verify / log / tail).
   * Wired in by `AgentApp` so the slash command stays pure-ish
   * (the same way `runReport` and `runTool` work). The callback
   * returns a structured result and a human-readable body. If
   * absent, `/audit` returns a friendly "audit not wired" reply.
   */
  runAudit?: (opts: RunAuditOpts) => Promise<RunAuditResult>;
  /**
   * v0.3.B — invoke a tool directly. Wired in by `AgentApp` so the
   * `/run <tool> [args...]` slash command can execute a tool with
   * the same chokepoint + audit pipeline the agent loop uses.
   *
   * The function takes a tool name and an arg list and returns a
   * `Msg` (the same shape the agent loop pushes into the chat
   * after a `tool-result` event) plus a `denied` flag for the
   * chokepoint-denied case. If absent, `/run` returns a friendly
   * "tool runner unavailable" reply.
   */
  runTool?: (
    tool: string,
    args: readonly string[],
  ) => Promise<{ msg: Msg; denied: boolean }>;
  /**
   * v0.4-A.4 — read the last completed turn's supervisor snapshot.
   * Wired in by `AgentApp` so the `/supervisor [fires|postmortem]`
   * slash command can render the supervisor's fires + postmortem
   * without re-running the rule engine. The callback returns:
   *   - `null` if no turn has completed yet (e.g. user typed
   *     `/supervisor` before the LLM has submitted anything), OR
   *     if the supervisor was never wired for this session.
   *   - a snapshot otherwise (fires may be empty for a quiet turn;
   *     postmortem is undefined if the postmortem wasn't generated,
   *     e.g. when no model was supplied to `withSupervisor`).
   *
   * If absent, `/supervisor` returns a friendly "supervisor not wired"
   * reply.
   */
  getSupervisorSnapshot?: () => SupervisorSnapshot | null;
}

/**
 * v0.4-A.4 — the supervisor's state for the most recently completed
 * turn. `fires` is whatever `withSupervisor.lastFires()` returned
 * (may be empty for a quiet turn). `postmortem` is whatever
 * `withSupervisor.lastPostmortem()` returned (undefined when no
 * model was supplied, or when the turn produced no prose).
 */
export interface SupervisorSnapshot {
  fires: readonly SupervisorFire[];
  postmortem?: SupervisorTurnRecord;
}

export type AuditSubcommand = 'verify' | 'log' | 'tail';

export interface RunAuditOpts {
  subcommand: AuditSubcommand;
  /** For `log` — how many recent events to read. Defaults to 50. */
  limit?: number;
}

export interface RunAuditResult {
  /**
   * `true` when the operation ran without error (verify ok, log
   * read, tail started/stopped cleanly). For verify, `false`
   * means the chain is BROKEN — that's an error worth showing
   * the operator, not a fault of the slash command.
   */
  ok: boolean;
  /** Human-readable body to render into the chat reply. */
  body: string;
}

export const HELP_TEXT =
  'Commands:\n' +
  '  /help                       show this help\n' +
  '  /clear                      clear chat (log kept on disk)\n' +
  '  /model <id>                 switch model in-memory\n' +
  '  /provider <id>              switch provider (model cleared)\n' +
  '  /session new                start a new session (clears chat)\n' +
  '  /session list               list sessions on disk\n' +
  '  /session load <id>          load a session and replay turns\n' +
  '  /session clear              clear current pointer (logs kept)\n' +
  '  /resume                     alias for /session load <current>\n' +
  '  /report [md|json|pdf] [path]\n' +
  '                             write a report (default: md). pdf also opens it.\n' +
  '  /tools [domain]             list available tools (shell|http|file|search|recon|binary|note)\n' +
  '  /run <tool> [args...]       invoke a tool directly (chokepoint applies)\n' +
  '  /audit verify               walk the audit chain, report integrity\n' +
  '  /audit log [n]              show recent audit events (default 50)\n' +
  '  /audit tail                 follow the audit log (500ms poll)\n' +
  '  /supervisor [fires|postmortem]\n' +
  '                             show last turn\'s fires + postmortem\n' +
  '  /exit                       exit (alias for Ctrl-C)';

/**
 * Dispatch a single input string. Returns the result for the caller
 * (App.tsx) to act on. Throws only on programmer error (missing
 * callbacks) — runtime errors are returned as `handled:error` replies.
 */
export async function dispatchSlash(
  text: string,
  ctx: SlashContext,
): Promise<SlashResult> {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) {
    return { kind: 'sent' };
  }

  // Tokenize. Slash commands are space-separated; we don't support
  // quoted args in v0.1 (no need yet).
  const parts = trimmed.split(/\s+/);
  const cmd = parts[0]?.toLowerCase() ?? '';
  const arg = parts[1];
  const rest = parts.slice(2).join(' ');

  const now = Date.now();
  const reply = (content: string, idSuffix: string): Msg => ({
    id: `cmd-${now}-${idSuffix}`,
    role: 'assistant',
    content,
    ts: now,
  });

  if (cmd === '/help') {
    return {
      kind: 'handled',
      reply: reply(HELP_TEXT, 'help'),
    };
  }

  if (cmd === '/clear') {
    return {
      kind: 'handled',
      clearMessages: true,
      reply: reply(
        `Cleared ${ctx.messages.length} message(s) from view. The current session log is untouched.`,
        'clear',
      ),
    };
  }

  if (cmd === '/model') {
    if (!arg) {
      return {
        kind: 'handled',
        reply: reply(
          `Usage: /model <id> (current: ${ctx.currentModel})`,
          'model-usage',
        ),
      };
    }
    ctx.onSwitchModel({ provider: ctx.currentProvider, model: arg });
    return {
      kind: 'handled',
      reply: reply(`Switched model to ${arg} (in-memory, not persisted).`, 'model'),
    };
  }

  if (cmd === '/provider') {
    if (!arg) {
      return {
        kind: 'handled',
        reply: reply(
          `Usage: /provider <id> (current: ${ctx.currentProvider})`,
          'provider-usage',
        ),
      };
    }
    // Provider switch clears the explicit model — AgentApp picks a
    // sensible default from the catalog so the next turn has a real
    // model id (1.5f). The user can override with /model <id> after.
    ctx.onSwitchModel({ provider: arg, model: '' });
    return {
      kind: 'handled',
      reply: reply(
        `Switched provider to ${arg} (default model selected — /model <id> to override).`,
        'provider',
      ),
    };
  }

  if (cmd === '/exit') {
    ctx.onExit();
    return { kind: 'exited' };
  }

  if (cmd === '/session') {
    return await handleSession(arg ?? '', rest, ctx, reply);
  }

  if (cmd === '/resume') {
    const currentId = await ctx.session.currentId();
    if (!currentId) {
      return {
        kind: 'handled',
        reply: reply('No current session to resume.', 'resume-none'),
      };
    }
    return await loadSession(currentId, ctx, reply);
  }

  if (cmd === '/report') {
    return await handleReport(arg, rest, ctx, reply);
  }

  if (cmd === '/tools') {
    return await handleTools(arg, ctx, reply);
  }

  if (cmd === '/run') {
    return await handleRun(text, ctx, reply);
  }

  if (cmd === '/audit') {
    return await handleAudit(arg, rest, ctx, reply);
  }

  // v0.4-A.4 — supervisor state for the last turn. Mirrors the
  // structure of `/audit`: pure dispatcher, callback in ctx for
  // I/O. Subcommands: none (default = show both fires + postmortem),
  // `fires` (just the rule-violation list), `postmortem` (just the
  // prose summary).
  if (cmd === '/supervisor') {
    return await handleSupervisor(arg, ctx, reply);
  }

  // Unknown command — never forward.
  return {
    kind: 'handled',
    reply: reply(
      `Unknown command: ${cmd}\nType /help for the list.`,
      'unknown',
    ),
  };
}

async function handleSession(
  sub: string,
  arg: string,
  ctx: SlashContext,
  reply: (content: string, idSuffix: string) => Msg,
): Promise<SlashResult> {
  if (sub === 'new') {
    const id = await ctx.session.start();
    return {
      kind: 'handled',
      clearMessages: true,
      reply: reply(`Started new session: ${id}`, 'session-new'),
    };
  }

  if (sub === 'list') {
    const sessions = await ctx.session.list();
    if (sessions.length === 0) {
      return {
        kind: 'handled',
        reply: reply('No sessions on disk.', 'session-list-empty'),
      };
    }
    const lines = sessions.map(formatSessionLine);
    return {
      kind: 'handled',
      reply: reply('Sessions:\n' + lines.join('\n'), 'session-list'),
    };
  }

  if (sub === 'load') {
    if (!arg) {
      return {
        kind: 'handled',
        reply: reply('Usage: /session load <id>', 'session-load-usage'),
      };
    }
    return await loadSession(arg, ctx, reply);
  }

  if (sub === 'clear') {
    await ctx.session.clear();
    return {
      kind: 'handled',
      reply: reply('Cleared current-session pointer. Logs on disk are kept.', 'session-clear'),
    };
  }

  return {
    kind: 'handled',
    reply: reply(
      `Usage: /session <new|list|load <id>|clear> (got: ${sub || 'nothing'})`,
      'session-usage',
    ),
  };
}

async function loadSession(
  id: string,
  ctx: SlashContext,
  reply: (content: string, idSuffix: string) => Msg,
): Promise<SlashResult> {
  const turns = await ctx.session.load(id);
  if (turns.length === 0) {
    return {
      kind: 'handled',
      reply: reply(`No turns found for session ${id}.`, 'session-load-empty'),
    };
  }
  await ctx.session.setCurrent(id);
  const messages: Msg[] = turns.map((t, i) => ({
    id: `m-${t.ts ?? i}-${i}`,
    role: t.role,
    content: t.content,
    ts: t.ts ?? Date.now(),
  }));
  return {
    kind: 'handled',
    replaceMessages: messages,
    reply: reply(`Loaded ${turns.length} turns from session ${id}.`, 'session-load'),
  };
}

function formatSessionLine(s: SessionInfo): string {
  const mark = s.current ? '*' : ' ';
  const when = new Date(s.mtimeMs).toISOString().replace('T', ' ').slice(0, 19);
  return `  ${mark} ${s.id}  (${s.turns} turn${s.turns === 1 ? '' : 's'}, modified ${when})`;
}

/**
 * /report [md|json|pdf] [path]
 *
 * Default format is `md`. Optional `path` overrides the default
 * report path (it must land under the reports dir, enforced by the
 * underlying tool).
 *
 * For PDF, we additionally call `ctx.openFile(path)` if provided so
 * the operator gets a preview in the OS default viewer. We don't
 * fail the command if `xdg-open` is missing — the reply still shows
 * the path.
 */
async function handleReport(
  fmtArg: string | undefined,
  pathArg: string,
  ctx: SlashContext,
  reply: (content: string, idSuffix: string) => Msg,
): Promise<SlashResult> {
  if (!ctx.runReport) {
    return {
      kind: 'handled',
      reply: reply(
        'Report tool is not wired into this build of gmft.',
        'report-noop',
      ),
    };
  }
  // Parse format. Empty/unknown falls back to 'md' with a hint.
  const fmtRaw = (fmtArg ?? 'md').toLowerCase();
  let format: ReportFormat;
  if (fmtRaw === 'md' || fmtRaw === 'markdown') {
    format = 'md';
  } else if (fmtRaw === 'json') {
    format = 'json';
  } else if (fmtRaw === 'pdf') {
    format = 'pdf';
  } else {
    return {
      kind: 'handled',
      reply: reply(
        `Usage: /report [md|json|pdf] [path]  (got format "${fmtRaw}")`,
        'report-usage',
      ),
    };
  }
  try {
    const result = await ctx.runReport({
      format,
      outputPath: pathArg || undefined,
    });
    let body =
      `Report written: ${result.path}\n` +
      `Format: ${result.format} · Findings: ${result.findingCount} · ` +
      `Bytes: ${result.bytesWritten}`;
    if (format === 'pdf' && ctx.openFile) {
      try {
        await ctx.openFile(result.path);
        body += '\n(opened in default viewer)';
      } catch (e) {
        body += `\n(open failed: ${(e as Error).message})`;
      }
    }
    return { kind: 'handled', reply: reply(body, 'report') };
  } catch (e) {
    return {
      kind: 'handled',
      reply: reply(`Report failed: ${(e as Error).message}`, 'report-error'),
    };
  }
}

/**
 * `/audit <subcommand> [args...]` — invoke an audit operation from
 * the TUI. Mirrors the `gmft audit {verify,log,tail}` CLI surface so
 * the operator doesn't have to leave the chat to inspect the chain.
 *
 * Subcommands:
 *   - `verify` — walk the chain, recompute every hash, report the
 *     first broken line + count of verified events. `ok: true` for
 *     an intact chain; `ok: false` for a broken one (the chat reply
 *     still shows the body so the operator can see where it broke).
 *   - `log [n]` — read the most recent N events (default 50). The
 *     N is a single integer argument after `log`.
 *   - `tail` — follow the log in real time. The current implementation
 *     prints the initial batch (head + tail) and stops — a true
 *     streaming poll would couple slash-command lifetime to the
 *     chat-pane render. Operators who want to watch new events live
 *     should run `gmft audit tail` from a shell.
 *
 * The slash command stays pure — the actual chain math lives in
 * `apps/gmft/src/cli-audit.ts` (`verifyAuditLog`, `readAuditLog`,
 * `tailAuditLog`) and is wrapped by `AgentApp.runAudit`.
 */
async function handleAudit(
  sub: string | undefined,
  rest: string,
  ctx: SlashContext,
  reply: (content: string, idSuffix: string) => Msg,
): Promise<SlashResult> {
  if (!ctx.runAudit) {
    return {
      kind: 'handled',
      reply: reply(
        'Audit is not wired into this build of gmft.',
        'audit-noop',
      ),
    };
  }
  if (!sub) {
    return {
      kind: 'handled',
      reply: reply(
        'Usage: /audit verify | /audit log [n] | /audit tail',
        'audit-usage',
      ),
    };
  }
  const subcommand = sub.toLowerCase();
  if (subcommand !== 'verify' && subcommand !== 'log' && subcommand !== 'tail') {
    return {
      kind: 'handled',
      reply: reply(
        `Unknown audit subcommand: ${sub}\nUsage: /audit verify | /audit log [n] | /audit tail`,
        'audit-usage',
      ),
    };
  }
  // For `log`, parse the optional N from `rest`. Empty / non-numeric
  // falls back to the default (50, set by AgentApp.runAudit).
  let limit: number | undefined;
  if (subcommand === 'log' && rest.trim() !== '') {
    const n = Number.parseInt(rest.trim(), 10);
    if (!Number.isFinite(n) || n <= 0) {
      return {
        kind: 'handled',
        reply: reply(
          `Usage: /audit log [n]  (got "${rest.trim()}"; n must be a positive integer)`,
          'audit-usage',
        ),
      };
    }
    limit = n;
  }
  try {
    const result = await ctx.runAudit(
      subcommand === 'log' ? { subcommand, ...(limit !== undefined ? { limit } : {}) } : { subcommand },
    );
    // For verify, `ok: false` is a real signal (broken chain) — we
    // still show the body but tag the reply so the chat pane can
    // color it red if it wants. For log/tail, `ok: false` is a
    // reader error and we surface it as an error reply.
    if (!result.ok && subcommand !== 'verify') {
      return {
        kind: 'handled',
        reply: reply(`Audit ${subcommand} failed: ${result.body}`, 'audit-error'),
      };
    }
    const idSuffix = subcommand === 'verify' && !result.ok ? 'audit-broken' : `audit-${subcommand}`;
    return { kind: 'handled', reply: reply(result.body, idSuffix) };
  } catch (e) {
    return {
      kind: 'handled',
      reply: reply(`Audit ${subcommand} failed: ${(e as Error).message}`, 'audit-error'),
    };
  }
}

/**
 * `/tools [domain]` — list the registered tools, optionally
 * filtered to a single domain (network, web, wifi, reports,
 * shell). Pure formatting via `formatToolList`; the result is
 * pushed into the chat as a system message so it shows up
 * inline in the transcript.
 */
async function handleTools(
  domainArg: string | undefined,
  ctx: SlashContext,
  reply: (content: string, idSuffix: string) => Msg,
): Promise<SlashResult> {
  const filter = domainArg?.toLowerCase().trim();
  // Validate the filter — accepted values match the catalog's
  // `ToolCategory` strings (the same set the picker uses as its
  // group order). Unknown domain -> usage reply (matches the
  // /session /report pattern). `undefined` (no arg) is the
  // "list all" path — different from an unknown domain, so it
  // must not trip the usage reply.
  const knownDomains = new Set<string>([
    'shell',
    'http',
    'file',
    'search',
    'recon',
    'binary',
    'note',
  ]);
  if (filter !== undefined && filter !== '' && !knownDomains.has(filter)) {
    return {
      kind: 'handled',
      reply: reply(
        `Usage: /tools [shell|http|file|search|recon|binary|note]  (got: "${filter || 'nothing'}")`,
        'tools-usage',
      ),
    };
  }
  // `filter` is either `undefined` (no arg) or a known domain.
  // `formatToolList(undefined)` lists everything; `formatToolList(filter)`
  // filters to that single group.
  const result = formatToolList(filter === '' ? undefined : filter);
  return {
    kind: 'handled',
    reply: reply(
      result.text,
      filter === undefined || filter === '' ? 'tools' : `tools-${filter}`,
    ),
  };
}

/**
 * `/run <tool> [args...]` — invoke a tool directly. The dispatch
 * path:
 *   1. `parseRunCommand` validates the tool name + tokenizes the
 *      args (quoted spans preserved).
 *   2. If `ctx.runTool` is absent, return a friendly "tool
 *      runner unavailable" reply (mirrors `/report`).
 *   3. Otherwise hand off to `ctx.runTool(tool, args)`. The
 *      AgentApp implementation goes through the chokepoint +
 *      audit pipeline, so `--scope` and the destructive banner
 *      from T18 still apply.
 *
 * The result is a `toolResult` `Msg` (role: 'tool') with the
 * tool's output. The chokepoint-denied case is surfaced as a
 * reply so the operator sees a clear "denied: <reason>" line
 * without polluting the tool-result stream.
 */
async function handleRun(
  text: string,
  ctx: SlashContext,
  reply: (content: string, idSuffix: string) => Msg,
): Promise<SlashResult> {
  const parsed = parseRunCommand(text, (n) => Boolean(findTool(n)));
  if (!parsed.ok) {
    if (parsed.code === 'missing-tool') {
      return {
        kind: 'handled',
        reply: reply('Usage: /run <tool> [args...]', 'run-usage'),
      };
    }
    // unknown-tool
    return {
      kind: 'handled',
      reply: reply(
        `Unknown tool: ${parsed.tool}\nType /tools to see the list.`,
        'run-unknown',
      ),
    };
  }
  if (!ctx.runTool) {
    return {
      kind: 'handled',
      reply: reply(
        'Tool runner is not wired into this build of gmft.',
        'run-noop',
      ),
    };
  }
  let msg: Msg;
  let denied: boolean;
  try {
    const out = await ctx.runTool(parsed.tool, parsed.args);
    msg = out.msg;
    denied = out.denied;
  } catch (e) {
    return {
      kind: 'handled',
      reply: reply(
        `Run failed: ${(e as Error).message}`,
        'run-error',
      ),
    };
  }
  if (denied) {
    // Chokepoint denied — the result message already carries the
    // reason. Surface a short reply so the transcript has a clean
    // audit marker; the tool message is also pushed.
    return {
      kind: 'handled',
      reply: reply(
        `Tool ${parsed.tool} denied by chokepoint.`,
        'run-denied',
      ),
      toolResult: msg,
    };
  }
  return {
    kind: 'handled',
    reply: reply(`Ran ${parsed.tool}.`, 'run'),
    toolResult: msg,
  };
}

/**
 * v0.4-A.4 — format a {@link SupervisorSnapshot} for the chat reply.
 *
 * Pure formatter — no I/O, no side effects, no React. The output is
 * a multi-line string suitable for the chat pane's `Msg.content`.
 *
 * Layout rules (in priority order):
 *   1. If `postmortem` is present, the postmortem section ALWAYS
 *      renders (header + model provenance + indented body). The
 *      fires section renders only if `fires.length > 0`.
 *   2. If `postmortem` is absent and `fires.length > 0`, render the
 *      "Last turn: N fire(s)" header + the Fires list.
 *   3. If `postmortem` is absent and `fires.length === 0`, render
 *      "Last turn: quiet (no fires)".
 *
 * This lets the postmortem-only subcommand (`/supervisor postmortem`)
 * render just the prose even when fires are present (the dispatcher
 * passes `fires: []` to suppress the fires header in that case).
 *
 * Exported so tests can assert on the exact rendered string without
 * dispatching the slash command.
 */
export function formatSupervisorSnapshot(snapshot: SupervisorSnapshot): string {
  const { fires, postmortem } = snapshot;
  const lines: string[] = [];

  if (fires.length > 0) {
    lines.push(`Last turn: ${fires.length} fire(s)`);
    lines.push('Fires:');
    for (let i = 0; i < fires.length; i++) {
      const f = fires[i]!;
      // PlanIssueFire is the only variant that carries severity + text.
      // For other variants we still surface the kind + advice so the
      // operator can see what fired.
      const severity =
        'severity' in f && typeof f.severity === 'string' ? f.severity : '-';
      const text =
        'text' in f && typeof f.text === 'string' ? f.text : '(see advice)';
      lines.push(
        `  ${i + 1}. [${f.kind}] ${text}` +
          `    (severity: ${severity}, target: ${f.targetEventId})`,
      );
      lines.push(`     advice: ${f.advice}`);
    }
  } else if (postmortem === undefined) {
    lines.push('Last turn: quiet (no fires)');
  }

  if (postmortem !== undefined) {
    const modelLine =
      postmortem.modelUsed !== undefined && postmortem.modelUsed !== ''
        ? ` (model: ${postmortem.modelUsed})`
        : '';
    // The schema uses `postmortem` for the prose body and a separate
    // `postmortemError` for failure cases. If `postmortemError` is
    // set, surface it as the postmortem section so the operator can
    // see why the prose didn't generate (e.g. timeout, model 503).
    const body =
      typeof postmortem.postmortem === 'string' && postmortem.postmortem !== ''
        ? postmortem.postmortem
        : typeof postmortem.postmortemError === 'string' &&
            postmortem.postmortemError !== ''
          ? `(postmortem generation failed: ${postmortem.postmortemError})`
          : '(no postmortem text)';
    lines.push(`Postmortem${modelLine}:`);
    // Indent the prose so it visually separates from the header.
    const indentedBody = body
      .split('\n')
      .map((l: string) => `  ${l}`)
      .join('\n');
    lines.push(indentedBody);
  }

  return lines.join('\n');
}

export type SupervisorSubcommand = 'fires' | 'postmortem';

/**
 * `/supervisor [fires|postmortem]` — show the last turn's supervisor
 * state (fires + postmortem). Mirrors the structure of `/audit`:
 * pure dispatcher, callback in ctx for I/O. Default subcommand
 * renders both sections.
 *
 * Subcommands:
 *   - (none)       — show fires + postmortem
 *   - `fires`      — show only the rule-violation list
 *   - `postmortem` — show only the prose summary
 *
 * The slash command stays pure — `AgentApp.getSupervisorSnapshot`
 * reads from the `withSupervisor` wrapper's `lastFires()` /
 * `lastPostmortem()` accessors.
 */
async function handleSupervisor(
  arg: string | undefined,
  ctx: SlashContext,
  reply: (content: string, idSuffix: string) => Msg,
): Promise<SlashResult> {
  if (!ctx.getSupervisorSnapshot) {
    return {
      kind: 'handled',
      reply: reply(
        'Supervisor is not wired into this build of gmft.',
        'supervisor-noop',
      ),
    };
  }

  const snapshot = ctx.getSupervisorSnapshot();
  if (snapshot === null) {
    return {
      kind: 'handled',
      reply: reply(
        'No turn has completed yet. Run a turn first, then /supervisor will show its fires + postmortem.',
        'supervisor-empty',
      ),
    };
  }

  // Parse the optional subcommand. Unknown values fall back to the
  // default (both fires + postmortem) so the operator can recover
  // from typos without leaving the TUI.
  const sub = arg?.toLowerCase();
  if (sub !== undefined && sub !== 'fires' && sub !== 'postmortem') {
    return {
      kind: 'handled',
      reply: reply(
        `Unknown supervisor subcommand: ${sub}\nUsage: /supervisor [fires|postmortem]`,
        'supervisor-usage',
      ),
    };
  }

  const subcommand: SupervisorSubcommand | undefined =
    sub === 'fires' || sub === 'postmortem' ? sub : undefined;

  // Build a view-shaped snapshot so the formatter can render only
  // the requested section. For the fires-only subcommand we pass the
  // real fires array; for the postmortem-only subcommand we pass
  // `fires: []` so the formatter suppresses the fires header (the
  // `Last turn: N fire(s)` line) and renders only the postmortem
  // section. For the default (both) we pass the snapshot verbatim.
  let view: SupervisorSnapshot;
  let idSuffix: string;
  if (subcommand === 'fires') {
    view = { fires: snapshot.fires };
    idSuffix = 'supervisor-fires';
  } else if (subcommand === 'postmortem') {
    view = {
      fires: [],
      ...(snapshot.postmortem !== undefined
        ? { postmortem: snapshot.postmortem }
        : {}),
    };
    idSuffix = 'supervisor-postmortem';
  } else {
    view = snapshot;
    idSuffix = 'supervisor';
  }

  return {
    kind: 'handled',
    reply: reply(formatSupervisorSnapshot(view), idSuffix),
  };
}
