/**
 * v0.3.A.3 — tests for the `--supervisor-model` CLI flag.
 *
 * The flag is parsed by meow in `cli.tsx`. We don't boot the full Ink
 * runtime in this test; instead we (a) parse the flag with the same
 * meow config the CLI uses (via `input:`) and (b) assert the help
 * text in `cli.tsx` documents the new flag (regression guard for
 * help-text drift).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import meow from 'meow';

describe('--supervisor-model CLI flag', () => {
  it('parses a model id from --supervisor-model <id>', () => {
    // Match the cli.tsx call shape exactly (importMeta + no explicit
    // `input`): in the real CLI, meow reads argv from process.argv.
    // Here we monkey-patch process.argv for the duration of the call
    // to simulate passing --supervisor-model.
    const originalArgv = process.argv;
    process.argv = [originalArgv[0]!, originalArgv[1]!, '--supervisor-model', 'claude-haiku-4-5'];
    try {
      const cli = meow(
        `
          Usage
            $ gmft [options]

          Options
            --supervisor-model <id>  Model id for the supervisor's postmortem
        `,
        {
          importMeta: import.meta,
          flags: {
            supervisorModel: { type: 'string' },
          },
        },
      );
      expect(cli.flags.supervisorModel).toBe('claude-haiku-4-5');
    } finally {
      process.argv = originalArgv;
    }
  });

  it('omits the flag when --supervisor-model is not passed', () => {
    // The `omits` test mirrors the cli.tsx call without mutating
    // process.argv — vitest's own argv shouldn't contain our flag.
    const cli = meow(
      `
          Usage
            $ gmft [options]
        `,
      {
        importMeta: import.meta,
        flags: {
          supervisorModel: { type: 'string' },
        },
      },
    );
    expect(cli.flags.supervisorModel).toBeUndefined();
  });

  it('help text in cli.tsx documents --supervisor-model', () => {
    // Regression guard: if someone refactors cli.tsx and drops the
    // help line, this fails. Read the file as a string and check the
    // flag appears in the usage block.
    const here = fileURLToPath(import.meta.url);
    const cliPath = path.join(path.dirname(here), '..', 'src', 'cli.tsx');
    const cliSrc = readFileSync(cliPath, 'utf8');
    expect(cliSrc).toMatch(/--supervisor-model\s+<id>/);
    // And the meow flag declaration must exist.
    expect(cliSrc).toMatch(/supervisorModel:\s*\{\s*type:\s*'string'\s*\}/);
  });
});
