/**
 * Tab-completion for slash commands.
 *
 * Pure, no React, no Ink. Given the user's current input and a list
 * of available commands, returns either:
 *   - `null` when the input is not a slash command (no completion
 *     applies; the caller should leave the value alone)
 *   - the same string (no change) when there's no unique completion
 *   - the completed string when exactly one command matches the
 *     current prefix
 *   - the longest common prefix of all matches when the prefix is
 *     shared by 2+ commands (e.g. typing `/se` and matching both
 *     `/session` and `/sessionlist` would complete to `/session`).
 *
 * The function is intentionally narrow: it completes the *command*
 * (the first whitespace-delimited token), not the args. Arg
 * completion for `/run` would need per-tool CLI help parsing; that's
 * a future ergonomic, not a T19 deliverable.
 *
 * The list of commands is passed in by the caller so the completion
 * stays in sync with what `dispatchSlash` actually understands. The
 * caller (InputBox) reads `SLASH_COMMANDS` from this module.
 */

export interface TabCompletionResult {
  /**
   * The new value to put in the input box. If `null`, the caller
   * should leave the value unchanged (the input isn't a slash
   * command or there's nothing to complete).
   *
   * If a non-null `value` is returned, `matched` is the count of
   * commands that matched the original prefix (1 means full
   * completion; 2+ means LCP completion).
   */
  value: string | null;
  matched: number;
  /**
   * The trimmed command prefix that was actually completed. Useful
   * for tests and for the bell in the future (when the user hits
   * Tab and the prefix doesn't change, ring the bell).
   */
  matchedPrefix: string;
}

/**
 * Static list of slash commands the TUI knows about. Add new
 * commands here AND in `commands.ts`'s `dispatchSlash` so the two
 * stay in sync. The completion layer doesn't introspect the
 * dispatcher (it can't, the dispatcher is async and side-effectful).
 */
export const SLASH_COMMANDS: readonly string[] = Object.freeze([
  '/help',
  '/clear',
  '/model',
  '/provider',
  '/session',
  '/resume',
  '/report',
  '/supervisor',
  '/tools',
  '/run',
  '/audit',
  '/exit',
]);

/**
 * Compute the longest common prefix of a list of strings. Empty
 * input -> ''. The empty string is never a meaningful LCP for slash
 * commands (every command starts with '/'), so a '' result means
 * "no shared prefix beyond nothing" — the caller should treat it
 * as no completion.
 */
export function longestCommonPrefix(strings: readonly string[]): string {
  if (strings.length === 0) return '';
  if (strings.length === 1) return strings[0] ?? '';
  const first = strings[0] ?? '';
  let prefix = first;
  for (let i = 1; i < strings.length; i++) {
    const next = strings[i] ?? '';
    let j = 0;
    while (j < prefix.length && j < next.length && prefix[j] === next[j]) {
      j++;
    }
    prefix = prefix.slice(0, j);
    if (prefix === '') return '';
  }
  return prefix;
}

/**
 * Tab-complete the given input value. Pure function — caller
 * supplies the current value, the cursor position (unused today but
 * reserved for future mid-token completion), and the list of
 * known commands. Returns the new value (or the original value if
 * no completion is applicable).
 */
export function completeCommand(
  value: string,
  commands: readonly string[] = SLASH_COMMANDS,
  _cursor?: number,
): TabCompletionResult {
  // Not a slash command? Bail.
  if (!value.startsWith('/')) {
    return { value: null, matched: 0, matchedPrefix: '' };
  }

  // Find the first whitespace — the command token ends there. We
  // don't complete args, so if the cursor is past the first
  // whitespace, the user is editing args and we leave the value
  // alone.
  const firstSpace = value.search(/\s/);
  const commandToken =
    firstSpace === -1 ? value : value.slice(0, firstSpace);

  // Empty prefix after '/': don't try to expand to every command.
  if (commandToken === '' || commandToken === '/') {
    return { value: null, matched: 0, matchedPrefix: '' };
  }

  // Lowercase compare so /S<tab> behaves the same as /s<tab>.
  const matches = commands.filter((c) =>
    c.toLowerCase().startsWith(commandToken.toLowerCase()),
  );

  if (matches.length === 0) {
    return { value: null, matched: 0, matchedPrefix: commandToken };
  }

  if (matches.length === 1) {
    const only = matches[0]!;
    // Replace only the command token; preserve any args the user
    // has already typed. The 'replacement' includes a trailing
    // space so the cursor lands at the start of the args column.
    const replacement = only + ' ';
    const next =
      firstSpace === -1 ? replacement : replacement + value.slice(firstSpace + 1);
    return { value: next, matched: 1, matchedPrefix: commandToken };
  }

  // 2+ matches: complete to the longest common prefix.
  const lcp = longestCommonPrefix(matches);
  if (lcp.length <= commandToken.length) {
    // No additional characters to add — the user has already typed
    // the longest common prefix. Returning the original value
    // signals "no change" so the caller can ring a bell (future).
    return { value, matched: matches.length, matchedPrefix: commandToken };
  }
  const next = firstSpace === -1 ? lcp : lcp + value.slice(firstSpace);
  return { value: next, matched: matches.length, matchedPrefix: commandToken };
}
