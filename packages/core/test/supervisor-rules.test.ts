import { describe, it, expect } from 'vitest';
import { observeRuleA, observeRuleB, observeRuleC, RULE_A_THRESHOLD, RULE_A_WINDOW } from '../src/agent/supervisor-rules.js';
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

const textDelta = (text: string): AgentEvent => ({
  type: 'text-delta',
  text,
});

const toolResult = (id: string, output: unknown): AgentEvent => ({
  type: 'tool-result',
  id,
  name: 'nmap_scan',
  ok: true,
  output,
});

describe('observeRuleB — confidence calibration', () => {
  it('fires on empty-findings claim (agent says "scan complete" with no findings)', () => {
    let state = createInitialState();
    const sessionFindings: Array<{ target: string }> = []; // empty
    const r = observeRuleB(
      state,
      textDelta('The port scan is complete.'),
      sessionFindings,
    );
    expect(r.fire?.kind).toBe('overclaim');
    expect(r.fire?.evidence).toMatch(/no findings/);
  });

  it('does NOT fire when a finding exists for the target', () => {
    let state = createInitialState();
    const sessionFindings = [{ target: 'scanme.nmap.org' }];
    // The claim must reference a specific target; if findings exist for
    // the claimed target, no fire. (Rule B does not parse the target out
    // of the text — that's a v0.3 stretch. For v0.2, any non-empty
    // findings array suppresses the empty-findings sub-rule.)
    const r = observeRuleB(
      state,
      textDelta('The port scan is complete.'),
      sessionFindings,
    );
    expect(r.fire).toBeUndefined();
  });

  it('fires on claim-without-evidence (claim within 2 tool calls of empty result)', () => {
    let state = createInitialState();
    // Step 1: tool returns empty
    let r1 = observeRuleB(state, toolResult('1', []), []);
    state = r1.state;
    // Step 2: agent claims "complete" within 2 tool calls
    let r2 = observeRuleB(state, textDelta('The scan is done, no vulnerabilities found.'), []);
    expect(r2.fire?.kind).toBe('overclaim');
    expect(r2.fire?.evidence).toMatch(/empty result/);
  });

  it('does NOT fire on claim-without-evidence when the tool result was non-empty', () => {
    let state = createInitialState();
    let r1 = observeRuleB(state, toolResult('1', { ports: [22, 80, 443] }), []);
    state = r1.state;
    let r2 = observeRuleB(state, textDelta('The scan is done.'), []);
    expect(r2.fire).toBeUndefined();
  });

  it('fires on negative-result overconfidence (port not in scan range)', () => {
    let state = createInitialState();
    // Tool scanned ports 22, 80, 443
    let r1 = observeRuleB(
      state,
      toolResult('1', { scanned: [22, 80, 443], results: { 22: 'open', 80: 'open' } }),
      [],
    );
    state = r1.state;
    // Agent claims port 8080 is closed — but 8080 wasn't in the scan range
    let r2 = observeRuleB(state, textDelta('Port 8080 is closed.'), []);
    expect(r2.fire?.kind).toBe('overclaim');
    expect(r2.fire?.evidence).toMatch(/not in the scan range/);
  });

  it('does NOT fire on negative-result overconfidence when the port IS in the scan range', () => {
    let state = createInitialState();
    let r1 = observeRuleB(
      state,
      toolResult('1', { scanned: [22, 80, 443, 8080], results: { 22: 'open' } }),
      [],
    );
    state = r1.state;
    let r2 = observeRuleB(state, textDelta('Port 8080 is closed.'), []);
    expect(r2.fire).toBeUndefined();
  });

  it('does NOT fire when the claim names a specific finding (CVE, port, path)', () => {
    let state = createInitialState();
    const r = observeRuleB(
      state,
      textDelta('The scan is complete. Found CVE-2024-1234 on /admin.'),
      [],
    );
    expect(r.fire).toBeUndefined();
  });
});

describe('observeRuleC — plan quality', () => {
  it('fires on no-recon-before-destructive (destructive after 1+ tools, 0 recon)', () => {
    let state = createInitialState();
    // First tool: a non-recon-class tool (http_get — not in the recon set)
    state = observeRuleC(state, toolCall('1', 'http_get', { url: 'https://h/' })).state;
    // Second tool: destructive (e.g. nuclei_run with destructive flag)
    const r = observeRuleC(state, {
      type: 'tool-call-request',
      id: '2',
      name: 'nuclei_run',
      args: { target: 'h' },
      flags: ['destructive'],
    } as unknown as AgentEvent);
    expect(r.fire?.kind).toBe('plan-issue');
    expect(r.fire?.text).toMatch(/destructive tool without any prior recon/);
  });

  it('does NOT fire on no-recon-before-destructive if recon was already done', () => {
    let state = createInitialState();
    // First: a whois (recon)
    state = observeRuleC(state, toolCall('1', 'whois', { target: 'h' })).state;
    // Second: a destructive tool
    const r = observeRuleC(state, {
      type: 'tool-call-request',
      id: '2',
      name: 'nuclei_run',
      args: { target: 'h' },
      flags: ['destructive'],
    } as unknown as AgentEvent);
    expect(r.fire).toBeUndefined();
  });

  it('fires on 3+ calls to the same tool family in a single turn', () => {
    let state = createInitialState();
    // 3 different nmap_* calls
    state = observeRuleC(state, toolCall('1', 'nmap_scan', { target: 'h', ports: '22' })).state;
    state = observeRuleC(state, toolCall('2', 'nmap_service', { target: 'h' })).state;
    const r = observeRuleC(state, toolCall('3', 'nmap_vuln', { target: 'h' }));
    expect(r.fire?.kind).toBe('plan-issue');
    expect(r.fire?.text).toMatch(/3\+? different `nmap_\*` calls/);
  });

  it('does NOT fire on 2 calls to the same tool family', () => {
    let state = createInitialState();
    state = observeRuleC(state, toolCall('1', 'nmap_scan', { target: 'h' })).state;
    const r = observeRuleC(state, toolCall('2', 'nmap_service', { target: 'h' }));
    expect(r.fire).toBeUndefined();
  });

  it('fires on targetRequired tool with no --target set', () => {
    let state = createInitialState(); // no chokepointSessionTarget
    const r = observeRuleC(state, {
      type: 'tool-call-request',
      id: '1',
      name: 'nuclei_run',
      args: { target: 'h' },
      flags: ['targetRequired'],
    } as unknown as AgentEvent);
    expect(r.fire?.kind).toBe('plan-issue');
    expect(r.fire?.text).toMatch(/--target/);
  });

  it('does NOT fire on targetRequired tool when --target is set', () => {
    let state = createInitialState('scanme.nmap.org');
    const r = observeRuleC(state, {
      type: 'tool-call-request',
      id: '1',
      name: 'nuclei_run',
      args: { target: 'scanme.nmap.org' },
      flags: ['targetRequired'],
    } as unknown as AgentEvent);
    expect(r.fire).toBeUndefined();
  });
});
