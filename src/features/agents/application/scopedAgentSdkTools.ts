import { tool } from '@openai/agents';
import type { JsonObjectSchemaStrict } from '@openai/agents-core/types';
import { z } from 'zod';
import type { CanvasAgentContext } from '@/features/canvas/agent/infrastructure/sdkRuntime';
import type { AgentScope } from '@/features/canvas/agent/domain/agentModel';
import { canvasAgentApprovalExecution, canvasAgentApprovalStore, createAgentRequestFingerprint, createApprovalId } from '@/features/canvas/agent/application/agentApproval';
import { redactSensitiveValue } from '@/features/canvas/agent/application/agentRedaction';
import { getScopedAgentTools, inspectScopedAgentTool } from './scopedAgentTools';
import { strictScopedToolSchema, type Schema } from './scopedAgentSchemas';


export function createScopedSdkTools(scope: AgentScope, context: CanvasAgentContext, supportsVision: boolean) {
  return getScopedAgentTools(scope).filter((definition) => definition.name !== 'asset_view' || supportsVision).map((definition) => {
    const original = z.toJSONSchema(definition.schema) as Schema;
    // Every registry schema is a closed Zod object; adapt only the SDK's structural type.
    const parameters = strictScopedToolSchema(original) as unknown as JsonObjectSchemaStrict<Record<string, Schema>>;
    return tool({
      name: definition.name,
      description: definition.description,
      parameters,
      strict: true,
      needsApproval: true,
      execute: async (rawInput, _runContext, details) => {
        const callId = details?.toolCall?.callId;
        if (!callId) throw new Error('Scoped tool requires a stable callId.');
        if (context.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
        const parsed = inspectScopedAgentTool(scope, definition.name, rawInput);
        const approvalId = createApprovalId(context.runId, definition.name, callId);
        const requestFingerprint = await createAgentRequestFingerprint(definition.name, rawInput);
        context.onToolEvent?.({ toolName: definition.name, callId, status: 'executing', input: redactSensitiveValue(parsed.input) });
        try {
          const execution = await canvasAgentApprovalExecution.executeOnce({
            approvalId, runId: context.runId, projectId: context.projectId, toolName: definition.name, callId, requestFingerprint,
            activeProjectId: scope === 'home' ? context.projectId : context.getActiveProjectId?.(),
            isSuccess: (output) => !(output && typeof output === 'object' && 'status' in output && (output.status === 'failed' || output.status === 'unknown')),
            isUnknownOutcome: (output) => Boolean(output && typeof output === 'object' && 'status' in output && output.status === 'unknown'),
            currentRevision: scope === 'stage' && parsed.risk !== 'read' && definition.name === 'stage_command' ? context.getCanvasRevision?.() : undefined,
            execute: async () => {
              if (context.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
              const result = await parsed.tool.execute(parsed.input, { signal: context.signal, projectId: context.projectId, runId: context.runId, expectedRevision: canvasAgentApprovalStore.get(approvalId)?.baseRevision });
              if (scope !== 'home' && parsed.risk !== 'read') await context.persistCanvasCheckpoint?.();
              return redactSensitiveValue(result);
            },
          });
          const output = { result: execution.output, receiptId: execution.receipt.id, receiptStatus: execution.receipt.status, replayed: execution.replayed };
          context.onToolEvent?.({ toolName: definition.name, callId,
            status: execution.receipt.status === 'unknown' ? 'unknown' : execution.receipt.status === 'failed' ? 'failed' : 'succeeded', output,
          });
          return definition.name === 'asset_view' ? execution.output : output;
        } catch (error) {
          if (context.signal?.aborted) throw error;
          const message = redactSensitiveValue(error instanceof Error ? error.message : String(error));
          context.onToolEvent?.({ toolName: definition.name, callId, status: 'failed', error: message });
          return { ok: false, error: message };
        }
      },
    });
  });
}
