/**
 * SessionStore — JSONL-backed session log + current-session pointer.
 *
 * Owns the fs side effects of session management. The path math lives
 * in `@gmft/core/session/paths.ts`; this class takes a `root` (default
 * `sessionDir()`) so tests can pass a tmp dir.
 *
 * Concurrency: not safe for concurrent processes writing the same id.
 * Within a single process, sequential `append()` calls are safe — each
 * is a single `appendFile` call, and Node's fs queue serializes them
 * per file. The CLI is a single process; this is the v0.1 contract.
 *
 * Schema: each line of `<id>.jsonl` is a `Turn` object (from
 * `@gmft/core/session/log`). The "current" pointer file at
 * `<root>/current-session-id` is plain text — the id, no newline.
 */

import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  currentSessionIdPath as defaultCurrentSessionIdPath,
  sessionDir as defaultSessionDir,
} from '@gmft/core';
import { appendTurn as coreAppendTurn, readLog, type Turn } from '@gmft/core';

export interface SessionInfo {
  /** The session id (filename without `.jsonl`). */
  id: string;
  /** Last-modified time of the JSONL file (ms since epoch). */
  mtimeMs: number;
  /** Number of turns currently in the log. */
  turns: number;
  /** True if this session is the active one (matches the current pointer). */
  current?: boolean;
}

export interface SessionStoreOpts {
  /** Root directory for the sessions tree. Defaults to `sessionDir()`. */
  root?: string;
  /** Override for the current-session-id path (for tests). */
  currentIdPath?: string;
}

export class SessionStore {
  private readonly root: string;
  private readonly currentIdPath: string;

  constructor(opts: SessionStoreOpts = {}) {
    this.root = opts.root ?? defaultSessionDir();
    this.currentIdPath = opts.currentIdPath ?? defaultCurrentSessionIdPath();
  }

  /** Where this store reads/writes. */
  get directory(): string {
    return this.root;
  }

  /** Make the sessions directory. Idempotent. */
  async ensure(): Promise<void> {
    await mkdir(this.root, { recursive: true });
  }

  /**
   * Returns a no-op SessionStore. All reads return empty/null; all
   * writes silently succeed without touching the filesystem. Useful
   * for tests and for mounting the TUI before a session has been
   * resolved (the no-resume path of cli.tsx).
   */
  static noop(): SessionStore {
    return new NoopSessionStore();
  }

  /**
   * Choose a session id. If `id` is provided, return it as-is. Otherwise,
   * generate a slug from the local time + 6 hex chars of randomness.
   * The slug is filesystem-safe (no path separators, no whitespace).
   */
  static generateId(now: Date = new Date()): string {
    const pad = (n: number): string => n.toString().padStart(2, '0');
    const stamp =
      `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
      `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const hex = Math.floor(Math.random() * 0xffffff)
      .toString(16)
      .padStart(6, '0');
    return `${stamp}-${hex}`;
  }

  /**
   * Start a new session: writes the id to the current-session-id file,
   * creates an empty JSONL log file at `<id>.jsonl`, and returns the id.
   * If a session was already current, its log is left untouched (sessions
   * are append-only in v0.1; the old id is reachable via `list()`).
   */
  async start(id: string = SessionStore.generateId()): Promise<string> {
    await this.ensure();
    // Touch the JSONL file so list() shows a 0-turn entry from the start.
    await writeFile(this.pathFor(id), '', 'utf8');
    await writeFile(this.currentIdPath, id, 'utf8');
    return id;
  }

  /**
   * Set the current session id WITHOUT creating a new log file. Used by
   * `/session load <id>` to switch the active session. The id must
   * already have a log file (else the next `append()` will silently
   * create one — that's the v0.1 contract, callers don't check).
   */
  async setCurrent(id: string): Promise<void> {
    await this.ensure();
    await writeFile(this.currentIdPath, id, 'utf8');
  }

  /**
   * Append a turn to the current session's log. Throws if there is no
   * current session — callers should run `start()` first.
   */
  async append(turn: Turn): Promise<void> {
    const id = await this.currentId();
    if (!id) {
      throw new Error('No current session; call start() first.');
    }
    await coreAppendTurn(this.pathFor(id), turn);
  }

  /** Read the current session's turns. Empty array if no current session. */
  async current(): Promise<PreviewTurn[]> {
    const id = await this.currentId();
    if (!id) return [];
    return this.load(id);
  }

  /**
   * Read a specific session's turns. Empty array if the log is missing.
   *
   * Each returned `PreviewTurn` has `ts` (from `meta.ts` if present,
   * else a top-level `ts` field written by the agent loop, else the
   * file's mtime) and `id` (1-based line number) filled in so the UI
   * can render them without re-reading the file.
   */
  async load(id: string): Promise<PreviewTurn[]> {
    const path = this.pathFor(id);
    if (!existsSync(path)) return [];
    const turns = await readLog(path);
    const mtime = (await stat(path)).mtimeMs;
    return turns.map((t, i) => {
      const metaTs = typeof t.meta?.ts === 'number' ? (t.meta.ts as number) : undefined;
      // Some writers (the AgentApp turn loop) put `ts` at the top level
      // because `ChatMessage` has a top-level `ts?`. Accept that too.
      const topTs = typeof (t as unknown as { ts?: unknown }).ts === 'number'
        ? ((t as unknown as { ts: number }).ts)
        : undefined;
      return {
        ...t,
        ts: metaTs ?? topTs ?? mtime,
        id: String(i + 1),
      };
    });
  }

  /**
   * List all sessions. Returns one entry per `<id>.jsonl` file in `root`,
   * sorted by mtime desc. The "current" pointer is included as a flag.
   */
  async list(): Promise<SessionInfo[]> {
    if (!existsSync(this.root)) return [];
    const entries = await readdir(this.root);
    const currentId = await this.currentId();
    const jsonl = entries.filter((e) => e.endsWith('.jsonl'));
    const out: SessionInfo[] = [];
    for (const name of jsonl) {
      const id = name.slice(0, -'.jsonl'.length);
      const fullPath = join(this.root, name);
      const st = await stat(fullPath);
      const turns = await readLog(fullPath);
      const info: SessionInfo = {
        id,
        mtimeMs: st.mtimeMs,
        turns: turns.length,
      };
      if (id === currentId) info.current = true;
      out.push(info);
    }
    out.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return out;
  }

  /** Read the current session id, or null if there is no current session. */
  async currentId(): Promise<string | null> {
    if (!existsSync(this.currentIdPath)) return null;
    const raw = await readFile(this.currentIdPath, 'utf8');
    const trimmed = raw.trim();
    return trimmed === '' ? null : trimmed;
  }

  /**
   * Clear the current-session pointer. The log file is NOT removed —
   * it is reachable via `list()` until manually deleted.
   */
  async clear(): Promise<void> {
    if (existsSync(this.currentIdPath)) {
      await rm(this.currentIdPath);
    }
  }

  /** Path to a specific session's JSONL log (test helper). */
  pathFor(id: string): string {
    return join(this.root, `${id}.jsonl`);
  }
}

// Re-export the `Turn` type for downstream consumers.
export type { Turn };

/**
 * A turn as returned by `load()` / `current()`. Extends `Turn` with two
 * synthetic fields useful for the UI layer (and not stored on disk):
 *
 * - `ts`: timestamp in ms (from `meta.ts` if present, else the file mtime).
 * - `id`: 1-based line number in the JSONL log (stable across reloads).
 *
 * Both are optional because the source-of-truth on disk is `Turn`; these
 * are filled in by the store when reading the log.
 */
export type PreviewTurn = Turn & {
  ts?: number;
  id?: string;
};

/**
 * A SessionStore that touches no filesystem state. Reads return empty
 * values; writes are silent no-ops. Used by AgentApp when the caller
 * didn't supply a session (tests, the no-resume CLI path).
 *
 * Subclasses SessionStore structurally (extends + overrides) so the
 * type remains `SessionStore` — call sites don't need a separate type
 * to handle the no-op case.
 */
export class NoopSessionStore extends SessionStore {
  constructor() {
    // Use a path we know is read-only-on-test-roots. The constructor
    // doesn't touch the fs, so this is safe.
    super({ root: '/tmp/gmft-noop-never-created', currentIdPath: '/tmp/gmft-noop-never-created/current-session-id' });
  }

  override async ensure(): Promise<void> {
    // no-op
  }

  override async start(id: string = SessionStore.generateId()): Promise<string> {
    return id;
  }

  override async setCurrent(id: string): Promise<void> {
    void id;
  }

  override async append(_turn: Turn): Promise<void> {
    void _turn;
  }

  override async current(): Promise<PreviewTurn[]> {
    return [];
  }

  override async load(_id: string): Promise<PreviewTurn[]> {
    return [];
  }

  override async list(): Promise<SessionInfo[]> {
    return [];
  }

  override async currentId(): Promise<string | null> {
    return null;
  }

  override async clear(): Promise<void> {
    // no-op
  }
}
