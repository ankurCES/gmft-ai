import { appendFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { redactSecrets } from '../session/log.js';
import { FindingSchema, type Finding } from './index.js';

export interface FindingsStoreOpts {
  sessionId: string;
  baseDir: string;
}

export class FindingsStore {
  private readonly path: string;
  private cache: Finding[] | null = null;

  constructor(private readonly opts: FindingsStoreOpts) {
    this.path = join(opts.baseDir, `${opts.sessionId}.jsonl`);
  }

  /**
   * Append a finding. Validates against the Zod schema, redacts
   * secret-shaped strings from `evidence` + `description`, writes
   * one JSON object per line, trailing newline (the read_line rule
   * from the session log work).
   */
  async append(finding: Finding): Promise<void> {
    const parsed = FindingSchema.parse(finding);
    const line = JSON.stringify(parsed) + '\n';
    const safe = redactSecrets(line);
    if (!existsSync(this.opts.baseDir)) {
      await mkdir(this.opts.baseDir, { recursive: true });
    }
    await appendFile(this.path, safe, 'utf8');
    this.cache = null;
  }

  /**
   * Read all findings for this session. Returns `[]` if the file
   * doesn't exist. Results are parsed through `FindingSchema.parse`
   * so malformed lines throw clearly.
   *
   * Synchronous because the in-memory cache is synchronous. For
   * larger logs this would move to async; v0.1 findings count is
   * <100 per session.
   */
  list(): Finding[] {
    if (this.cache) return this.cache;
    if (!existsSync(this.path)) {
      this.cache = [];
      return this.cache;
    }
    const text = readFileSync(this.path, 'utf8');
    const out: Finding[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      out.push(FindingSchema.parse(JSON.parse(line)));
    }
    this.cache = out;
    return out;
  }
}
