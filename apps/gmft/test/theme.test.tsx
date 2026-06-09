import { describe, expect, it } from 'vitest';
import { makeTheme } from '../src/ui/theme.js';

describe('theme', () => {
  it('returns a theme with the requested name when explicit', () => {
    const t = makeTheme('high-contrast');
    expect(t.name).toBe('high-contrast');
    const l = makeTheme('light');
    expect(l.name).toBe('light');
  });

  it('falls back to auto-detection when name is "auto"', () => {
    const t = makeTheme('auto');
    expect(['auto', 'dark', 'light', 'high-contrast']).toContain(t.name);
  });

  it('exposes all expected style slots', () => {
    const t = makeTheme('dark');
    for (const slot of ['user', 'assistant', 'tool', 'ok', 'warn', 'error', 'muted', 'accent', 'banner']) {
      expect((t as unknown as Record<string, unknown>)[slot]).toBeTypeOf('function');
    }
  });
});
