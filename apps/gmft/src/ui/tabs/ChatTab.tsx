import { Box, Static, Text } from 'ink';
import { Fragment, useEffect, useMemo, useRef } from 'react';
import { InputBox } from '../components/InputBox.js';
import { Message, type Message as Msg } from '../components/Message.js';
import { StatusRail, type StatusInfo } from '../components/StatusRail.js';
import { SupervisorFireMarker } from '../components/SupervisorFireMarker.js';
import type { SupervisorFire } from '@gmft/core';
import type { Theme } from '../theme.js';

export interface ChatTabProps {
  messages: Msg[];
  history: string[];
  status: StatusInfo;
  onSubmit: (value: string) => void;
  theme: Theme;
  /**
   * v0.3.A.2 — supervisor fires accumulated this session, in
   * emission order. The tab renders a `SupervisorFireMarker`
   * immediately *after* any message whose `eventIds` contains the
   * fire's `targetEventId`. A message with no matching eventIds
   * (legacy history, or pre-fire messages) gets no marker.
   */
  supervisorFires?: SupervisorFire[];
}

/**
 * Group fires by their target message id. The grouping is stable
 * across re-renders (preserves emission order) and the function is
 * pure so it can be memoized. A fire with no matching message is
 * dropped — this happens when a fire is emitted for an event id that
 * the loop never surfaced into a transcript entry (rare; only in
 * error paths or when the loop's history diverges from the
 * transcript).
 */
export function groupFiresByMessage(
  messages: readonly Msg[],
  fires: readonly SupervisorFire[],
): ReadonlyMap<string, SupervisorFire[]> {
  // Build an index of eventId -> messageId so we can match each
  // fire's targetEventId to the right message in O(fires) instead
  // of O(fires * messages).
  const eventIdToMessageId = new Map<string, string>();
  for (const m of messages) {
    if (!m.eventIds) continue;
    for (const eid of m.eventIds) {
      if (!eventIdToMessageId.has(eid)) {
        // First-write wins (a later message that also observed the
        // id is unusual; happens when a tool-result id and its
        // requesting tool-call-request id both end up in the array).
        // For markers we want the earliest message that contains the
        // id, so the marker lands next to the cause, not the
        // outcome.
        eventIdToMessageId.set(eid, m.id);
      }
    }
  }
  const byMessage = new Map<string, SupervisorFire[]>();
  for (const f of fires) {
    const mid = eventIdToMessageId.get(f.targetEventId);
    if (mid === undefined) continue;
    const arr = byMessage.get(mid);
    if (arr) {
      arr.push(f);
    } else {
      byMessage.set(mid, [f]);
    }
  }
  return byMessage;
}

export function ChatTab({
  messages,
  history,
  status,
  onSubmit,
  theme,
  supervisorFires = [],
}: ChatTabProps): React.JSX.Element {
  // Re-mount the bottom-of-list marker so the cursor always anchors to the latest
  // message. This is the standard Ink pattern.
  const endRef = useRef<{ rerender: () => void } | null>(null);
  useEffect(() => {
    endRef.current?.rerender();
  }, [messages.length]);

  // v0.3.A.2 — match each fire's targetEventId to its transcript
  // message so the marker renders in the right place. Memoized so
  // re-renders triggered by typing in InputBox don't re-do the work.
  const firesByMessage = useMemo(
    () => groupFiresByMessage(messages, supervisorFires),
    [messages, supervisorFires],
  );

  return (
    <Box flexDirection="column">
      <Static items={messages.slice(0, -1)}>
        {(m) => (
          <Fragment key={m.id}>
            <Message message={m} theme={theme} />
            {firesByMessage.has(m.id) &&
              firesByMessage.get(m.id)!.map((f, idx) => (
                <SupervisorFireMarker
                  // idx disambiguates when two fires on the same
                  // message get the same targetEventId; rare but
                  // possible (e.g. a loop that also triggers an
                  // overclaim on the same event).
                  key={`fire-${m.id}-${idx}`}
                  fire={f}
                />
              ))}
          </Fragment>
        )}
      </Static>
      {messages.length > 0 && (
        <Fragment>
          {(() => {
            const last = messages[messages.length - 1] as Msg;
            const arr = firesByMessage.get(last.id);
            return (
              <>
                <Message message={last} theme={theme} />
                {arr?.map((f, idx) => (
                  <SupervisorFireMarker
                    key={`fire-${last.id}-${idx}`}
                    fire={f}
                  />
                ))}
              </>
            );
          })()}
        </Fragment>
      )}
      <StatusRail status={status} theme={theme} />
      <InputBox onSubmit={onSubmit} history={history} theme={theme} />
      {history.length > 0 && (
        <Box marginTop={1}>
          <Text color="gray">↑/↓ for history · Ctrl-C to exit</Text>
        </Box>
      )}
    </Box>
  );
}
