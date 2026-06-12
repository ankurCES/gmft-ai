/**
 * v0.2.D — capabilities snapshot live-probe test.
 *
 * The `runnerCapabilities()` snapshot is the single source of truth
 * for what the chokepoint, TUI, and audit log all read from. It must
 * be (1) shape-stable across platforms and (2) cached so we don't
 * re-probe on every call.
 *
 * What we cover:
 *   - shape: all 4 required fields are present and have the right
 *     domain (string level, numeric ABI, string mode)
 *   - cache: a second call returns the same object reference
 *
 * Note: we do NOT assert specific values like `landlock: 'available'`
 * because that depends on the kernel — a macOS dev box would fail
 * that test. The shape is stable; the values are platform-specific.
 */

import { describe, it, expect } from 'vitest';
import { runnerCapabilities } from '@gmft/tools';

describe('runnerCapabilities snapshot (v0.2.D)', () => {
  it('returns a snapshot with the expected shape (domain check, not value)', () => {
    const caps = runnerCapabilities();
    expect(caps.landlock).toMatch(/^(available|unavailable|denied)$/);
    // landlockAbi is a number when landlock is available, null otherwise.
    // We don't pin the value — kernels report different ABI versions.
    expect(caps.landlockAbi === null || typeof caps.landlockAbi === 'number').toBe(true);
    expect(caps.seccomp).toMatch(/^(available|unavailable)$/);
    expect(caps.docker).toMatch(/^(available|unavailable)$/);
    // resolvedAuto is the auto-resolved mode (NOT a 'unsandboxed' value —
    // that one is only set by the chokepoint when it denies a call).
    expect(caps.resolvedAuto).toMatch(/^(docker|host\+landlock|host)$/);
  });

  it('returns the same object on repeat calls (cache works)', () => {
    // The probe is intentionally cached at module-load: capabilities
    // are stable for the life of the process, and the chokepoint +
    // TUI + audit log all read from the same snapshot. Re-probing
    // on every call would mean 3+ `which docker` spawnSync calls per
    // turn.
    const a = runnerCapabilities();
    const b = runnerCapabilities();
    expect(a).toBe(b);
  });
});
