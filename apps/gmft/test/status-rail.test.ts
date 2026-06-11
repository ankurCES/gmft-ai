/**
 * Pure-function tests for the StatusRail sparkline. The
 * `renderSeveritySparkline` export is the testable surface — the
 * `<SeveritySparkline>` JSX wrapper is exercised by the smoke +
 * app-e2e tests through the App path.
 *
 * What we cover:
 *   - empty input → '(none)' placeholder (not empty string; the
 *     StatusRail callers assume a non-empty result)
 *   - single severity → 'sev:█…' with a count of `█`s
 *   - multiple severities → joined with ' ', severity order fixed
 *     (info → critical)
 *   - cap at 8 cells per severity (SPARK_BARS length) — runaway
 *     widths from a tool that emits 50 critical findings are bad UX
 */

import { describe, it, expect } from 'vitest';
import { renderSeveritySparkline } from '../src/ui/components/StatusRail.js';

describe('renderSeveritySparkline', () => {
  it('returns "(none)" when all counts are zero', () => {
    const counts = { info: 0, low: 0, medium: 0, high: 0, critical: 0 };
    expect(renderSeveritySparkline(counts)).toBe('(none)');
  });

  it('renders a single severity with one block per count', () => {
    const counts = { info: 0, low: 0, medium: 0, high: 3, critical: 0 };
    expect(renderSeveritySparkline(counts)).toBe('high:███');
  });

  it('renders multiple severities in fixed order (info → critical)', () => {
    // Intentionally supply in mixed order to assert the renderer
    // normalizes to severity order, not insertion order.
    const counts = { critical: 1, high: 2, medium: 0, low: 3, info: 4 };
    expect(renderSeveritySparkline(counts)).toBe('info:████ low:███ high:██ critical:█');
  });

  it('skips zero-count severities (no "info:" with empty bar)', () => {
    const counts = { info: 0, low: 2, medium: 0, high: 0, critical: 0 };
    expect(renderSeveritySparkline(counts)).toBe('low:██');
  });

  it('caps per-severity bar length at 8 cells regardless of count', () => {
    // The bar is the at-a-glance signal; the raw count lives in
    // status.findings. A single severity with 50 critical findings
    // must not produce 50 cells of bar — that breaks the line width
    // for every other severity and turns the status into a wall.
    const counts = { info: 0, low: 0, medium: 0, high: 0, critical: 50 };
    const out = renderSeveritySparkline(counts);
    expect(out).toBe('critical:████████'); // 8, not 50
  });

  it('renders count=1 as exactly one block', () => {
    const counts = { info: 0, low: 1, medium: 0, high: 0, critical: 0 };
    expect(renderSeveritySparkline(counts)).toBe('low:█');
  });

  it('renders count=8 as exactly eight blocks (the cap)', () => {
    const counts = { info: 0, low: 0, medium: 8, high: 0, critical: 0 };
    expect(renderSeveritySparkline(counts)).toBe('medium:████████');
  });

  it('handles a missing severity key as zero (defensive against partial updates)', () => {
    // The StatusInfo shape requires all 5 keys, but the renderer
    // should still be safe if a caller constructs an object with
    // fewer keys (e.g. a test fixture that hasn't initialized the
    // tally). `?? 0` in the loop handles this; we just assert it
    // doesn't crash.
    const partial = {} as Record<'info' | 'low' | 'medium' | 'high' | 'critical', number>;
    expect(renderSeveritySparkline(partial)).toBe('(none)');
  });
});
