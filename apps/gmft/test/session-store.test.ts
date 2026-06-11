import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../src/session/store.js';

describe('SessionStore', () => {
  let tmp: string;
  let store: SessionStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'gmft-sess-'));
    store = new SessionStore({
      root: join(tmp, 'sessions'),
      currentIdPath: join(tmp, 'current-session-id'),
    });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('start() creates an empty log + writes the current pointer', async () => {
    const id = await store.start('manual-id');
    expect(id).toBe('manual-id');
    const turns = await store.current();
    expect(turns).toEqual([]);
    const current = await store.currentId();
    expect(current).toBe('manual-id');
  });

  it('start() auto-generates a slug id when none is provided', async () => {
    const id = await store.start();
    expect(id).toMatch(/^\d{8}-\d{6}-[0-9a-f]{6}$/);
    expect(await store.currentId()).toBe(id);
  });

  it('append() writes to the current session log', async () => {
    const id = await store.start('sess-1');
    await store.append({ role: 'user', content: 'hello', meta: { ts: 1000 } });
    await store.append({ role: 'assistant', content: 'hi', meta: { ts: 1001 } });
    const turns = await store.load(id);
    expect(turns).toEqual([
      { schemaVersion: 2, role: 'user', content: 'hello', meta: { ts: 1000 }, ts: turns[0]!.ts, id: '1' },
      { schemaVersion: 2, role: 'assistant', content: 'hi', meta: { ts: 1001 }, ts: turns[1]!.ts, id: '2' },
    ]);
  });

  it('append() throws when there is no current session', async () => {
    // Store exists, but no current pointer written.
    await expect(
      store.append({ role: 'user', content: 'orphan', meta: { ts: 1 } }),
    ).rejects.toThrow(/No current session/);
  });

  it('list() returns sessions sorted by mtime desc, with current flag', async () => {
    // Force distinct mtimes by sleeping between writes.
    const a = await store.start('alpha');
    await new Promise((r) => setTimeout(r, 20));
    await store.append({ role: 'user', content: 'a-1', meta: { ts: 1 } });
    await new Promise((r) => setTimeout(r, 20));
    const b = await store.start('beta');
    await new Promise((r) => setTimeout(r, 20));
    await store.append({ role: 'user', content: 'b-1', meta: { ts: 1 } });
    await store.append({ role: 'assistant', content: 'b-2', meta: { ts: 2 } });

    // 'beta' is the most recent + the current session.
    const list = await store.list();
    expect(list.map((s) => s.id)).toEqual([b, a]);
    const beta = list.find((s) => s.id === b)!;
    expect(beta.current).toBe(true);
    expect(beta.turns).toBe(2);
    const alpha = list.find((s) => s.id === a)!;
    expect(alpha.current).toBeUndefined();
    expect(alpha.turns).toBe(1);
  });

  it('list() returns [] when the root directory does not exist', async () => {
    const fresh = new SessionStore({
      root: join(tmp, 'never-created'),
      currentIdPath: join(tmp, 'never-created', 'current-session-id'),
    });
    expect(await fresh.list()).toEqual([]);
  });

  it('setCurrent() switches the active session without writing a new log', async () => {
    await store.start('a');
    await store.append({ role: 'user', content: 'a', meta: { ts: 1 } });
    await store.start('b');
    await store.append({ role: 'user', content: 'b', meta: { ts: 1 } });

    // Switch back to a. The 'a' log should still have its 1 turn.
    await store.setCurrent('a');
    expect(await store.currentId()).toBe('a');
    const turns = await store.current();
    expect(turns).toEqual([
      { schemaVersion: 2, role: 'user', content: 'a', meta: { ts: 1 }, ts: turns[0]!.ts, id: '1' },
    ]);
  });

  it('clear() removes the current pointer but leaves logs intact', async () => {
    await store.start('keep-me');
    await store.append({ role: 'user', content: 'x', meta: { ts: 1 } });
    await store.clear();
    expect(await store.currentId()).toBeNull();
    // The log file should still be there and loadable.
    const loaded = await store.load('keep-me');
    expect(loaded).toEqual([
      { schemaVersion: 2, role: 'user', content: 'x', meta: { ts: 1 }, ts: loaded[0]!.ts, id: '1' },
    ]);
    // And it should still appear in list().
    const list = await store.list();
    expect(list.map((s) => s.id)).toEqual(['keep-me']);
    expect(list[0]?.current).toBeUndefined();
  });

  it('load() returns [] for a missing session id (does not throw)', async () => {
    expect(await store.load('nope')).toEqual([]);
  });

  it('load() hydrates ts from meta.ts when present', async () => {
    const id = await store.start('meta-ts');
    await store.append({ role: 'user', content: 'hi', meta: { ts: 12345 } });
    const turns = await store.load(id);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.ts).toBe(12345);
    expect(turns[0]?.id).toBe('1');
  });

  it('load() hydrates ts from a top-level ts field when meta.ts is absent', async () => {
    // Some writers (the agent loop) put `ts` at the top level because
    // ChatMessage has a top-level optional `ts`. The store accepts that.
    const id = await store.start('top-ts');
    await store.append({ role: 'user', content: 'hi', ts: 99999 });
    const turns = await store.load(id);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.ts).toBe(99999);
  });

  it('currentId() returns null for a missing pointer file', async () => {
    expect(await store.currentId()).toBeNull();
  });

  it('currentId() returns null for a blank pointer file', async () => {
    writeFileSync(join(tmp, 'current-session-id'), '   \n');
    expect(await store.currentId()).toBeNull();
  });

  it('ensure() is idempotent and creates nested directories', async () => {
    const deep = new SessionStore({
      root: join(tmp, 'a', 'b', 'c'),
      currentIdPath: join(tmp, 'a', 'b', 'c', 'current-session-id'),
    });
    await deep.ensure();
    await deep.ensure(); // call twice
    const id = await deep.start('nested');
    expect(id).toBe('nested');
  });
});
