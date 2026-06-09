import chalk, { supportsColor, type ChalkInstance } from 'chalk';

export type ThemeName = 'auto' | 'dark' | 'light' | 'high-contrast';

export interface Theme {
  name: ThemeName;
  user: ChalkInstance;
  assistant: ChalkInstance;
  tool: ChalkInstance;
  ok: ChalkInstance;
  warn: ChalkInstance;
  error: ChalkInstance;
  muted: ChalkInstance;
  accent: ChalkInstance;
  banner: ChalkInstance;
}

function detectBase(): 'dark' | 'light' {
  // supportsColor reflects NO_COLOR / FORCE_COLOR / TTY.
  // We treat the default terminal as 'dark' — pentesters live in dark terminals.
  if (!supportsColor) return 'dark';
  if (process.env.THEME === 'light') return 'light';
  if (process.env.THEME === 'high-contrast') return 'dark';
  return 'dark';
}

export function makeTheme(name: ThemeName = 'auto'): Theme {
  const base = name === 'auto' ? detectBase() : name;
  const highContrast = name === 'high-contrast';
  const inverted = base === 'light';

  if (highContrast) {
    return {
      name: 'high-contrast',
      user: chalk.bold.white,
      assistant: chalk.bold.cyan,
      tool: chalk.bold.yellow,
      ok: chalk.bold.green,
      warn: chalk.bold.yellowBright,
      error: chalk.bold.red,
      muted: chalk.bold.gray,
      accent: chalk.bold.magenta,
      banner: chalk.bgBlack.whiteBright.bold,
    };
  }

  if (inverted) {
    return {
      name: 'light',
      user: chalk.bold.blue,
      assistant: chalk.bold.magenta,
      tool: chalk.bold.yellow,
      ok: chalk.bold.green,
      warn: chalk.bold.yellow,
      error: chalk.bold.red,
      muted: chalk.gray,
      accent: chalk.bold.cyan,
      banner: chalk.bgWhite.black.bold,
    };
  }

  return {
    name: 'dark',
    user: chalk.bold.cyan,
    assistant: chalk.bold.green,
    tool: chalk.bold.yellow,
    ok: chalk.green,
    warn: chalk.yellow,
    error: chalk.red,
    muted: chalk.gray,
    accent: chalk.bold.magenta,
    banner: chalk.bgBlack.whiteBright.bold,
  };
}
