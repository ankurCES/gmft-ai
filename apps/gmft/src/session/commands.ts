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
 * Commands (phase 1.5e):
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
 *
 * Anything starting with `/` that we don't recognize is a `handled:error`
 * — we never forward unknown slash input to the LLM.
 */

import type { Message as Msg } from '../ui/components/Message.js';
import type { SessionInfo, SessionStore } from './store.js';

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
}

export const HELP_TEXT =
  'Commands (phase 1.5e):\n' +
  '  /help                       show this help\n' +
  '  /clear                      clear chat (log kept on disk)\n' +
  '  /model <id>                 switch model in-memory\n' +
  '  /provider <id>              switch provider (model cleared)\n' +
  '  /session new                start a new session (clears chat)\n' +
  '  /session list               list sessions on disk\n' +
  '  /session load <id>          load a session and replay turns\n' +
  '  /session clear              clear current pointer (logs kept)\n' +
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
