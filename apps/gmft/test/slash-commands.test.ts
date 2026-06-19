import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatchSlash, type SlashContext } from '../src/session/commands.js';
import { SessionStore } from '../src/session/store.js';
import type { Message as Msg } from '../src/ui/components/Message.js';
import type {
  SupervisorFire,
  SupervisorTurnRecord,
} from '@gmft/core';

describe('dispatchSlash', () => {
  let tmp: string;
  let store: SessionStore;
  let onSwitchModel: ReturnType<typeof vi.fn>;
  let onExit: ReturnType<typeof vi.fn>;

  const baseMessages: Msg[] = [
    { id: 'a', role: 'user', content: 'hi', ts: 1 },
    { id: 'b', role: 'assistant', content: 'hello', ts: 2 },
  ];

  function makeCtx(overrides: Partial<SlashContext> = {}): SlashContext {
    return {
      messages: baseMessages,
      currentProvider: 'anthropic',
      currentModel: 'claude-3-5-haiku-latest',
      session: store,
      onSwitchModel,
      onExit,
      ...overrides,
    };
  }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'gmft-slash-'));
    store = new SessionStore({
      root: join(tmp, 'sessions'),
      currentIdPath: join(tmp, 'current-session-id'),
    });
    onSwitchModel = vi.fn();
    onExit = vi.fn();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('non-slash input returns { kind: "sent" } (caller forwards to LLM)', async () => {
    const r = await dispatchSlash('hello world', makeCtx());
    expect(r.kind).toBe('sent');
  });

  it('/help returns the help text reply and does not touch the session', async () => {
    const r = await dispatchSlash('/help', makeCtx());
    expect(r.kind).toBe('handled');
    if (r.kind !== 'handled') throw new Error('narrow');
    expect(r.reply).toBeDefined();
    expect(r.reply!.content).toContain('/help');
    expect(r.reply!.content).toContain('/session new');
    expect(r.clearMessages).toBeUndefined();
    expect(r.replaceMessages).toBeUndefined();
    expect(onSwitchModel).not.toHaveBeenCalled();
    expect(onExit).not.toHaveBeenCalled();
  });

  it('/clear sets clearMessages and reports the count', async () => {
    const r = await dispatchSlash('/clear', makeCtx());
    expect(r.kind).toBe('handled');
    if (r.kind !== 'handled') throw new Error('narrow');
    expect(r.clearMessages).toBe(true);
    expect(r.reply).toBeDefined();
    expect(r.reply!.content).toContain('Cleared 2 message(s)');
  });

  it('/model <id> calls onSwitchModel with current provider + new model', async () => {
    const r = await dispatchSlash('/model gpt-4o-mini', makeCtx());
    expect(r.kind).toBe('handled');
    expect(onSwitchModel).toHaveBeenCalledWith({
      provider: 'anthropic',
      model: 'gpt-4o-mini',
    });
    if (r.kind !== 'handled') throw new Error('narrow');
    expect(r.reply!.content).toContain('gpt-4o-mini');
  });

  it('/model without an arg returns a usage reply, no model switch', async () => {
    const r = await dispatchSlash('/model', makeCtx());
    expect(r.kind).toBe('handled');
    expect(onSwitchModel).not.toHaveBeenCalled();
    if (r.kind !== 'handled') throw new Error('narrow');
    expect(r.reply!.content).toContain('Usage');
  });

  it('/provider <id> signals the AgentApp to switch (model slot cleared; AgentApp picks the default)', async () => {
    // The dispatcher is pure: it tells AgentApp "switch to this
    // provider" with an empty model slot. AgentApp then looks up a
    // default via the model catalog (1.5f). The dispatcher itself
    // doesn't know about defaults — that decision lives in the
    // React layer so the test surface stays small.
    const r = await dispatchSlash('/provider openai', makeCtx());
    expect(r.kind).toBe('handled');
    expect(onSwitchModel).toHaveBeenCalledWith({ provider: 'openai', model: '' });
  });

  it('/provider without an arg returns a usage reply, no switch', async () => {
    const r = await dispatchSlash('/provider', makeCtx());
    expect(r.kind).toBe('handled');
    expect(onSwitchModel).not.toHaveBeenCalled();
  });

  it('/provider reply mentions the default-model behavior (1.5f)', async () => {
    // The reply text is the only user-facing signal that the model
    // slot is empty + will be auto-filled. Keep this in sync with
    // the dispatcher's reply.
    const r = await dispatchSlash('/provider openai', makeCtx());
    expect(r.kind).toBe('handled');
    expect(r.reply?.content).toContain('default model');
  });

  it('/exit returns { kind: "exited" } and calls onExit', async () => {
    const r = await dispatchSlash('/exit', makeCtx());
    expect(r.kind).toBe('exited');
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('/session new starts a session and clears messages', async () => {
    const r = await dispatchSlash('/session new', makeCtx());
    expect(r.kind).toBe('handled');
    if (r.kind !== 'handled') throw new Error('narrow');
    expect(r.clearMessages).toBe(true);
    expect(r.reply!.content).toContain('Started new session:');
    expect(await store.currentId()).not.toBeNull();
  });

  it('/session list returns "No sessions on disk." when empty', async () => {
    const r = await dispatchSlash('/session list', makeCtx());
    expect(r.kind).toBe('handled');
    if (r.kind !== 'handled') throw new Error('narrow');
    expect(r.reply!.content).toBe('No sessions on disk.');
  });

  it('/session list shows sessions after /session new', async () => {
    await store.start('alpha');
    await store.append({ role: 'user', content: 'a', ts: 1 });
    const r = await dispatchSlash('/session list', makeCtx());
    expect(r.kind).toBe('handled');
    if (r.kind !== 'handled') throw new Error('narrow');
    expect(r.reply!.content).toContain('alpha');
    expect(r.reply!.content).toContain('* alpha'); // current marker
    expect(r.reply!.content).toContain('1 turn');
  });

  it('/session load <id> hydrates messages from the log', async () => {
    await store.start('source');
    await store.append({ role: 'user', content: 'q1', ts: 10 });
    await store.append({ role: 'assistant', content: 'a1', ts: 11 });
    // Switch to a different "current" so we can prove load() updates it.
    await store.start('other');
    const before = await store.currentId();
    expect(before).toBe('other');

    const r = await dispatchSlash('/session load source', makeCtx());
    expect(r.kind).toBe('handled');
    if (r.kind !== 'handled') throw new Error('narrow');
    expect(r.replaceMessages).toBeDefined();
    expect(r.replaceMessages).toHaveLength(2);
    expect(r.replaceMessages![0]?.content).toBe('q1');
    expect(r.replaceMessages![1]?.content).toBe('a1');
    expect(r.clearMessages).toBeUndefined();
    expect(await store.currentId()).toBe('source');
  });

  it('/session load <missing-id> returns a handled error reply, does not crash', async () => {
    const r = await dispatchSlash('/session load nope', makeCtx());
    expect(r.kind).toBe('handled');
    if (r.kind !== 'handled') throw new Error('narrow');
    expect(r.reply!.content).toContain('No turns found');
    expect(r.replaceMessages).toBeUndefined();
  });

  it('/session load without an arg returns a usage reply', async () => {
    const r = await dispatchSlash('/session load', makeCtx());
    expect(r.kind).toBe('handled');
    if (r.kind !== 'handled') throw new Error('narrow');
    expect(r.reply!.content).toContain('Usage');
  });

  it('/session clear removes the pointer but keeps logs', async () => {
    await store.start('keep');
    const r = await dispatchSlash('/session clear', makeCtx());
    expect(r.kind).toBe('handled');
    expect(await store.currentId()).toBeNull();
    expect(await store.load('keep')).toEqual([]); // empty, but not deleted
  });

  it('/session with no subcommand returns a usage reply', async () => {
    const r = await dispatchSlash('/session', makeCtx());
    expect(r.kind).toBe('handled');
    if (r.kind !== 'handled') throw new Error('narrow');
    expect(r.reply!.content).toContain('Usage');
  });

  it('/session with unknown sub returns a usage reply naming the bad sub', async () => {
    const r = await dispatchSlash('/session banana', makeCtx());
    expect(r.kind).toBe('handled');
    if (r.kind !== 'handled') throw new Error('narrow');
    expect(r.reply!.content).toContain('banana');
  });

  it('/resume with no current session returns a handled error', async () => {
    const r = await dispatchSlash('/resume', makeCtx());
    expect(r.kind).toBe('handled');
    if (r.kind !== 'handled') throw new Error('narrow');
    expect(r.reply!.content).toContain('No current session');
  });

  it('/resume with a current session hydrates the messages', async () => {
    await store.start('resumable');
    await store.append({ role: 'user', content: 'prev', ts: 99 });
    const r = await dispatchSlash('/resume', makeCtx());
    expect(r.kind).toBe('handled');
    if (r.kind !== 'handled') throw new Error('narrow');
    expect(r.replaceMessages).toHaveLength(1);
    expect(r.replaceMessages![0]?.content).toBe('prev');
  });

  it('unknown slash commands return a handled error, never forwarded to LLM', async () => {
    const r = await dispatchSlash('/foobar', makeCtx());
    expect(r.kind).toBe('handled');
    if (r.kind !== 'handled') throw new Error('narrow');
    expect(r.reply!.content).toContain('Unknown command');
    expect(r.reply!.content).toContain('/foobar');
  });

  // ───── /report ────────────────────────────────────────────────
  describe('/report', () => {
    it('returns a "not wired" reply when runReport is absent', async () => {
      const r = await dispatchSlash('/report md', makeCtx());
      expect(r.kind).toBe('handled');
      if (r.kind !== 'handled') throw new Error('narrow');
      expect(r.reply!.content).toMatch(/not wired|not available/i);
    });

    it('default format is md; passes through to runReport', async () => {
      const runReport = vi.fn().mockResolvedValue({
        path: '/tmp/x.md',
        format: 'md',
        findingCount: 3,
        bytesWritten: 512,
      });
      const r = await dispatchSlash('/report', makeCtx({ runReport }));
      expect(r.kind).toBe('handled');
      if (r.kind !== 'handled') throw new Error('narrow');
      expect(runReport).toHaveBeenCalledWith({ format: 'md', outputPath: undefined });
      expect(r.reply!.content).toContain('/tmp/x.md');
      expect(r.reply!.content).toContain('md');
      expect(r.reply!.content).toContain('3');
    });

    it('honors explicit format + path (json, pdf)', async () => {
      const runReport = vi.fn().mockResolvedValue({
        path: '/tmp/x.json',
        format: 'json',
        findingCount: 1,
        bytesWritten: 100,
      });
      const r = await dispatchSlash('/report json /tmp/x.json', makeCtx({ runReport }));
      if (r.kind !== 'handled') throw new Error('narrow');
      expect(runReport).toHaveBeenCalledWith({ format: 'json', outputPath: '/tmp/x.json' });
      expect(r.reply!.content).toContain('/tmp/x.json');
    });

    it('accepts "markdown" as an alias for "md"', async () => {
      const runReport = vi.fn().mockResolvedValue({
        path: '/tmp/y.md',
        format: 'md',
        findingCount: 0,
        bytesWritten: 0,
      });
      const r = await dispatchSlash('/report markdown', makeCtx({ runReport }));
      if (r.kind !== 'handled') throw new Error('narrow');
      expect(runReport).toHaveBeenCalledWith({ format: 'md', outputPath: undefined });
    });

    it('rejects unknown format with a usage reply', async () => {
      const runReport = vi.fn();
      const r = await dispatchSlash('/report html', makeCtx({ runReport }));
      if (r.kind !== 'handled') throw new Error('narrow');
      expect(runReport).not.toHaveBeenCalled();
      expect(r.reply!.content).toContain('Usage: /report');
      expect(r.reply!.content).toContain('html');
    });

    it('for PDF, also calls openFile and mentions it in the reply', async () => {
      const runReport = vi.fn().mockResolvedValue({
        path: '/tmp/z.pdf',
        format: 'pdf',
        findingCount: 2,
        bytesWritten: 4096,
      });
      const openFile = vi.fn().mockResolvedValue(undefined);
      const r = await dispatchSlash('/report pdf', makeCtx({ runReport, openFile }));
      if (r.kind !== 'handled') throw new Error('narrow');
      expect(openFile).toHaveBeenCalledWith('/tmp/z.pdf');
      expect(r.reply!.content).toContain('opened in default viewer');
    });

    it('PDF: openFile failure surfaces in the reply (does not throw)', async () => {
      const runReport = vi.fn().mockResolvedValue({
        path: '/tmp/z.pdf',
        format: 'pdf',
        findingCount: 2,
        bytesWritten: 4096,
      });
      const openFile = vi.fn().mockRejectedValue(new Error('xdg-open: command not found'));
      const r = await dispatchSlash('/report pdf', makeCtx({ runReport, openFile }));
      if (r.kind !== 'handled') throw new Error('narrow');
      expect(r.reply!.content).toContain('open failed');
      expect(r.reply!.content).toContain('xdg-open');
    });

    it('runReport failure surfaces as a friendly error reply', async () => {
      const runReport = vi.fn().mockRejectedValue(new Error('No findings yet.'));
      const r = await dispatchSlash('/report md', makeCtx({ runReport }));
      if (r.kind !== 'handled') throw new Error('narrow');
      expect(r.reply!.content).toContain('Report failed');
      expect(r.reply!.content).toContain('No findings yet.');
    });

    it('help text mentions /report', async () => {
      const r = await dispatchSlash('/help', makeCtx());
      if (r.kind !== 'handled') throw new Error('narrow');
      expect(r.reply!.content).toContain('/report');
      expect(r.reply!.content).toContain('md|json|pdf');
    });
  });

  // ───── /tools ────────────────────────────────────────────────
  describe('/tools', () => {
    it('lists every tool grouped by domain when called with no arg', async () => {
      const r = await dispatchSlash('/tools', makeCtx());
      expect(r.kind).toBe('handled');
      if (r.kind !== 'handled') throw new Error('narrow');
      // Heading: count of registered tools.
      expect(r.reply!.content).toMatch(/^\d+ tools? registered:/m);
      // Domains that should be visible (the picker groups by
      // ToolCategory from @gmft/core, so all four live categories
      // must show up).
      expect(r.reply!.content).toContain('recon (');
      expect(r.reply!.content).toContain('binary (');
      expect(r.reply!.content).toContain('file (');
      expect(r.reply!.content).toContain('shell (');
      // Spot-check a few well-known tools.
      expect(r.reply!.content).toContain('nmap');
      expect(r.reply!.content).toContain('httpx');
      expect(r.reply!.content).toContain('evil_twin');
      expect(r.reply!.content).toContain('shell_exec');
      expect(r.reply!.content).toContain('report_pdf');
    });

    it('filters to a single domain when given', async () => {
      const r = await dispatchSlash('/tools binary', makeCtx());
      if (r.kind !== 'handled') throw new Error('narrow');
      // Domain-specific heading.
      expect(r.reply!.content).toMatch(/^\d+ binary tools?:/m);
      // The 'binary' group is in the output...
      expect(r.reply!.content).toContain('binary (');
      // ...but other domains are NOT.
      expect(r.reply!.content).not.toContain('recon (');
      expect(r.reply!.content).not.toContain('shell (');
      // Spot-check a binary-domain tool.
      expect(r.reply!.content).toContain('httpx');
    });

    it('accepts `recon` as a filter (the live network category)', async () => {
      const r = await dispatchSlash('/tools recon', makeCtx());
      if (r.kind !== 'handled') throw new Error('narrow');
      expect(r.reply!.content).toMatch(/^\d+ recon tools?:/m);
      expect(r.reply!.content).toContain('nmap');
      expect(r.reply!.content).not.toContain('binary (');
    });

    it('rejects an unknown domain with a usage reply naming the bad value', async () => {
      const r = await dispatchSlash('/tools banana', makeCtx());
      if (r.kind !== 'handled') throw new Error('narrow');
      expect(r.reply!.content).toContain('Usage: /tools');
      expect(r.reply!.content).toContain('banana');
    });

    it('treats `/tools` with no arg as a list-all (not a usage error)', async () => {
      // v0.3.B: a bare `/tools` is the most common form (no arg
      // means "list everything"). It must NOT trigger the usage
      // reply that an unknown domain does.
      const r = await dispatchSlash('/tools', makeCtx());
      if (r.kind !== 'handled') throw new Error('narrow');
      expect(r.reply!.content).not.toContain('Usage: /tools');
    });

    it('help text mentions /tools and the new domains', async () => {
      const r = await dispatchSlash('/help', makeCtx());
      if (r.kind !== 'handled') throw new Error('narrow');
      expect(r.reply!.content).toContain('/tools');
      // The domains list should be the canonical ToolCategory set.
      expect(r.reply!.content).toContain('recon');
      expect(r.reply!.content).toContain('binary');
      expect(r.reply!.content).toContain('shell');
    });
  });

  // ───── /run ─────────────────────────────────────────────────
  describe('/run', () => {
    it('returns a "not wired" reply when runTool is absent', async () => {
      const r = await dispatchSlash('/run nmap 10.0.0.0/24', makeCtx());
      if (r.kind !== 'handled') throw new Error('narrow');
      expect(r.reply!.content).toMatch(/not wired|not available/i);
    });

    it('invokes runTool with the parsed tool name + args and surfaces the tool result', async () => {
      const toolMsg: Msg = {
        id: 't-1',
        role: 'tool',
        content: 'Nmap scan: 3 hosts up.',
        ts: 100,
        toolCallId: 'tc-1',
      };
      const runTool = vi
        .fn()
        .mockResolvedValue({ msg: toolMsg, denied: false });
      const r = await dispatchSlash('/run nmap 10.0.0.0/24', makeCtx({ runTool }));
      if (r.kind !== 'handled') throw new Error('narrow');
      expect(runTool).toHaveBeenCalledWith('nmap', ['10.0.0.0/24']);
      // Short text reply AND the structured tool message both come
      // back so the caller can push both into the chat.
      expect(r.reply!.content).toContain('Ran nmap');
      expect(r.toolResult).toEqual(toolMsg);
    });

    it('preserves quoted args verbatim (single, double, backslash)', async () => {
      const runTool = vi
        .fn()
        .mockResolvedValue({ msg: baseMessages[0]!, denied: false });
      const r = await dispatchSlash(
        '/run httpx -title "x y" -u https://example.com',
        makeCtx({ runTool }),
      );
      if (r.kind !== 'handled') throw new Error('narrow');
      expect(runTool).toHaveBeenCalledWith('httpx', [
        '-title',
        'x y',
        '-u',
        'https://example.com',
      ]);
    });

    it('returns a usage reply for `/run` with no tool name', async () => {
      const runTool = vi.fn();
      const r = await dispatchSlash('/run', makeCtx({ runTool }));
      if (r.kind !== 'handled') throw new Error('narrow');
      expect(runTool).not.toHaveBeenCalled();
      expect(r.reply!.content).toContain('Usage: /run');
    });

    it('returns an "unknown tool" reply for a name not in the catalog', async () => {
      const runTool = vi.fn();
      const r = await dispatchSlash('/run banana 1.2.3.4', makeCtx({ runTool }));
      if (r.kind !== 'handled') throw new Error('narrow');
      expect(runTool).not.toHaveBeenCalled();
      expect(r.reply!.content).toContain('Unknown tool');
      expect(r.reply!.content).toContain('banana');
      // Reply points the user at /tools.
      expect(r.reply!.content).toContain('/tools');
    });

    it('surfaces a chokepoint denial as a short reply + the tool msg', async () => {
      // runTool returns the denial message AND a denied flag. The
      // dispatcher surfaces a short "denied by chokepoint" reply so
      // the transcript has a clean audit marker.
      const deniedMsg: Msg = {
        id: 't-2',
        role: 'tool',
        content: 'Tool nmap denied: target outside scope.',
        ts: 200,
      };
      const runTool = vi
        .fn()
        .mockResolvedValue({ msg: deniedMsg, denied: true });
      const r = await dispatchSlash('/run nmap 10.0.0.0/24', makeCtx({ runTool }));
      if (r.kind !== 'handled') throw new Error('narrow');
      expect(r.reply!.content).toContain('denied by chokepoint');
      expect(r.reply!.content).toContain('nmap');
      expect(r.toolResult).toEqual(deniedMsg);
    });

    it('a runTool that throws surfaces a friendly error reply (does not crash)', async () => {
      const runTool = vi.fn().mockRejectedValue(new Error('chokepoint down'));
      const r = await dispatchSlash('/run nmap 10.0.0.0/24', makeCtx({ runTool }));
      if (r.kind !== 'handled') throw new Error('narrow');
      expect(r.reply!.content).toContain('Run failed');
      expect(r.reply!.content).toContain('chokepoint down');
    });

    it('help text mentions /run', async () => {
      const r = await dispatchSlash('/help', makeCtx());
      if (r.kind !== 'handled') throw new Error('narrow');
      expect(r.reply!.content).toContain('/run');
    });
  });

  // ───── /audit (v0.3.C follow-up) ───────────────────────────────
  describe('/audit', () => {
    it('/audit verify shows intact-chain body when ok=true', async () => {
      const runAudit = vi.fn().mockResolvedValue({
        ok: true,
        body: '✓ audit chain intact (1247 events, 0 broken)\n  last event: 2026-06-17T19:23:45.123Z (tool-result)',
      });
      const r = await dispatchSlash('/audit verify', makeCtx({ runAudit }));
      if (r.kind !== 'handled') throw new Error('narrow');
      expect(runAudit).toHaveBeenCalledWith({ subcommand: 'verify' });
      expect(r.reply!.content).toContain('✓ audit chain intact');
      expect(r.reply!.id.endsWith('-audit-verify')).toBe(true);
    });

    it('/audit verify with broken chain still shows the body (regression: operator must see WHERE)', async () => {
      // ok=false on verify means the chain is broken — the chat
      // reply still shows the body so the operator can see which
      // line broke. The idSuffix flips to 'audit-broken' so the
      // UI can color it red.
      const runAudit = vi.fn().mockResolvedValue({
        ok: false,
        body:
          '✗ audit chain BROKEN at line 847\n  recorded: a83f3bb3c8...\n  computed: f0e6c6e9a1...\n  events 848..1247 cannot be verified',
      });
      const r = await dispatchSlash('/audit verify', makeCtx({ runAudit }));
      if (r.kind !== 'handled') throw new Error('narrow');
      expect(r.reply!.content).toContain('BROKEN at line 847');
      expect(r.reply!.id.endsWith('-audit-broken')).toBe(true);
    });

    it('/audit log defaults to limit=50 when no N is given', async () => {
      const runAudit = vi.fn().mockResolvedValue({
        ok: true,
        body: 'Last 50 audit event(s):\n...',
      });
      const r = await dispatchSlash('/audit log', makeCtx({ runAudit }));
      if (r.kind !== 'handled') throw new Error('narrow');
      expect(runAudit).toHaveBeenCalledWith({ subcommand: 'log' });
      expect(r.reply!.content).toContain('Last 50 audit event');
    });

    it('/audit log 10 passes the limit through', async () => {
      const runAudit = vi.fn().mockResolvedValue({
        ok: true,
        body: 'Last 10 audit event(s):\n...',
      });
      const r = await dispatchSlash('/audit log 10', makeCtx({ runAudit }));
      if (r.kind !== 'handled') throw new Error('narrow');
      expect(runAudit).toHaveBeenCalledWith({ subcommand: 'log', limit: 10 });
    });

    it('/audit log abc returns a usage reply without invoking the runner', async () => {
      const runAudit = vi.fn();
      const r = await dispatchSlash('/audit log abc', makeCtx({ runAudit }));
      if (r.kind !== 'handled') throw new Error('narrow');
      expect(runAudit).not.toHaveBeenCalled();
      expect(r.reply!.content).toContain('Usage: /audit log');
    });

    it('/audit tail invokes the runner with subcommand=tail', async () => {
      const runAudit = vi.fn().mockResolvedValue({
        ok: true,
        body: 'Tail (most recent 20 event(s)):\n...',
      });
      const r = await dispatchSlash('/audit tail', makeCtx({ runAudit }));
      if (r.kind !== 'handled') throw new Error('narrow');
      expect(runAudit).toHaveBeenCalledWith({ subcommand: 'tail' });
      expect(r.reply!.content).toContain('Tail');
    });

    it('/audit with no subcommand returns a usage reply', async () => {
      const runAudit = vi.fn();
      const r = await dispatchSlash('/audit', makeCtx({ runAudit }));
      if (r.kind !== 'handled') throw new Error('narrow');
      expect(runAudit).not.toHaveBeenCalled();
      expect(r.reply!.content).toContain('Usage: /audit');
    });

    it('/audit bogus returns a usage reply without invoking the runner', async () => {
      const runAudit = vi.fn();
      const r = await dispatchSlash('/audit bogus', makeCtx({ runAudit }));
      if (r.kind !== 'handled') throw new Error('narrow');
      expect(runAudit).not.toHaveBeenCalled();
      expect(r.reply!.content).toContain('Unknown audit subcommand');
    });

    it('returns a friendly "not wired" reply when runAudit is absent', async () => {
      const r = await dispatchSlash('/audit verify', makeCtx());
      if (r.kind !== 'handled') throw new Error('narrow');
      expect(r.reply!.content).toContain('not wired');
    });

    it('help text mentions /audit', async () => {
      const r = await dispatchSlash('/help', makeCtx());
      if (r.kind !== 'handled') throw new Error('narrow');
      // HELP_TEXT is a fixed-width table — "/audit verify" is
      // padded with leading spaces. Check the bare command name
      // plus each subcommand fragment; that catches a missing
      // subcommand without coupling to whitespace.
      expect(r.reply!.content).toContain('/audit');
      expect(r.reply!.content).toContain('verify');
      expect(r.reply!.content).toContain('walk the audit chain');
      expect(r.reply!.content).toContain('show recent audit events');
      expect(r.reply!.content).toContain('follow the audit log');
    });
  });

  // ───── /supervisor (v0.4-A.4) ──────────────────────────────────
  // The /supervisor slash command surfaces the withSupervisor
  // wrapper's lastFires() + lastPostmortem() accessors to the chat
  // pane. Tests below cover:
  //   1. snapshot is null (no turn yet) => friendly "no turn yet" reply
  //   2. callback missing on SlashContext => "supervisor not wired"
  //   3. quiet turn (fires=[], no postmortem) => "quiet" body
  //   4. fires + postmortem (default subcommand) => renders both
  //   5. /supervisor fires => renders only fires (no postmortem header)
  //   6. /supervisor postmortem => renders only postmortem (no fires list)
  //   7. unknown subcommand => friendly usage reply
  describe('/supervisor', () => {
    function makeSnapshot(overrides: {
      fires?: readonly SupervisorFire[];
      postmortem?: SupervisorTurnRecord;
    } = {}): { fires: readonly SupervisorFire[]; postmortem?: SupervisorTurnRecord } {
      const result: { fires: readonly SupervisorFire[]; postmortem?: SupervisorTurnRecord } = {
        fires: overrides.fires ?? [],
      };
      if (overrides.postmortem !== undefined) result.postmortem = overrides.postmortem;
      return result;
    }

    function makeCtxWithSnapshot(
      snapshot: ReturnType<typeof makeSnapshot> | null,
    ): SlashContext {
      return makeCtx({
        getSupervisorSnapshot: () => snapshot,
      });
    }

    // Test fixtures used across multiple cases. The fires here use the
    // exact shapes from `@gmft/core`'s supervisor-types.ts so they
    // survive any future tightening of the type union.
    const loopFire: SupervisorFire = {
      kind: 'loop-detected',
      tool: 'nmap_scan',
      count: 4,
      recent: ['nmap_scan', 'nmap_scan', 'nmap_scan', 'nmap_scan'],
      advice: 'Vary the args or move on.',
      targetEventId: 'evt-1',
    };
    const planFire: SupervisorFire = {
      kind: 'plan-issue',
      severity: 'warn',
      text: 'sqlmap invoked without prior recon',
      advice: 'Add a recon step before sqlmap.',
      targetEventId: 'evt-2',
    };
    const firesOnly: readonly SupervisorFire[] = [loopFire];
    const bothFires: readonly SupervisorFire[] = [loopFire, planFire];
    const postmortem: SupervisorTurnRecord = {
      fires: bothFires,
      // NOTE: the SupervisorTurnRecord schema uses `postmortem` for
      // the prose body (and a separate `postmortemError` for failure
      // cases). Earlier revisions of this test used a `body:` field,
      // which was the pre-A.3 schema — that no longer type-checks
      // and would be silently dropped by the formatter.
      postmortem: 'WHAT: sqlmap was called too early.\nLEARNED: need recon first.',
      modelUsed: 'claude-haiku-4-5',
    };

    it('returns a "no turn yet" reply when getSupervisorSnapshot returns null', async () => {
      const r = await dispatchSlash('/supervisor', makeCtxWithSnapshot(null));
      if (r.kind !== 'handled') throw new Error('narrow');
      expect(r.reply).toBeDefined();
      expect(r.reply!.content).toContain('No turn has completed');
    });

    it('returns a "not wired" reply when getSupervisorSnapshot is missing from ctx', async () => {
      // makeCtx() with no overrides => no getSupervisorSnapshot.
      const r = await dispatchSlash('/supervisor', makeCtx());
      if (r.kind !== 'handled') throw new Error('narrow');
      expect(r.reply!.content).toContain('not wired');
    });

    it('renders a "quiet (no fires)" body for a snapshot with empty fires and no postmortem', async () => {
      const r = await dispatchSlash(
        '/supervisor',
        makeCtxWithSnapshot(makeSnapshot({ fires: [] })),
      );
      if (r.kind !== 'handled') throw new Error('narrow');
      expect(r.reply!.content).toContain('quiet');
      expect(r.reply!.content).toContain('no fires');
      // No fires list, no postmortem header for a quiet turn.
      expect(r.reply!.content).not.toContain('Fires:');
      expect(r.reply!.content).not.toContain('Postmortem');
    });

    it('renders fires + postmortem for the default subcommand (no arg)', async () => {
      const r = await dispatchSlash(
        '/supervisor',
        makeCtxWithSnapshot(makeSnapshot({ fires: bothFires, postmortem })),
      );
      if (r.kind !== 'handled') throw new Error('narrow');
      // Header line: "Last turn: 2 fire(s)".
      expect(r.reply!.content).toContain('Last turn: 2 fire(s)');
      // Fires list includes both fire kinds.
      expect(r.reply!.content).toContain('[loop-detected]');
      expect(r.reply!.content).toContain('[plan-issue]');
      // LoopDetectedFire doesn't carry severity/text, but the formatter
      // renders "(severity: -)" + "(see advice)" so the operator sees
      // a placeholder, not a crash.
      expect(r.reply!.content).toContain('severity: -');
      // PlanIssueFire carries severity + text — both must be present.
      expect(r.reply!.content).toContain('severity: warn');
      expect(r.reply!.content).toContain('sqlmap invoked without prior recon');
      // Postmortem header + body + model provenance line.
      expect(r.reply!.content).toContain('Postmortem');
      expect(r.reply!.content).toContain('(model: claude-haiku-4-5)');
      expect(r.reply!.content).toContain('WHAT: sqlmap was called too early.');
    });

    it('renders only fires for the /supervisor fires subcommand (no postmortem header)', async () => {
      const r = await dispatchSlash(
        '/supervisor fires',
        makeCtxWithSnapshot(makeSnapshot({ fires: bothFires, postmortem })),
      );
      if (r.kind !== 'handled') throw new Error('narrow');
      // The id suffix proves the right sub-branch fired.
      expect(r.reply!.id).toContain('supervisor-fires');
      // Fires list is present.
      expect(r.reply!.content).toContain('[loop-detected]');
      expect(r.reply!.content).toContain('[plan-issue]');
      // Postmortem section is NOT rendered for the fires-only subcommand.
      expect(r.reply!.content).not.toContain('Postmortem');
      expect(r.reply!.content).not.toContain('(model:');
    });

    it('renders only the postmortem for the /supervisor postmortem subcommand', async () => {
      const r = await dispatchSlash(
        '/supervisor postmortem',
        makeCtxWithSnapshot(makeSnapshot({ fires: bothFires, postmortem })),
      );
      if (r.kind !== 'handled') throw new Error('narrow');
      // The id suffix proves the right sub-branch fired.
      expect(r.reply!.id).toContain('supervisor-postmortem');
      // Postmortem header + body + model provenance line.
      expect(r.reply!.content).toContain('Postmortem');
      expect(r.reply!.content).toContain('(model: claude-haiku-4-5)');
      expect(r.reply!.content).toContain('WHAT: sqlmap was called too early.');
      // Fires list is NOT rendered for the postmortem-only subcommand.
      expect(r.reply!.content).not.toContain('[loop-detected]');
      expect(r.reply!.content).not.toContain('[plan-issue]');
    });

    it('returns a usage reply for an unknown subcommand (e.g. /supervisor bogus)', async () => {
      const r = await dispatchSlash(
        '/supervisor bogus',
        makeCtxWithSnapshot(makeSnapshot({ fires: firesOnly, postmortem })),
      );
      if (r.kind !== 'handled') throw new Error('narrow');
      expect(r.reply!.content).toContain('Unknown supervisor subcommand');
      expect(r.reply!.content).toContain('Usage: /supervisor [fires|postmortem]');
    });
  });
});
