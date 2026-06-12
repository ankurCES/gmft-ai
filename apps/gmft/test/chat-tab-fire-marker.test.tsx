/**
 * v0.3.A.2 — end-to-end test for the SupervisorFireMarker wiring in
 * ChatTab. The plan calls for:
 *
 *   1. The agent loop captures runtime event ids during a turn.
 *   2. The assistant message carries those ids in `eventIds`.
 *   3. The supervisor's fires (with `targetEventId` referencing one
 *      of the captured ids) are accumulated in AgentApp.
 *   4. ChatTab matches each fire's `targetEventId` against the
 *      message's `eventIds` and renders a `<SupervisorFireMarker>`
 *      after the matching message.
 *
 * This test exercises the (3) → (4) leg by passing a hand-built
 * `messages` + `supervisorFires` to ChatTab. The (1) → (2) leg is
 * covered in `apps/gmft/src/AgentApp.tsx` (the per-turn event id
 * collector) and exercised by `agent-app.test.tsx` integration
 * tests.
 *
 * v0.3.A.2 — renamed from the old `transcript-fire-marker.test.tsx`
 * (which was really a `SupervisorFireMarker` unit test; that file is
 * preserved). The new name reflects that we test the *placement*
 * logic in ChatTab, not the marker itself.
 */

import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { ChatTab, groupFiresByMessage } from '../src/ui/tabs/ChatTab.js';
import type { Message as Msg } from '../src/ui/components/Message.js';
import type { SupervisorFire } from '@gmft/core';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function mkMsg(over: Partial<Msg> = {}): Msg {
  return {
    id: `m-${Math.random().toString(36).slice(2, 8)}`,
    role: 'assistant',
    content: 'response body',
    ts: 0,
    ...over,
  };
}

function mkFire(over: Partial<SupervisorFire> = {}): SupervisorFire {
  return {
    kind: 'loop-detected',
    tool: 'whois',
    count: 3,
    recent: ['whois', 'whois', 'whois'],
    advice: 'Tool has been called 3 times with the same args — consider switching approach.',
    targetEventId: 'evt-1',
    ...over,
  };
}

describe('groupFiresByMessage helper', () => {
  it('groups fires by the first message whose eventIds contains their targetEventId', () => {
    const messages: Msg[] = [
      mkMsg({ id: 'a', eventIds: ['evt-1', 'evt-2'] }),
      mkMsg({ id: 'b', eventIds: ['evt-3'] }),
    ];
    const fires: SupervisorFire[] = [
      mkFire({ targetEventId: 'evt-1' }),
      mkFire({ targetEventId: 'evt-3' }),
    ];
    const grouped = groupFiresByMessage(messages, fires);
    expect(grouped.get('a')?.length).toBe(1);
    expect(grouped.get('b')?.length).toBe(1);
    expect(grouped.get('a')?.[0]?.targetEventId).toBe('evt-1');
    expect(grouped.get('b')?.[0]?.targetEventId).toBe('evt-3');
  });

  it('drops fires whose targetEventId is not in any message.eventIds', () => {
    const messages: Msg[] = [mkMsg({ id: 'a', eventIds: ['evt-1'] })];
    const fires: SupervisorFire[] = [
      mkFire({ targetEventId: 'evt-orphan' }),
    ];
    const grouped = groupFiresByMessage(messages, fires);
    expect(grouped.size).toBe(0);
  });

  it('preserves emission order within a single message', () => {
    const messages: Msg[] = [mkMsg({ id: 'a', eventIds: ['evt-1', 'evt-2'] })];
    const fires: SupervisorFire[] = [
      mkFire({ kind: 'loop-detected', targetEventId: 'evt-1' }),
      mkFire({
        kind: 'overclaim',
        targetEventId: 'evt-2',
        quote: 'safe',
        evidence: 'evidence',
        advice: 'overclaim advice',
      }),
    ];
    const grouped = groupFiresByMessage(messages, fires);
    const arr = grouped.get('a');
    expect(arr?.length).toBe(2);
    expect(arr?.[0]?.kind).toBe('loop-detected');
    expect(arr?.[1]?.kind).toBe('overclaim');
  });

  it('attaches to the first message that observed the id, not a later one', () => {
    const messages: Msg[] = [
      mkMsg({ id: 'a', eventIds: ['evt-1'] }),
      mkMsg({ id: 'b', eventIds: ['evt-1'] }), // also contains evt-1
    ];
    const fires: SupervisorFire[] = [mkFire({ targetEventId: 'evt-1' })];
    const grouped = groupFiresByMessage(messages, fires);
    expect(grouped.has('a')).toBe(true);
    expect(grouped.has('b')).toBe(false);
  });
});

describe('ChatTab supervisor fire marker placement (v0.3.A.2)', () => {
  it('renders a marker after a message whose eventIds contains the fire targetEventId', async () => {
    const messages: Msg[] = [
      mkMsg({ id: 'a', content: 'first turn' }),
      mkMsg({
        id: 'b',
        content: 'second turn',
        eventIds: ['evt-1', 'evt-2'],
      }),
    ];
    const fires: SupervisorFire[] = [mkFire({ targetEventId: 'evt-1' })];

    const { lastFrame } = render(
      <ChatTab
        messages={messages}
        history={[]}
        status={{
          provider: 'anthropic',
          model: 'claude-3-5-haiku-latest',
          toolCalls: 0,
          findings: 0,
          findingsBySeverity: { info: 0, low: 0, medium: 0, high: 0, critical: 0 },
          supervisor: 'quiet',
          fireCount: 0,
        }}
        onSubmit={() => {}}
        theme={{
          user: (s) => s,
          assistant: (s) => s,
          system: (s) => s,
          tool: (s) => s,
          muted: (s) => s,
          warning: (s) => s,
          error: (s) => s,
          success: (s) => s,
          info: (s) => s,
        }}
        supervisorFires={fires}
      />,
    );
    await tick();
    const frame = lastFrame() ?? '';
    // Marker is present (⚠ + rule letter + tool name).
    expect(frame).toMatch(/⚠/);
    expect(frame).toMatch(/rule a/i);
    expect(frame).toMatch(/whois/);
  });

  it('does NOT render a marker when no message has a matching eventId', async () => {
    const messages: Msg[] = [
      mkMsg({ id: 'a', content: 'first turn' }),
      mkMsg({
        id: 'b',
        content: 'second turn',
        eventIds: ['evt-99'], // doesn't match the fire's target
      }),
    ];
    const fires: SupervisorFire[] = [mkFire({ targetEventId: 'evt-1' })];

    const { lastFrame } = render(
      <ChatTab
        messages={messages}
        history={[]}
        status={{
          provider: 'anthropic',
          model: 'claude-3-5-haiku-latest',
          toolCalls: 0,
          findings: 0,
          findingsBySeverity: { info: 0, low: 0, medium: 0, high: 0, critical: 0 },
          supervisor: 'quiet',
          fireCount: 0,
        }}
        onSubmit={() => {}}
        theme={{
          user: (s) => s,
          assistant: (s) => s,
          system: (s) => s,
          tool: (s) => s,
          muted: (s) => s,
          warning: (s) => s,
          error: (s) => s,
          success: (s) => s,
          info: (s) => s,
        }}
        supervisorFires={fires}
      />,
    );
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).not.toMatch(/⚠/);
    expect(frame).not.toMatch(/rule a/i);
  });

  it('renders multiple markers for multiple fires on the same target', async () => {
    const messages: Msg[] = [
      mkMsg({
        id: 'a',
        eventIds: ['evt-1'],
      }),
    ];
    const fires: SupervisorFire[] = [
      mkFire({ kind: 'loop-detected', targetEventId: 'evt-1', tool: 'whois' }),
      mkFire({
        kind: 'overclaim',
        targetEventId: 'evt-1',
        quote: 'safe',
        evidence: 'last 2 results',
        advice: 'Overclaim test.',
      }),
    ];

    const { lastFrame } = render(
      <ChatTab
        messages={messages}
        history={[]}
        status={{
          provider: 'anthropic',
          model: 'claude-3-5-haiku-latest',
          toolCalls: 0,
          findings: 0,
          findingsBySeverity: { info: 0, low: 0, medium: 0, high: 0, critical: 0 },
          supervisor: 'quiet',
          fireCount: 0,
        }}
        onSubmit={() => {}}
        theme={{
          user: (s) => s,
          assistant: (s) => s,
          system: (s) => s,
          tool: (s) => s,
          muted: (s) => s,
          warning: (s) => s,
          error: (s) => s,
          success: (s) => s,
          info: (s) => s,
        }}
        supervisorFires={fires}
      />,
    );
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toMatch(/rule a/i);
    expect(frame).toMatch(/rule b/i);
  });

  it('renders the marker on the LAST (live) message too, not just static ones', async () => {
    // The last message isn't in <Static>, it's rendered live so the
    // cursor can anchor to it. The marker must still appear.
    const messages: Msg[] = [
      mkMsg({ id: 'a', eventIds: ['evt-other'] }),
      mkMsg({ id: 'b', eventIds: ['evt-1'] }), // last
    ];
    const fires: SupervisorFire[] = [mkFire({ targetEventId: 'evt-1' })];

    const { lastFrame } = render(
      <ChatTab
        messages={messages}
        history={[]}
        status={{
          provider: 'anthropic',
          model: 'claude-3-5-haiku-latest',
          toolCalls: 0,
          findings: 0,
          findingsBySeverity: { info: 0, low: 0, medium: 0, high: 0, critical: 0 },
          supervisor: 'quiet',
          fireCount: 0,
        }}
        onSubmit={() => {}}
        theme={{
          user: (s) => s,
          assistant: (s) => s,
          system: (s) => s,
          tool: (s) => s,
          muted: (s) => s,
          warning: (s) => s,
          error: (s) => s,
          success: (s) => s,
          info: (s) => s,
        }}
        supervisorFires={fires}
      />,
    );
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toMatch(/⚠/);
  });
});
