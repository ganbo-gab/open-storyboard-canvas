import { z } from 'zod';
import { createWorkspaceDocument } from '@/features/workbench/application/workspaceDocument';
import { canvasPlanSchema } from './agentCanvasPlan';
import type { ScopedAgentToolContext } from './scopedAgentToolDefinition';

const savedPlanSchema = z.object({
  id: z.string(), projectId: z.string(), runId: z.string(), createdAt: z.number(), plan: canvasPlanSchema,
}).strict();
const plansSchema = z.array(savedPlanSchema);
const document = createWorkspaceDocument('storyboard-copilot:agent-canvas-plans:v1', () => plansSchema.parse([]), (input) => plansSchema.parse(input));

/** Full screenplay/prompt text stays in its domain document, never the redacted audit ledger. */
export async function prepareAgentCanvasPlan(input: unknown, context: ScopedAgentToolContext) {
  const plan = canvasPlanSchema.parse(input);
  await document.initialize?.();
  if (context.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
  const id = crypto.randomUUID();
  document.save([...document.load(), { id, projectId: context.projectId, runId: context.runId, createdAt: Date.now(), plan }]);
  await document.flush?.();
  return {
    planId: id, title: plan.title, nodeCount: plan.shots.length + 1, paidGeneration: false,
    scriptCharacters: plan.script.length,
    shots: plan.shots.map((shot) => ({ title: shot.title, modelId: shot.modelId, aspectRatio: shot.aspectRatio, resolution: shot.resolution, promptCharacters: shot.prompt.length })),
  };
}

export async function resolveAgentCanvasPlan(planId: string, context: ScopedAgentToolContext) {
  await document.initialize?.();
  if (context.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
  const saved = document.load().find((plan) => plan.id === planId && plan.projectId === context.projectId && plan.runId === context.runId);
  if (!saved) throw new Error('画布方案不存在或不属于当前会话回合；请重新准备方案。');
  return canvasPlanSchema.parse(saved.plan);
}
