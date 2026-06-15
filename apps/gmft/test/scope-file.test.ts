/**
 * Tests for `loadScopeFile` — the v0.3.B `--scope <path>` loader.
 *
 * Pattern: each test writes a fixture to a `mkdtempSync`-backed
 * scratch dir, then injects a minimal FS shim into `loadScopeFile`
 * so we never touch the real filesystem. The shim is a thin
 * `Proxy` over the real `node:fs` that restricts reads to the
 * scratch dir; this is friendlier to CI sandboxes than mocking
 * `fs` globally.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadScopeFile,
  ScopeFileError,
  type ScopeFileErrorCode,
} from '../src/scope-file.js';

function withScratchDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'gmft-scope-test-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A minimal FS shim bound to a single scratch dir. Forwards all
 * calls to the real `node:fs` (so we get correct error semantics
 * for free) but doesn't inject any state — `loadScopeFile` is
 * responsible for resolving the path against `cwd`. Tests pass
 * the scratch dir as `cwd` so the resolutions line up.
 */
function scratchFs(): {
  existsSync: typeof existsSync;
  statSync: typeof statSync;
  readFileSync: typeof readFileSync;
} {
  return { existsSync, statSync, readFileSync };
}

function expectCode(err: unknown, code: ScopeFileErrorCode): void {
  expect(err).toBeInstanceOf(ScopeFileError);
  if (err instanceof ScopeFileError) {
    expect(err.code).toBe(code);
  }
}

describe('loadScopeFile — happy path', () => {
  it('returns a frozen, deduplicated allow list for a valid file', () => {
    withScratchDir((dir) => {
      const p = join(dir, 'scope.json');
      writeFileSync(p, JSON.stringify({ allow: ['scanme.nmap.org', '10.0.0.5', 'scanme.nmap.org'] }));
      const result = loadScopeFile(p, { fs: scratchFs(), cwd: dir });
      expect(result.allow).toEqual(['scanme.nmap.org', '10.0.0.5']);
      expect(Object.isFrozen(result.allow)).toBe(true);
      expect(result.source).toBe(p);
    });
  });

  it('preserves the operator-authored order on deduplication', () => {
    withScratchDir((dir) => {
      const p = join(dir, 'scope.json');
      writeFileSync(p, JSON.stringify({ allow: ['b.example.com', 'a.example.com', 'b.example.com', 'c.example.com'] }));
      const result = loadScopeFile(p, { fs: scratchFs(), cwd: dir });
      // First-seen wins: b stays first even though 'a' sorts before it.
      expect(result.allow).toEqual(['b.example.com', 'a.example.com', 'c.example.com']);
    });
  });

  it('accepts a single-entry allowlist', () => {
    withScratchDir((dir) => {
      const p = join(dir, 'scope.json');
      writeFileSync(p, JSON.stringify({ allow: ['scanme.nmap.org'] }));
      const result = loadScopeFile(p, { fs: scratchFs(), cwd: dir });
      expect(result.allow).toEqual(['scanme.nmap.org']);
    });
  });

  it('accepts the full character class (letters, digits, ., _, -)', () => {
    withScratchDir((dir) => {
      const p = join(dir, 'scope.json');
      writeFileSync(
        p,
        JSON.stringify({ allow: ['abc-123_x.y', 'A', '0', '9', 'z-_-_'] }),
      );
      const result = loadScopeFile(p, { fs: scratchFs(), cwd: dir });
      expect(result.allow.length).toBe(5);
    });
  });

  it('tolerates a JSON file with extra top-level keys (forward-compat)', () => {
    withScratchDir((dir) => {
      const p = join(dir, 'scope.json');
      // Future versions may add `deny`, `notes`, etc. Today we just
      // accept anything as long as `allow` is well-formed.
      writeFileSync(p, JSON.stringify({ allow: ['scanme.nmap.org'], notes: 'prod scope' }));
      const result = loadScopeFile(p, { fs: scratchFs(), cwd: dir });
      expect(result.allow).toEqual(['scanme.nmap.org']);
    });
  });

  it('resolves a relative path against the supplied cwd', () => {
    withScratchDir((dir) => {
      const p = join(dir, 'scope.json');
      writeFileSync(p, JSON.stringify({ allow: ['scanme.nmap.org'] }));
      // Pass a relative name; the loader should resolve against `cwd`.
      const result = loadScopeFile('scope.json', { fs: scratchFs(), cwd: dir });
      expect(result.allow).toEqual(['scanme.nmap.org']);
      expect(result.source).toBe(p);
    });
  });
});

describe('loadScopeFile — error paths', () => {
  it('throws EMPTYPATH for an empty string', () => {
    expect(() => loadScopeFile('')).toThrow(ScopeFileError);
    try {
      loadScopeFile('');
    } catch (err) {
      expectCode(err, 'EMPTYPATH');
    }
  });

  it('throws ENOENT for a missing file', () => {
    withScratchDir((dir) => {
      const missing = join(dir, 'nope.json');
      try {
        loadScopeFile(missing, { fs: scratchFs(), cwd: dir });
        expect.fail('expected throw');
      } catch (err) {
        expectCode(err, 'ENOENT');
        if (err instanceof ScopeFileError) {
          expect(err.path).toBe(missing);
          expect(err.message).toContain('scope file not found');
        }
      }
    });
  });

  it('throws EISDIR when the path is a directory', () => {
    withScratchDir((dir) => {
      const sub = join(dir, 'subdir');
      mkdirSync(sub);
      try {
        loadScopeFile(sub, { fs: scratchFs(), cwd: dir });
        expect.fail('expected throw');
      } catch (err) {
        expectCode(err, 'EISDIR');
      }
    });
  });

  it('throws PARSE for malformed JSON', () => {
    withScratchDir((dir) => {
      const p = join(dir, 'scope.json');
      writeFileSync(p, '{ this is not json');
      try {
        loadScopeFile(p, { fs: scratchFs(), cwd: dir });
        expect.fail('expected throw');
      } catch (err) {
        expectCode(err, 'PARSE');
        if (err instanceof ScopeFileError) {
          expect(err.message).toContain('not valid JSON');
        }
      }
    });
  });

  it('throws SHAPE when root is an array', () => {
    withScratchDir((dir) => {
      const p = join(dir, 'scope.json');
      writeFileSync(p, '[]');
      try {
        loadScopeFile(p, { fs: scratchFs(), cwd: dir });
      } catch (err) {
        expectCode(err, 'SHAPE');
      }
    });
  });

  it('throws SHAPE when root is a scalar', () => {
    withScratchDir((dir) => {
      const p = join(dir, 'scope.json');
      writeFileSync(p, '42');
      try {
        loadScopeFile(p, { fs: scratchFs(), cwd: dir });
      } catch (err) {
        expectCode(err, 'SHAPE');
      }
    });
  });

  it('throws SHAPE when "allow" is missing', () => {
    withScratchDir((dir) => {
      const p = join(dir, 'scope.json');
      writeFileSync(p, '{}');
      try {
        loadScopeFile(p, { fs: scratchFs(), cwd: dir });
      } catch (err) {
        expectCode(err, 'SHAPE');
        if (err instanceof ScopeFileError) {
          expect(err.message).toContain('"allow"');
        }
      }
    });
  });

  it('throws SHAPE when "allow" is not an array', () => {
    withScratchDir((dir) => {
      const p = join(dir, 'scope.json');
      writeFileSync(p, JSON.stringify({ allow: 'scanme.nmap.org' }));
      try {
        loadScopeFile(p, { fs: scratchFs(), cwd: dir });
      } catch (err) {
        expectCode(err, 'SHAPE');
      }
    });
  });

  it('throws ENTRY for an entry with illegal characters (space)', () => {
    withScratchDir((dir) => {
      const p = join(dir, 'scope.json');
      writeFileSync(p, JSON.stringify({ allow: ['bad host.com'] }));
      try {
        loadScopeFile(p, { fs: scratchFs(), cwd: dir });
      } catch (err) {
        expectCode(err, 'ENTRY');
        if (err instanceof ScopeFileError) {
          expect(err.message).toContain('illegal characters');
          expect(err.message).toContain('bad host.com');
        }
      }
    });
  });

  it('throws ENTRY for an empty-string entry', () => {
    withScratchDir((dir) => {
      const p = join(dir, 'scope.json');
      writeFileSync(p, JSON.stringify({ allow: ['scanme.nmap.org', ''] }));
      try {
        loadScopeFile(p, { fs: scratchFs(), cwd: dir });
      } catch (err) {
        expectCode(err, 'ENTRY');
      }
    });
  });

  it('throws ENTRY for a non-string entry (number)', () => {
    withScratchDir((dir) => {
      const p = join(dir, 'scope.json');
      writeFileSync(p, JSON.stringify({ allow: [123] }));
      try {
        loadScopeFile(p, { fs: scratchFs(), cwd: dir });
      } catch (err) {
        expectCode(err, 'ENTRY');
      }
    });
  });

  it('throws ENTRY for an IPv6-style entry (colons are not in the allowed char class)', () => {
    // The chokepoint's TARGET_RE is `[a-zA-Z0-9._-]` (ASCII only).
    // IPv6 has colons which are rejected. This test pins that
    // behavior so a future "be lenient" change has to update the
    // scope loader in lockstep.
    withScratchDir((dir) => {
      const p = join(dir, 'scope.json');
      writeFileSync(p, JSON.stringify({ allow: ['::1'] }));
      try {
        loadScopeFile(p, { fs: scratchFs(), cwd: dir });
      } catch (err) {
        expectCode(err, 'ENTRY');
      }
    });
  });

  it('points the error at the offending index in the allowlist', () => {
    withScratchDir((dir) => {
      const p = join(dir, 'scope.json');
      writeFileSync(p, JSON.stringify({ allow: ['ok.example.com', 'bad host', 'also-ok.example.com'] }));
      try {
        loadScopeFile(p, { fs: scratchFs(), cwd: dir });
      } catch (err) {
        if (!(err instanceof ScopeFileError)) throw err;
        expect(err.code).toBe('ENTRY');
        expect(err.message).toContain('"allow"[1]');
      }
    });
  });
});
