import { createKnowledgeAgentTools } from '@/features/knowledge/application/knowledgeAgentTools';
import { ensureKnowledgeService } from '@/features/knowledge/application/ensureKnowledgeService';
import { useKnowledgeStore } from '@/features/knowledge/application/knowledgeStore';
import { KnowledgeError } from '@/features/knowledge/domain/types';
import { redactSensitiveValue } from '@/features/canvas/agent/application/agentRedaction';
import { assertAgentSerializedRunStateSafe } from '@/features/canvas/agent/infrastructure/agentSessionRepository';
import { defineScopedAgentTool, type ScopedAgentTool, type ScopedToolRisk } from './scopedAgentToolDefinition';

const risks = { kb_search: 'read', kb_read: 'read', kb_write: 'destructive', kb_organize: 'paid' } as const satisfies Record<string, ScopedToolRisk>;

function safeKnowledgeResult(value: unknown): unknown {
  const redacted = redactSensitiveValue(value);
  if (typeof redacted === 'string') {
    try { assertAgentSerializedRunStateSafe(JSON.stringify(redacted)); return redacted; }
    catch { return '[omitted-sensitive-note-text]'; }
  }
  if (Array.isArray(redacted)) return redacted.map(safeKnowledgeResult);
  if (redacted && typeof redacted === 'object') return Object.fromEntries(Object.entries(redacted).map(([key, child]) => [key, safeKnowledgeResult(child)]));
  return redacted;
}

export const scopedKnowledgeTools: ScopedAgentTool[] = (['home', 'canvas', 'stage'] as const).flatMap((scope) =>
  createKnowledgeAgentTools(ensureKnowledgeService).map((metadata) => defineScopedAgentTool({
    name: metadata.name, scope, risk: risks[metadata.name], description: metadata.description, schema: metadata.schema,
    async execute(input, context) {
      context.signal?.throwIfAborted();
      if (metadata.name === 'kb_organize' && !context.knowledgeModel) throw new KnowledgeError('MODEL_UNAVAILABLE', 'Select an available turn model before organizing knowledge');
      const selectedModel = context.knowledgeModel;
      const tool = createKnowledgeAgentTools(ensureKnowledgeService, selectedModel ? async (request) => {
        context.signal?.throwIfAborted();
        const result = await selectedModel(request);
        context.signal?.throwIfAborted();
        return result;
      } : undefined).find((candidate) => candidate.name === metadata.name)!;
      const output = await tool.handler(input);
      if (metadata.mutates) await useKnowledgeStore.getState().refresh();
      return safeKnowledgeResult(output);
    },
  })),
);
