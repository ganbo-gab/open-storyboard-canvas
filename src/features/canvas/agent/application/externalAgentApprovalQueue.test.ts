import { describe, expect, it } from 'vitest';

import { enqueueExternalAgentApproval } from './externalAgentApprovalQueue';

describe('external Agent approval queue', () => {
  const pending = (callId: string) => ({
    request: {
      version: 1 as const,
      runtime: 'codex' as const,
      sessionId: 'managed-1',
      turnId: 'managed-turn',
      callId,
      toolName: 'canvas_command' as const,
      arguments: { command: callId },
    },
    summary: `summary-${callId}`,
    impactSummary: `impact-${callId}`,
  });

  it('queues concurrent approvals in order and ignores replay duplicates', () => {
    const first = enqueueExternalAgentApproval([], pending('call-1'));
    const second = enqueueExternalAgentApproval(first, pending('call-2'));
    const replayed = enqueueExternalAgentApproval(second, pending('call-1'));

    expect(second.map((item) => item.request.callId)).toEqual(['call-1', 'call-2']);
    expect(replayed).toBe(second);
  });
});
