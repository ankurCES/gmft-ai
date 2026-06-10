import type { ConfigField, OnboardRuntime } from '../config/registry.js';
import type { GmftConfig } from '../config/config.js';

export interface RunOnboardingOpts {
  fields: readonly ConfigField[];
  /**
   * Factory for the runtime each field receives. Called once per
   * field — for v1.5b the runtime carries no per-call state, so
   * callers can return the same object from the factory.
   */
  runtimeFactory: () => OnboardRuntime;
  /** Called once with the merged config at the end. */
  save: (cfg: GmftConfig) => Promise<void>;
  /** Re-prompt fields whose `isConfigured()` is true. Default: false. */
  force?: boolean;
}

/**
 * Walks the provided fields, prompts each one, merges the returned
 * partial configs, and calls `save` with the final merged config.
 *
 * Returns the merged config on success, or `null` if any field's
 * prompt returned `null` (user aborted). On abort, `save` is NOT
 * called.
 *
 * If `force: true`, all fields are prompted regardless of
 * `isConfigured()`. This is the `--reconfigure` flag in the CLI.
 */
export async function runOnboarding(opts: RunOnboardingOpts): Promise<GmftConfig | null> {
  const merged: Record<string, unknown> = {};
  const force = opts.force ?? false;
  for (const field of opts.fields) {
    if (!force && field.isConfigured(merged as GmftConfig)) {
      continue;
    }
    const partial = await field.prompt(opts.runtimeFactory());
    if (partial === null) {
      return null; // user aborted
    }
    Object.assign(merged, partial);
  }
  const cfg = merged as GmftConfig;
  await opts.save(cfg);
  return cfg;
}
