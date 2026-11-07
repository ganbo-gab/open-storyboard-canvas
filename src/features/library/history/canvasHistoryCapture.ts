import { useCanvasStore } from '@/stores/canvasStore';
import { useProjectStore } from '@/stores/projectStore';
import type { GenerationJobState } from '@/commands/ai';
import { listGenerationJobs, normalizeGenerationJobResults } from '@/commands/ai';
import { CANVAS_NODE_TYPES, type CanvasNode, type CanvasEdge } from '@/features/canvas/domain/canvasNodes';
import { collectInputReferences } from '@/features/canvas/application/graphReferenceResolver';
import type { GenerationDebugContext } from '@/features/canvas/application/generationErrorReport';
import type { GenerationRequestOptions } from '@/features/canvas/application/generation/types';
import { recordCanvasGeneration, useGenerationHistoryStore } from './historyStore';
import type { GenerationHistoryRecord, HistoryAssetReference, HistoryReference } from './history';

const projectionSignatures = new Map<string, string>();
const validStatuses: Record<string, true> = { queued: true, submitting: true, running: true, recoverable_wait: true, materializing: true, succeeded: true, failed: true, not_found: true, unknown: true, canceled: true };
export function projectCanvasHistoryStatus(record: GenerationHistoryRecord, nodes: CanvasNode[]): { status: GenerationJobState; outputs: HistoryAssetReference[]; error?: string; resultNodeIds: string[] } | null {
  const resultIds = new Set(record.resultNodeIds ?? []); const jobs = new Set(record.jobIds ?? []);
  const results = nodes.filter((node) => {
    const activeJob = typeof node.data.generationJobId === 'string' && node.data.generationJobId ? node.data.generationJobId : undefined;
    const lastJob = typeof node.data.generationLastJobId === 'string' && node.data.generationLastJobId ? node.data.generationLastJobId : undefined;
    // A reused result node is not an attempt identity. A new active task also
    // takes precedence over a retained lastJobId from the previous attempt.
    if (jobs.size) {
      if (activeJob) return jobs.has(activeJob);
      if (node.data.isGenerating || node.data.isStreaming) return false;
      return Boolean(lastJob && jobs.has(lastJob));
    }
    return !activeJob && !lastJob && resultIds.has(node.id);
  });
  if (!results.length) return null;
  const outputs = results.flatMap((node): HistoryAssetReference[] => {
    const data = node.data;
    if (typeof data.imageUrl === 'string' && data.imageUrl) return [{ kind: 'image', source: data.imageUrl }];
    if (typeof data.videoUrl === 'string' && data.videoUrl) return [{ kind: 'video', source: data.videoUrl }];
    if (typeof data.audioUrl === 'string' && data.audioUrl) return [{ kind: 'audio', source: data.audioUrl }];
    if (node.type === CANVAS_NODE_TYPES.textAnnotation && typeof data.content === 'string' && data.content) return [{ kind: 'text', source: data.content }];
    if (node.type === CANVAS_NODE_TYPES.jsonCard && typeof data.rawContent === 'string' && data.rawContent) return [{ kind: 'text', source: data.rawContent }];
    if (node.type === CANVAS_NODE_TYPES.blueprint && Array.isArray(data.items)) {
      const items: unknown[] = data.items;
      return items.flatMap((item): HistoryAssetReference[] => {
        if (!item || typeof item !== 'object' || !('importedModelId' in item) || typeof item.importedModelId !== 'string' || !item.importedModelId) return [];
        return [{ kind: 'model', source: item.importedModelId, importedModelId: item.importedModelId }];
      });
    }
    return [];
  });
  const error = results.map(node => node.data.generationError ?? node.data.lastError).find((value): value is string => typeof value === 'string' && !!value);
  const explicit = results.map(node => node.data.generationJobState).filter((value): value is GenerationJobState => typeof value === 'string' && validStatuses[value] === true);
  let status: GenerationJobState = record.status;
  if (results.some(node => node.data.isGenerating === true || node.data.isStreaming === true)) status = explicit.find(value => ['unknown', 'recoverable_wait', 'materializing', 'submitting', 'queued'].includes(value)) ?? 'running';
  else if (explicit.some(value => ['unknown', 'recoverable_wait', 'failed', 'not_found', 'canceled'].includes(value))) status = explicit.find(value => ['unknown', 'recoverable_wait', 'failed', 'not_found', 'canceled'].includes(value))!;
  else if (error) status = 'failed';
  else if (outputs.length >= results.length) status = 'succeeded';
  return { status, outputs, error, resultNodeIds: results.map(node => node.id) };
}
function reconcileCanvasHistory(): void {
  const history = useGenerationHistoryStore.getState();
  if (!history.initialized) return;
  const projectId = useProjectStore.getState().currentProjectId;
  for (const record of history.records) {
    if (!record.nodeId || record.status === 'succeeded' || (!record.jobIds?.length && (record.status === 'failed' || record.status === 'canceled')) || (record.projectId && record.projectId !== projectId)) continue;
    const projection = projectCanvasHistoryStatus(record, useCanvasStore.getState().nodes);
    if (!projection) continue;
    const signature = JSON.stringify(projection);
    if (projectionSignatures.get(record.id) === signature) continue;
    projectionSignatures.set(record.id, signature);
    void history.update({ id: record.id, ...projection }).catch(() => { projectionSignatures.delete(record.id); });
  }
}
let reconciliationScheduled = false;
function scheduleCanvasHistoryReconciliation(): void {
  if (reconciliationScheduled) return;
  reconciliationScheduled = true;
  queueMicrotask(() => { reconciliationScheduled = false; reconcileCanvasHistory(); });
}
useCanvasStore.subscribe((state, previous) => { if (state.nodes !== previous.nodes) scheduleCanvasHistoryReconciliation(); });
useGenerationHistoryStore.subscribe((state, previous) => { if (state.records !== previous.records) scheduleCanvasHistoryReconciliation(); });

/** Takes an immutable input snapshot before the request. Only records actual assembled submissions. */
export function captureCanvasGeneration(source: CanvasNode, nodes: CanvasNode[], edges: CanvasEdge[], createdAt: number, options: GenerationRequestOptions): (input: { context?: GenerationDebugContext; resultNodeIds: string[]; jobIds: string[] }) => void {
  const data = structuredClone(source.data);
  for (const key of Object.keys(data)) if (key.startsWith('generation') || ['lastPreparedPayload', 'lastPayloadDiagnostics', 'resultNodeId', 'lastRunInputHash', 'lastError'].includes(key)) delete data[key];
  const projectId = useProjectStore.getState().currentProjectId ?? undefined;
  const references: HistoryReference[] = collectInputReferences(source.id, nodes, edges).flatMap(reference => {
    const source = reference.imageUrl ?? reference.videoUrl ?? reference.audioUrl ?? reference.content;
    return source ? [{ id: reference.sourceItemId ?? reference.sourceNodeId, kind: reference.kind, source, name: reference.title }] : [];
  });
  const id = `canvas:${crypto.randomUUID()}`;
  return ({ context, resultNodeIds, jobIds }) => {
    if (!context) return;
    if (context.channelModeId !== undefined) {
      data.channelModeId = context.channelModeId;
      // A replay uses the effective parameters from this submit, including auto-mode defaults.
      if (data.modelConfig && typeof data.modelConfig === 'object' && 'extraParams' in data.modelConfig) {
        data.modelConfig = { ...data.modelConfig, extraParams: structuredClone(context.extraParams ?? {}) };
      }
    }
    const { payloadPreview: _payloadPreview, ...extraParams } = context.extraParams ?? {};
    const record: GenerationHistoryRecord = { id, createdAt, surface: options.historySurface ?? 'canvas', projectId, nodeId: source.id,
      modelRef: String(data.modelId ?? (typeof data.modelConfig === 'object' && data.modelConfig !== null && 'entryId' in data.modelConfig ? data.modelConfig.entryId : undefined) ?? data.model ?? context.requestModel ?? context.providerId ?? ''),
      modeId: context.channelModeId ?? (typeof data.channelModeId === 'string' ? data.channelModeId : undefined), prompt: context.prompt ?? String(data.prompt ?? ''),
      ...(context.prompt !== undefined ? { upstreamPrompt: context.prompt } : {}),
      params: { nodeType: source.type, nodeData: data, tool: options.tool, count: options.count, request: { model: context.requestModel, size: context.requestSize, aspectRatio: context.requestAspectRatio, extraParams } },
      references, status: jobIds.length ? 'running' : 'failed', outputs: [], jobIds: [...jobIds], resultNodeIds: [...resultNodeIds] };
    const projection = projectCanvasHistoryStatus(record, useCanvasStore.getState().nodes);
    void recordCanvasGeneration({ ...record, ...projection }).catch(() => { /* Store exposes persistence failures; never reinterpret a paid submission as failed. */ });
  };
}
/** Refreshes persisted native jobs without re-submitting; useful when source projects are closed. */
export async function refreshGenerationHistory(): Promise<void> {
  const history = useGenerationHistoryStore.getState();
  await history.initialize();
  const jobs = new Map((await listGenerationJobs(1000)).map(job => [job.job_id, job]));
  for (const record of useGenerationHistoryStore.getState().records) {
    if (!record.nodeId || record.status === 'succeeded' || !record.jobIds?.length) continue;
    const matching = record.jobIds.flatMap(id => jobs.has(id) ? [jobs.get(id)!] : []);
    if (matching.length !== record.jobIds.length) continue;
    const active = matching.find(job => !['succeeded', 'failed', 'not_found', 'canceled'].includes(job.status));
    const failure = matching.find(job => job.status !== 'succeeded');
    await history.update({ id: record.id, status: active?.status ?? failure?.status ?? 'succeeded',
      outputs: matching.flatMap(job => normalizeGenerationJobResults(job)), error: matching.find(job => job.error)?.error ?? undefined });
  }
}
