import type { z } from 'zod';
import type { AgentScope } from '@/features/canvas/agent/domain/agentModel';

export interface ScopedAgentToolContext {
  signal?: AbortSignal;
  projectId: string;
  runId: string;
  expectedRevision?: number;
}
export type ScopedToolRisk = 'read' | 'edit' | 'paid' | 'destructive';
export interface ScopedAgentTool {
  name: string;
  description: string;
  scope: AgentScope;
  schema: z.ZodType;
  risk: ScopedToolRisk | ((input: unknown) => ScopedToolRisk);
  execute(input: unknown, context: ScopedAgentToolContext): Promise<unknown>;
}

export function defineScopedAgentTool<S extends z.ZodType>(definition: {
  name: string; description: string; scope: AgentScope; schema: S;
  risk: ScopedToolRisk | ((input: z.output<S>) => ScopedToolRisk);
  execute(input: z.output<S>, context: ScopedAgentToolContext): Promise<unknown>;
}): ScopedAgentTool {
  return {
    ...definition,
    risk: typeof definition.risk === 'function'
      ? (input: unknown) => {
          const risk = definition.risk;
          return typeof risk === 'function' ? risk(definition.schema.parse(input)) : risk;
        }
      : definition.risk,
    execute: (input, context) => definition.execute(definition.schema.parse(input), context),
  };
}