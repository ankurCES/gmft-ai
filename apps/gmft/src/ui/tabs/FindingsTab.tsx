import { Box, Text } from 'ink';
import type { StatusInfo } from '../components/StatusRail.js';
import type { Theme } from '../theme.js';

/**
 * FindingsTab — phase-1 placeholder. Real findings land in phase 2+ when
 * tools start producing structured output. For now we show a count of any
 * pre-existing findings the caller injected via initialStatus and a clear
 * "no findings yet" line so the user knows the tab is alive.
 */
export function FindingsTab({ status, theme }: { status: StatusInfo; theme: Theme }): React.JSX.Element {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
      <Box marginBottom={1}>
        <Text>{theme.accent('Findings')}</Text>
      </Box>
      {status.findings > 0 ? (
        <Text>
          {status.findings} finding{status.findings === 1 ? '' : 's'} recorded in this session.
        </Text>
      ) : (
        <Text>{theme.muted('No findings yet. Run a tool from the chat to see results here.')}</Text>
      )}
      <Box marginTop={1}>
        <Text color="gray">(land in phase 2)</Text>
      </Box>
    </Box>
  );
}
