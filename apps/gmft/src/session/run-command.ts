/**
 * Parser for the `/run <tool> [args...]` slash command.
 *
 * Pure, no I/O. Splits a slash-command line into a tool name and an
 * arg list, preserving quoted strings. The tool name is the first
 * whitespace-delimited token after `/run`; the remainder is
 * tokenized with a small shell-like lexer (double-quoted and
 * single-quoted spans are preserved verbatim, backslash escapes
 * are honored inside double-quoted spans).
 *
 * Examples:
 *   "/run"                       -> { ok: false, code: 'missing-tool' }
 *   "/run "                      -> { ok: false, code: 'missing-tool' }
 *   "/run masscan"               -> { ok: true, tool: 'masscan', args: [] }
 *   "/run masscan 10.0.0.0/24"   -> { ok: true, tool: 'masscan', args: ['10.0.0.0/24'] }
 *   '/run httpx -title "x y"'    -> { ok: true, tool: 'httpx', args: ['-title', 'x y'] }
 *   "/run foo"                   -> { ok: false, code: 'unknown-tool', tool: 'foo' }
 *
 * The parser returns a discriminated union so the slash dispatcher
 * can format a specific error message for each failure mode.
 */

export type ParseRunResult =
  | { ok: true; tool: string; args: readonly string[] }
  | { ok: false; code: 'missing-tool' }
  | { ok: false; code: 'unknown-tool'; tool: string };

/**
 * Tokenize a free-form arg string. Supports:
 *   - whitespace splitting
 *   - "double-quoted" spans (backslash escapes honored)
 *   - 'single-quoted' spans (verbatim, no escapes)
 *   - backslash escapes outside of quotes (\\, \space, \", \')
 *   - empty input -> []
 *
 * Not a full POSIX shell parser (no $VAR, no globs, no `cmd`,
 * no &&) — just enough to round-trip the way operators naturally
 * type a tool invocation. Unterminated quotes are surfaced as an
 * empty trailing token (the chokepoint + tool will reject the
 * resulting command downstream; the parser stays liberal).
 */
export function tokenizeArgs(input: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inSingle = false;
  let inDouble = false;
  let hasContent = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      } else {
        cur += ch;
      }
      continue;
    }
    if (inDouble) {
      if (ch === '\\' && i + 1 < input.length) {
        const next = input[i + 1]!;
        // Only honor escapes for the chars a shell would
        if (next === '"' || next === '\\' || next === '$' || next === '`') {
          cur += next;
          i++;
          continue;
        }
        cur += ch;
        continue;
      }
      if (ch === '"') {
        inDouble = false;
        continue;
      }
      cur += ch;
      continue;
    }
    // Outside quotes
    if (ch === "'") {
      inSingle = true;
      hasContent = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      hasContent = true;
      continue;
    }
    if (ch === '\\' && i + 1 < input.length) {
      cur += input[i + 1]!;
      i++;
      hasContent = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (hasContent) {
        out.push(cur);
        cur = '';
        hasContent = false;
      }
      continue;
    }
    cur += ch;
    hasContent = true;
  }
  if (hasContent) {
    out.push(cur);
  }
  return out;
}

/**
 * Parse a `/run` command line. Accepts the raw text from the input
 * box; the dispatcher has already lowercased the first token
 * (`cmd`) for matching. We re-tokenize the args so quoted spans
 * are preserved.
 *
 * @param knownTools function that returns true for a known tool
 *   name. The dispatcher passes `findTool` from tool-picker.ts.
 */
export function parseRunCommand(
  text: string,
  knownTools: (name: string) => boolean,
): ParseRunResult {
  const trimmed = text.trim();
  if (trimmed === '/run' || trimmed === '') {
    return { ok: false, code: 'missing-tool' };
  }
  // Strip the leading '/run '.
  const after = trimmed.replace(/^\/run\s+/, '');
  const tokens = tokenizeArgs(after);
  const tool = tokens[0];
  if (!tool) {
    return { ok: false, code: 'missing-tool' };
  }
  if (!knownTools(tool)) {
    return { ok: false, code: 'unknown-tool', tool };
  }
  return { ok: true, tool, args: Object.freeze(tokens.slice(1)) };
}
