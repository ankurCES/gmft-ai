/**
 * v0.2.A.3 — collapsible card showing the supervisor's end-of-turn postmortem.
 *
 * The postmortem is a 4-section string the postmortem generator writes
 * at end of turn (WHAT WE TRIED / LEARNED / MISSING / NEXT STEP). The
 * card is rendered once per turn after the assistant's final message.
 *
 * The collapse toggle is a visual placeholder. The actual keyboard
 * handler (e.g. pressing `p` to toggle) is wired in `AgentApp.tsx`,
 * not in this component — the card only knows how to render the
 * current `collapsed` state.
 *
 * The card is silent: it does not block input and does not draw
 * attention beyond the cyan border. The supervisor's contract is
 * strictly non-interventional — see supervisor-types.ts for the
 * architectural promise.
 */

import React, { useState } from 'react';
import { Box, Text } from 'ink';

export interface SupervisorPostmortemCardProps {
  /** The postmortem body. Empty string is allowed (error case — see below). */
  body: string;
  /** Number of supervisor fires in the turn. Drives the "(N fires)" label. */
  fireCount: number;
}

export function SupervisorPostmortemCard({
  body,
  fireCount,
}: SupervisorPostmortemCardProps): React.JSX.Element {
  const [collapsed, setCollapsed] = useState(false);

  // Singular / plural agreement: "1 fire" vs "N fires".
  const fireLabel = `${fireCount} fire${fireCount === 1 ? '' : 's'}`;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      marginY={1}
    >
      <Box>
        <Text color="cyan" bold>
          ⓘ Postmortem
        </Text>
        <Text dimColor>{`  (${fireLabel})`}</Text>
        <Text dimColor>{'  '}</Text>
        {/* The toggle visual is a placeholder; the real keyboard handler
            lives in AgentApp.tsx. Clicking the text in a TUI is unusual,
            but we render the visual so the contract is observable. */}
        <Text color="cyan" underline>
          {collapsed ? '[+]' : '[-]'}
        </Text>
      </Box>
      {!collapsed && (
        <Box marginTop={1} flexDirection="column">
          {body.length === 0 ? (
            // Postmortem generator failed (e.g. LLM timeout). Render a
            // placeholder so the card is still meaningful — the user
            // sees the supervisor was on, it just couldn't summarise.
            <Text dimColor>(no postmortem — generator error)</Text>
          ) : (
            body.split('\n').map((line, i) => (
              // The postmortem generator is internal and the body is
              // <200 chars in practice; an index key is stable.
              // eslint-disable-next-line react/no-array-index-key
              <Text key={i}>{line}</Text>
            ))
          )}
        </Box>
      )}
    </Box>
  );
}
