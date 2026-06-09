import { Box, Text } from 'ink';
import type { Theme } from '../theme.js';

export interface StatusInfo {
  model: string;
  provider: string;
  sandbox: 'docker' | 'host' | 'unknown';
  target?: string;
  tokensIn: number;
  tokensOut: number;
  toolCalls: number;
  findings: number;
}

export function StatusRail({ status, theme }: { status: StatusInfo; theme: Theme }): React.JSX.Element {
  const sandboxLabel =
    status.sandbox === 'host' ? theme.warn('⚠ host ') : theme.ok(status.sandbox);
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="gray"
      paddingX={1}
      marginBottom={1}
    >
      <Box>
        <Text>
          {theme.muted('model ')}<Text color="cyan">{status.provider}:{status.model}</Text>
          {status.target && (
            <>
              {theme.muted('  target ')}
              <Text color="magenta">{status.target}</Text>
            </>
          )}
          {theme.muted('  sandbox ')}
          {sandboxLabel}
        </Text>
      </Box>
      <Box>
        <Text>
          {theme.muted('tokens ')}
          <Text>
            ↑{status.tokensIn} ↓{status.tokensOut}
          </Text>
          {theme.muted('  tools ')}
          <Text>{status.toolCalls}</Text>
          {theme.muted('  findings ')}
          <Text color={status.findings > 0 ? 'yellow' : undefined}>{status.findings}</Text>
        </Text>
      </Box>
    </Box>
  );
}
