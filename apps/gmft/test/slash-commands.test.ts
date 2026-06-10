import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatchSlash, type SlashContext } from '../src/session/commands.js';
import { SessionStore } from '../src/session/store.js';
import type { Message as Msg } from '../src/ui/components/Message.js';

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

  it('/provider <id> switches provider and clears the model', async () => {
    const r = await dispatchSlash('/provider openai', makeCtx());
    expect(r.kind).toBe('handled');
    expect(onSwitchModel).toHaveBeenCalledWith({ provider: 'openai', model: '' });
  });

  it('/provider without an arg returns a usage reply, no switch', async () => {
    const r = await dispatchSlash('/provider', makeCtx());
    expect(r.kind).toBe('handled');
    expect(onSwitchModel).not.toHaveBeenCalled();
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
});
