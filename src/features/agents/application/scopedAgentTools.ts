import { z } from 'zod';
import type { AgentScope } from '@/features/canvas/agent/domain/agentModel';
import { redactSensitiveValue } from '@/features/canvas/agent/application/agentRedaction';
import { useProjectStore } from '@/stores/projectStore';
import { useCanvasStore } from '@/stores/canvasStore';
import { canvasPlanSchema, openAgentCanvasPlan, openAgentProject, persistAgentProjectBeforeNavigation } from './agentCanvasPlan';
import { getAssetPortableSource, listAssets, resolveAsset } from '@/features/assets/application/assetCatalog';
import { useWorkbenchStore } from '@/features/workbench/store/workbenchStore';
import { decodeScopedToolInput } from './scopedAgentSchemas';
import { defineScopedAgentTool, type ScopedAgentTool } from './scopedAgentToolDefinition';
import { stageAgentTools } from './stageAgentTools';
import { createAgentMediaReference, prepareAgentMediaSource, toOpaqueAgentMediaReference } from '@/features/canvas/agent/application/agentMediaResolver';
import { prepareAgentCanvasPlan, resolveAgentCanvasPlan } from './agentCanvasPlanRepository';


const text = z.string().trim().min(1);
const homeTools: ScopedAgentTool[] = [
  defineScopedAgentTool({
    name: 'project_list', scope: 'home', risk: 'read',
    description: 'List real project summaries. No canvas or media bodies are returned.',
    schema: z.object({}).strict(),
    async execute() {
      await useProjectStore.getState().hydrate();
      return useProjectStore.getState().projects.map(({ id, name, updatedAt, nodeCount }) => ({ id, name, updatedAt, nodeCount }));
    },
  }),
  defineScopedAgentTool({
    name: 'project_create', scope: 'home', risk: 'edit',
    description: 'Create and open an empty project, without paid generation.',
    schema: z.object({ name: text.max(200) }).strict(),
    async execute(input) {
      await persistAgentProjectBeforeNavigation();
      const projectId = useProjectStore.getState().createProject(input.name);
      useCanvasStore.getState().setCanvasData([], []);
      await useProjectStore.getState().waitForProjectPersistence(projectId);
      return { projectId };
    },
  }),
  defineScopedAgentTool({
    name: 'project_open', scope: 'home', risk: 'edit',
    description: 'Open an existing project by its real id from project_list.',
    schema: z.object({ projectId: text }).strict(),
    async execute(input) {
      await openAgentProject(input.projectId);
      return { projectId: input.projectId };
    },
  }),
  defineScopedAgentTool({
    name: 'canvas_prepare_plan', scope: 'home', risk: 'read',
    description: 'Validate and durably retain the complete script and shot prompts. Return an opaque planId and preview metadata without editing projects or submitting generation. Pass planId unchanged to canvas_open_plan; never reconstruct text from audit previews.',
    schema: canvasPlanSchema,
    async execute(input, context) { return prepareAgentCanvasPlan(input, context); },
  }),
  defineScopedAgentTool({
    name: 'canvas_open_plan', scope: 'home', risk: 'edit',
    description: 'Materialize the exact stored plan identified by canvas_prepare_plan.planId into script and shot nodes plus edges in one undoable transaction. Null projectId creates a project. Never submits generation or accepts replacement plan text.',
    schema: z.object({ projectId: text.nullable(), planId: text }).strict(),
    async execute(input, context) {
      const plan = await resolveAgentCanvasPlan(input.planId, context);
      return openAgentCanvasPlan({ projectId: input.projectId, plan });
    },
  }),
  defineScopedAgentTool({
    name: 'asset_search', scope: 'home', risk: 'read',
    description: 'Search the actual asset library. Returns stable ids and metadata, never source URLs or local paths.',
    schema: z.object({ search: z.string().max(200).nullable(), kind: z.enum(['image', 'video', 'audio', 'text']).nullable() }).strict(),
    async execute(input) {
      const assets = await listAssets({ search: input.search ?? undefined, kind: input.kind ?? undefined });
      return assets.slice(0, 100).map((asset) => redactSensitiveValue({
        id: asset.id, name: asset.name, kind: asset.kind, origin: asset.origin, createdAt: asset.createdAt,
        favorite: asset.favorite, projectId: asset.projectId, nodeId: asset.nodeId, taskId: asset.taskId,
        aspectRatio: asset.metadata.aspectRatio, width: asset.metadata.width, height: asset.metadata.height,
        duration: asset.metadata.duration, prompt: asset.metadata.prompt,
      }));
    },
  }),
  defineScopedAgentTool({
    name: 'home_generation_submit', scope: 'home', risk: 'paid',
    description: 'Submit one REAL workbench image/video/audio generation using an explicit selected model and prompt. May charge money; always requires explicit approval. Never retry an ambiguous submission.',
    schema: z.object({ kind: z.enum(['image', 'video', 'audio']), prompt: text.max(50_000), model: text,
      config: z.object({ size: z.string().nullable(), aspectRatio: z.string().nullable(), seconds: z.number().positive().nullable() }).strict(),
      referenceAssetIds: z.array(text).max(20).optional(),
    }).strict(),
    async execute(input, context) {
      if (context.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      const references = await Promise.all((input.referenceAssetIds ?? []).map(async (assetId) => {
        const asset = await resolveAsset(assetId);
        if (!asset) throw new Error(`参考资产 ${assetId} 不存在。`);
        return { id: asset.id, kind: asset.kind, source: asset.source, name: asset.name };
      }));
      if (context.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      const taskId = await useWorkbenchStore.getState().submit({ kind: input.kind, model: input.model, prompt: input.prompt,
        references, config: { size: input.config.size ?? undefined, aspectRatio: input.config.aspectRatio ?? undefined, seconds: input.config.seconds ?? undefined },
      });
      const task = useWorkbenchStore.getState().tasks[taskId];
      return redactSensitiveValue({ taskId, status: task.status, jobId: task.jobId, failure: task.failure, kind: input.kind, model: input.model,
        results: task.results.map(({ assetId, kind }) => ({ assetId, kind })),
      });
    },
  }),
  defineScopedAgentTool({
    name: 'home_generation_status', scope: 'home', risk: 'read',
    description: 'Read/poll an existing real workbench task. This never resubmits generation.',
    schema: z.object({ taskId: text }).strict(),
    async execute(input, context) {
      if (!useWorkbenchStore.getState().tasks[input.taskId]) throw new Error('生成任务不存在。');
      if (context.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      const current = useWorkbenchStore.getState().tasks[input.taskId];
      if (current.jobId && !['succeeded', 'failed', 'canceled'].includes(current.status)) await useWorkbenchStore.getState().poll(input.taskId);
      const task = useWorkbenchStore.getState().tasks[input.taskId];
      return redactSensitiveValue({ id: task.id, status: task.status, jobId: task.jobId, failure: task.failure,
        results: task.results.map(({ assetId, kind }) => ({ assetId, kind })),
      });
    },
  }),
];

const sharedMediaTools = (['home', 'stage'] as const).map((scope) => defineScopedAgentTool({
  name: 'asset_view', scope, risk: 'edit',
  description: 'Send one explicitly approved image asset to the current vision model. Uses a real stable asset id, never an arbitrary URL; do not claim to see it unless the model supports vision.',
  schema: z.object({ assetId: text }).strict(),
  async execute(input, context) {
    const asset = await resolveAsset(input.assetId);
    if (!asset || asset.kind !== 'image') throw new Error('图片资产不存在或不是图片。');
    const source = await prepareAgentMediaSource(await getAssetPortableSource(asset.previewUrl || asset.source));
    const reference = createAgentMediaReference(context.runId, asset.nodeId ?? asset.id, source, 10 * 60_000, asset.id);
    return [
      { type: 'text', text: JSON.stringify({ assetId: asset.id, name: asset.name }) },
      { type: 'image', image: toOpaqueAgentMediaReference(reference), detail: 'auto' },
    ];
  },
}));
export function getScopedAgentTools(scope: AgentScope): ScopedAgentTool[] {
  return [...homeTools, ...stageAgentTools, ...sharedMediaTools,
    ...homeTools.filter((tool) => tool.name === 'asset_search').map((tool) => ({ ...tool, scope: 'stage' as const })),
  ].filter((tool) => tool.scope === scope);
}
export function inspectScopedAgentTool(scope: AgentScope, name: string, input: unknown) {
  const tool = getScopedAgentTools(scope).find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Tool ${name} is not available in ${scope} scope.`);
  const parsed = tool.schema.safeParse(decodeScopedToolInput(z.toJSONSchema(tool.schema), input));
  if (!parsed.success) throw new Error(`Invalid ${name} arguments: ${parsed.error.message}`);
  return { tool, input: parsed.data, risk: typeof tool.risk === 'function' ? tool.risk(parsed.data) : tool.risk };
}

export function selectedAgentContext(scope: AgentScope): unknown {
  const project = useProjectStore.getState();
  if (scope === 'home') return { scope, currentProjectId: project.currentProjectId };
  const canvas = useCanvasStore.getState();
  const selected = canvas.nodes.filter((node) => node.selected || node.id === canvas.selectedNodeId).slice(0, 20);
  return redactSensitiveValue({ scope, projectId: project.currentProjectId, revision: canvas.revision,
    activeStageNodeId: scope === 'stage' ? canvas.activeDirectorStudioNodeId : undefined,
    selected: selected.map((node) => ({ id: node.id, type: node.type, title: node.data.displayName, prompt: typeof node.data.prompt === 'string' ? node.data.prompt.slice(0, 2_000) : undefined })),
  });
}
