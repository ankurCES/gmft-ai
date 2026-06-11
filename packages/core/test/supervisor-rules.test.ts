import { describe, it, expect } from 'vitest';
import { observeRuleA, RULE_A_THRESHOLD, RULE_A_WINDOW } from '../src/agent/supervisor-rules.js';
import { createInitialState } from '../src/agent/supervisor-types.js';
import type { AgentEvent } from '../src/agent/loop.js';

const toolCall = (id: string, name: string, args: Record<string, unknown>): AgentEvent => ({
  type: 'tool-call-request',
  id,
  name,
  args,
});

describe('observeRuleA — stuck/loop detection', () => {
  it('exports RULE_A_THRESHOLD = 4 and RULE_A_WINDOW = 8', () => {
    expect(RULE_A_THRESHOLD).toBe(4);
    expect(RULE_A_WINDOW).toBe(8);
  });

  it('does not fire below threshold (3 identical calls)', () => {
    let state = createInitialState();
    const events = [
      toolCall('1', 'nmap_scan', { target: 'host', ports: '80' }),
      toolCall('2', 'nmap_scan', { target: 'host', ports: '80' }),
      toolCall('3', 'nmap_scan', { target: 'host', ports: '80' }),
    ];
    for (const e of events) {
      const r = observeRuleA(state, e);
      state = r.state;
      expect(r.fire).toBeUndefined();
    }
  });

  it('fires on the 4th identical call within the last 8', () => {
    let state = createInitialState();
    for (let i = 1; i <= 4; i++) {
      const r = observeRuleA(state, toolCall(String(i), 'nmap_scan', { target: 'host', ports: '80' }));
      state = r.state;
      if (i < 4) {
        expect(r.fire).toBeUndefined();
      } else {
        expect(r.fire?.kind).toBe('loop-detected');
        expect(r.fire?.tool).toBe('nmap_scan');
        expect(r.fire?.count).toBe(4);
      }
    }
  });

  it('fires on the 4th identical call even with an unrelated tool mixed in', () => {
    // Count-based: 4 nmap_scan + 1 whois in the 5-event window = 4 identical
    // matches, which meets the threshold even though they're not consecutive.
    // The "unrelated tool" only resets a *consecutive* run; the supervisor
    // operates on the full count of identical calls in the window.
    let state = createInitialState();
    const sequence = [
      toolCall('1', 'nmap_scan', { target: 'h', ports: '80' }),
      toolCall('2', 'nmap_scan', { target: 'h', ports: '80' }),
      toolCall('3', 'nmap_scan', { target: 'h', ports: '80' }),
      toolCall('4', 'whois', { target: 'h' }),
      toolCall('5', 'nmap_scan', { target: 'h', ports: '80' }),
    ];
    let lastFire;
    for (const e of sequence) {
      const r = observeRuleA(state, e);
      state = r.state;
      if (r.fire) lastFire = r.fire;
    }
    expect(lastFire).toBeDefined();
    expect(lastFire?.kind).toBe('loop-detected');
    expect(lastFire?.tool).toBe('nmap_scan');
    expect(lastFire?.count).toBe(4);
    expect(lastFire?.targetEventId).toBe('5');
  });

  it('fires on the 5th identical call when 4 unrelated calls are in the window', () => {
    // Window is 8 events. Sequence of 9 events ends with the window
    // containing events 2-9. Of those, 4 are nmap_scan identical
    // (events 3, 5, 7, 9). Threshold is 4, so event 9 fires.
    let state = createInitialState();
    const sequence = [
      toolCall('1', 'nmap_scan', { target: 'h', ports: '80' }),
      toolCall('2', 'whois', { target: 'h' }),
      toolCall('3', 'nmap_scan', { target: 'h', ports: '80' }),
      toolCall('4', 'dig', { target: 'h' }),
      toolCall('5', 'nmap_scan', { target: 'h', ports: '80' }),
      toolCall('6', 'http_get', { url: 'http://h' }),
      toolCall('7', 'nmap_scan', { target: 'h', ports: '80' }),
      toolCall('8', 'whois', { target: 'h' }),
      toolCall('9', 'nmap_scan', { target: 'h', ports: '80' }),
    ];
    let lastFire;
    for (const e of sequence) {
      const r = observeRuleA(state, e);
      state = r.state;
      if (r.fire) lastFire = r.fire;
    }
    expect(lastFire).toBeDefined();
    expect(lastFire?.kind).toBe('loop-detected');
    expect(lastFire?.count).toBeGreaterThanOrEqual(RULE_A_THRESHOLD);
  });

  it('alt-suggestion is "nmap_*" specific when tool family is nmap', () => {
    let state = createInitialState();
    for (let i = 1; i <= 4; i++) {
      const r = observeRuleA(state, toolCall(String(i), 'nmap_scan', { target: 'h' }));
      state = r.state;
      if (r.fire) {
        expect(r.fire.advice).toMatch(/scan fewer ports|service detection|different host/);
        expect(r.fire.advice).toContain('Supervisor:');
      }
    }
  });
});
