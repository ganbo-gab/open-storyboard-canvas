import { z } from 'zod';
import type { CustomProviderConfig } from '@/stores/customProvidersStore';
import { cloneWorkflow } from '../adapters/comfyui/workflow';

const bindingSchema = z.object({ nodeId: z.string().min(1), input: z.string().min(1) }).strict();
export const comfyWorkflowConfigSchema = z.object({
  workflow: z.record(z.string(), z.record(z.string(), z.unknown())),
  bindings: z.object({
    prompt: bindingSchema.optional(), seed: bindingSchema.optional(), width: bindingSchema.optional(), height: bindingSchema.optional(),
    duration: bindingSchema.optional(), resolution: bindingSchema.optional(), aspectRatio: bindingSchema.optional(),
    images: z.array(bindingSchema).optional(),
  }).strict().optional(),
  outputNodeIds: z.array(z.string().min(1)).optional(),
  pollIntervalMs: z.number().finite().positive().optional(),
  pollTimeoutMs: z.number().finite().positive().optional(),
}).passthrough();
export type ComfyUIWorkflowConfig = z.infer<typeof comfyWorkflowConfigSchema>;
export const comfyWorkflowDefinitionSchema = z.object({
  id: z.string().trim().min(1), name: z.string().trim().min(1), mediaType: z.enum(['image', 'video']), config: comfyWorkflowConfigSchema,
}).strict();
export type ComfyUIWorkflowDefinition = z.infer<typeof comfyWorkflowDefinitionSchema>;
export const comfyWorkflowCollectionSchema = z.object({
  version: z.literal(1), selectedWorkflowId: z.string().min(1).nullable(), workflows: z.array(comfyWorkflowDefinitionSchema),
}).strict().superRefine((value, context) => {
  const ids = value.workflows.map((workflow) => workflow.id);
  if (ids.some((id, index) => ids.indexOf(id) !== index)) context.addIssue({ code: 'custom', message: 'ComfyUI workflow IDs must be unique' });
  if (value.selectedWorkflowId === null ? ids.length > 0 : !ids.includes(value.selectedWorkflowId)) {
    context.addIssue({ code: 'custom', message: 'ComfyUI selection must identify a saved workflow' });
  }
});
export type ComfyUIWorkflowCollection = z.infer<typeof comfyWorkflowCollectionSchema>;

/** Legacy model IDs are retained exactly, so saved node selections survive hydration. */
export function readComfyUIWorkflows(provider: CustomProviderConfig): ComfyUIWorkflowCollection {
  if (provider.apiStyle !== 'comfyui') throw new Error('当前配置不是 ComfyUI 连接');
  if (provider.comfyWorkflows !== undefined) return comfyWorkflowCollectionSchema.parse(structuredClone(provider.comfyWorkflows));
  const config = comfyWorkflowConfigSchema.parse(structuredClone(provider.extraParams?.comfyui));
  const id = provider.models[0]?.trim() || 'workflow';
  return { version: 1, selectedWorkflowId: id, workflows: [{ id, name: id === 'workflow' ? provider.label : id,
    mediaType: provider.mediaType === 'video' ? 'video' : 'image', config }] };
}

export function resolveComfyUIWorkflow(provider: CustomProviderConfig, modelId?: string): ComfyUIWorkflowDefinition {
  const collection = readComfyUIWorkflows(provider);
  const id = modelId ?? collection.selectedWorkflowId;
  const workflow = collection.workflows.find((entry) => entry.id === id);
  if (!workflow) throw new Error(`ComfyUI 工作流不存在：${id ?? ''}`);
  return workflow;
}

/** One authoritative collection; the obsolete single-workflow payload is removed on migration. */
export function withComfyUIWorkflows(provider: CustomProviderConfig, collection: ComfyUIWorkflowCollection): CustomProviderConfig {
  if (provider.apiStyle !== 'comfyui') throw new Error('当前配置不是 ComfyUI 连接');
  const comfyWorkflows = comfyWorkflowCollectionSchema.parse(structuredClone(collection));
  const { comfyui: _legacy, ...extraParams } = provider.extraParams ?? {};
  const selected = comfyWorkflows.workflows.find((entry) => entry.id === comfyWorkflows.selectedWorkflowId);
  return { ...provider, extraParams, comfyWorkflows, models: comfyWorkflows.workflows.map((entry) => entry.id),
    ...(selected ? { mediaType: selected.mediaType } : {}) };
}

export function normalizeComfyUIProvider(provider: CustomProviderConfig): CustomProviderConfig {
  if (provider.apiStyle !== 'comfyui') return provider;
  if (provider.comfyWorkflows !== undefined) return withComfyUIWorkflows(provider, readComfyUIWorkflows(provider));
  // Incomplete legacy settings remain intact for explicit repair, not an executable empty-workflow migration.
  const parsed = comfyWorkflowConfigSchema.safeParse(provider.extraParams?.comfyui);
  if (!parsed.success) return provider;
  try { cloneWorkflow(parsed.data.workflow); } catch { return provider; }
  return withComfyUIWorkflows(provider, readComfyUIWorkflows(provider));
}
