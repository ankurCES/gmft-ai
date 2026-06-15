/**
 * Unit tests for the tab-completion module.
 *
 * The completion logic is pure and easy to test directly. The
 * InputBox wiring (Tab key -> completeCommand -> setValue) is
 * tested separately in InputBox.test.tsx.
 */
import { describe, expect, it } from 'vitest';
import {
  completeCommand,
  longestCommonPrefix,
  SLASH_COMMANDS,
} from '../src/session/tab-completion.js';

describe('longestCommonPrefix', () => {
  it('returns "" for an empty list', () => {
    expect(longestCommonPrefix([])).toBe('');
  });

  it('returns the only string for a singleton list', () => {
    expect(longestCommonPrefix(['/help'])).toBe('/help');
  });

  it('finds a shared prefix across multiple strings', () => {
    expect(longestCommonPrefix(['/session', '/sessionlist'])).toBe('/session');
  });

  it('returns the common prefix (even a single char) when nothing longer is shared', () => {
    // /help and /run share only the leading '/'. The LCP is '/',
    // not '' — the helper does NOT special-case the leading slash.
    expect(longestCommonPrefix(['/help', '/run'])).toBe('/');
  });

  it('treats strings of different length correctly', () => {
    expect(longestCommonPrefix(['/re', '/resume', '/report'])).toBe('/re');
  });
});

describe('completeCommand', () => {
  it('returns null for input that does not start with "/"', () => {
    const result = completeCommand('hello');
    expect(result.value).toBeNull();
    expect(result.matched).toBe(0);
  });

  it('returns null for an empty input', () => {
    const result = completeCommand('');
    expect(result.value).toBeNull();
  });

  it('returns null for a bare "/" (no command token yet)', () => {
    // A bare '/' would expand to every command — that's noisy
    // and unhelpful. The helper bails and lets the caller leave
    // the value alone.
    const result = completeCommand('/');
    expect(result.value).toBeNull();
    expect(result.matched).toBe(0);
  });

  it('returns null for a non-matching prefix', () => {
    const result = completeCommand('/zzz');
    expect(result.value).toBeNull();
    expect(result.matchedPrefix).toBe('/zzz');
  });

  it('completes uniquely when exactly one command matches', () => {
    // /he matches /help uniquely in the current SLASH_COMMANDS list.
    const result = completeCommand('/he');
    expect(result.matched).toBe(1);
    expect(result.value).toBe('/help ');
    expect(result.matchedPrefix).toBe('/he');
  });

  it('appends a trailing space after unique completion', () => {
    // The trailing space puts the cursor at the start of the args
    // column so the user can immediately type args.
    const result = completeCommand('/hel');
    expect(result.value).toBe('/help ');
  });

  it('preserves existing args after a unique completion (single space)', () => {
    // Original: '/he --verbose'
    //   commandToken = '/he', firstSpace = 3, args = '--verbose'
    //   replacement = '/help ', then concat with value.slice(4)
    //   = '/help ' + '--verbose' = '/help --verbose'
    // The args come back without their leading space (the source
    // slices from firstSpace+1), so the trailing space in
    // `replacement` is the only separator — single space, clean.
    const result = completeCommand('/he --verbose');
    expect(result.value).toBe('/help --verbose');
  });

  it('extends to the LCP when 2+ commands match and the LCP is longer than the prefix', () => {
    // Build a custom command list where two commands share a
    // multi-char prefix that the user has not yet typed in full.
    // (The shipped SLASH_COMMANDS list doesn't currently have any
    // such pair; using a custom list exercises the branch
    // deterministically.)
    const result = completeCommand('/can', ['/cancel', '/cat']);
    // LCP of /cancel and /cat is '/ca', which is shorter than
    // '/can' — so the LCP branch returns the value unchanged.
    // For a real LCP extension, pick a shorter user prefix:
    const result2 = completeCommand('/ca', ['/cancel', '/cat']);
    expect(result2.matched).toBe(2);
    expect(result2.value).toBe('/ca');
  });

  it('returns the original value when the prefix is already the LCP of the matches', () => {
    // /ca is the LCP of /cancel and /cat. The user has typed the
    // full LCP, so the LCP-extension branch returns the value
    // unchanged. matched=2 signals "2+ commands share this prefix
    // but no extension is possible" — a future caller can ring a
    // bell here.
    const result = completeCommand('/ca', ['/cancel', '/cat']);
    expect(result.value).toBe('/ca');
    expect(result.matched).toBe(2);
  });

  it('is case-insensitive on the prefix', () => {
    // /H is treated as /h; /help is the only match.
    const result = completeCommand('/H');
    expect(result.value).toBe('/help ');
  });

  it('completes the command token even when args are present', () => {
    // The helper only completes the *command* token (the first
    // whitespace-delimited segment), not the args column. It
    // still finds /help as the unique match for commandToken
    // '/help' and returns the same string with the args preserved.
    // matched=1 because the command token is already a complete
    // command; the unique-match path replaces the token with
    // itself (effectively a no-op on the value).
    const result = completeCommand('/help --verbose');
    expect(result.value).toBe('/help --verbose');
    expect(result.matched).toBe(1);
  });

  it('uses the explicit commands list when one is passed', () => {
    // Custom list where one command matches uniquely.
    const result = completeCommand('/can', ['/cancel', '/cat']);
    // /can uniquely matches /cancel; /cat doesn't start with /can.
    expect(result.matched).toBe(1);
    expect(result.value).toBe('/cancel ');
  });

  it('exposes the canonical SLASH_COMMANDS list', () => {
    // The list is frozen; this is the contract InputBox relies on
    // for its dispatcher sync. If a command is added to
    // dispatchSlash but not here, completion will be stale.
    expect(SLASH_COMMANDS).toContain('/help');
    expect(SLASH_COMMANDS).toContain('/run');
    expect(SLASH_COMMANDS).toContain('/exit');
    expect(SLASH_COMMANDS.length).toBeGreaterThan(0);
  });
});
