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
  async current(): Promise<Turn[]> {
    const id = await this.currentId();
    if (!id) return [];
    return this.load(id);
  }

  /** Read a specific session's turns. Empty array if the log is missing. */
  async load(id: string): Promise<Turn[]> {
    return readLog(this.pathFor(id));
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
