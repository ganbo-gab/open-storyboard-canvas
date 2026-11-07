import { tool } from '@openai/agents';
import { readAgentUserInputAnswer, requestUserInputSchema } from '../application/agentUserInput';
import type { CanvasAgentContext } from './sdkRuntime';

/** Uses the same durable SDK interruption as approvals, but every execution mode waits for an answer. */
export function createAgentUserInputTool(context: CanvasAgentContext) {
  return tool({
    name: 'request_user_input',
    description: 'Ask 1–3 necessary questions as interactive cards, e.g. choose a generation model or required reference/parameter. Supply exact real model IDs as option values. Empty options with allowCustom=true permits text. Never request passwords/API keys. Wait for answers; do not repeat the same question in prose.',
    parameters: requestUserInputSchema,
    needsApproval: true,
    execute: async (request, _runContext, details) => {
      const callId = details?.toolCall?.callId;
      if (!callId) throw new Error('Question requires a stable call ID');
      const answers = readAgentUserInputAnswer({ projectId: context.projectId, runId: context.runId, callId }, request);
      if (!answers) throw new Error('请先在询问卡中补充信息。');
      context.onToolEvent?.({ toolName: 'request_user_input', callId, status: 'succeeded', output: { answers } });
      return { answers };
    },
  });
}
