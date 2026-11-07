import type { GenerationJobState } from '@/commands/ai';
import type { CanvasNodeData, CanvasNodeType } from '@/features/canvas/domain/canvasNodes';
import type { WorkbenchConfig, WorkbenchDraft, WorkbenchKind, WorkbenchReference, WorkbenchTask } from '@/features/workbench/domain/types';
import type { GenerationRequestOptions } from '@/features/canvas/application/generation/types';

export interface HistoryAssetReference { kind: 'image' | 'video' | 'audio' | 'text' | 'model'; source: string; assetId?: string; importedModelId?: string }
export type HistoryReference = WorkbenchReference;
export interface HistoryParams extends Record<string, unknown> {
  kind?: WorkbenchKind;
  config?: WorkbenchConfig;
  referenceSlots?: Record<string, string[]>;
  nodeType?: CanvasNodeType;
  nodeData?: CanvasNodeData;
  tool?: GenerationRequestOptions['tool'];
  count?: number;
}
export interface GenerationHistoryRecord {
  id: string;
  createdAt: number;
  surface: 'canvas' | 'workbench' | 'agent';
  projectId?: string;
  /** Distinguishes a submitted project from a mutable conversation association. */
  projectAttribution?: 'submission' | 'current-conversation';
  currentProjectId?: string | null;
  nodeId?: string;
  conversationId?: string;
  taskId?: string;
  jobIds?: string[];
  resultNodeIds?: string[];
  modelRef: string;
  modeId?: string;
  prompt: string;
  /** Exact assembled prompt retained at submission time; absent on older records. */
  upstreamPrompt?: string;
  params: HistoryParams;
  references: HistoryReference[];
  status: GenerationJobState;
  outputs: HistoryAssetReference[];
  error?: string;
}
export interface HistoryQuery {
  surface?: GenerationHistoryRecord['surface'];
  model?: string;
  status?: GenerationJobState;
  from?: number;
  to?: number;
  projectId?: string;
  text?: string;
}
export function filterGenerationHistory(records: GenerationHistoryRecord[], query: HistoryQuery = {}): GenerationHistoryRecord[] {
  const text = query.text?.trim().toLocaleLowerCase();
  return records.filter(record => (!query.surface || record.surface === query.surface)
    && (!query.model || record.modelRef === query.model) && (!query.status || record.status === query.status)
    && (query.from === undefined || record.createdAt >= query.from) && (query.to === undefined || record.createdAt <= query.to)
    && (!query.projectId || (record.currentProjectId !== undefined ? record.currentProjectId : record.projectId) === query.projectId)
    && (!text || `${record.prompt}\n${record.modelRef}\n${record.error ?? ''}`.toLocaleLowerCase().includes(text)))
    .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
}
export function projectWorkbenchHistory(task: WorkbenchTask, agent = false, conversationProjectId?: string | null): GenerationHistoryRecord {
  const submittedProjectId = task.input.projectId?.trim();
  return { id: `workbench:${task.id}`, taskId: task.id, conversationId: task.conversationId, createdAt: task.createdAt,
    ...(submittedProjectId ? { projectId: submittedProjectId, projectAttribution: 'submission' as const } : conversationProjectId ? { projectId: conversationProjectId, projectAttribution: 'current-conversation' as const } : {}),
    ...(conversationProjectId !== undefined ? { currentProjectId: conversationProjectId } : {}),
    surface: agent ? 'agent' : 'workbench', modelRef: task.input.model, modeId: task.input.channelModeId,
    prompt: task.input.prompt, params: structuredClone({ kind: task.input.kind, config: task.input.config, referenceSlots: task.input.referenceSlots }),
    references: structuredClone(task.input.references ?? []), status: task.status, outputs: structuredClone(task.results),
    jobIds: task.jobId ? [task.jobId] : [], error: task.failure?.message ?? task.job?.error ?? undefined };
}
export type HistorySource = { surface: 'canvas'; projectId?: string; nodeId: string } | { surface: 'workbench'; conversationId: string; taskId: string } | { surface: 'unavailable' };
export function jumpToHistorySource(record: GenerationHistoryRecord): HistorySource {
  if (record.nodeId) return { surface: 'canvas', projectId: record.projectId, nodeId: record.nodeId };
  if (record.conversationId && record.taskId) return { surface: 'workbench', conversationId: record.conversationId, taskId: record.taskId };
  return { surface: 'unavailable' };
}
export type HistoryReuseDraft = { surface: 'workbench'; draft: WorkbenchDraft } | { surface: 'canvas'; nodeType: CanvasNodeType; data: CanvasNodeData; references: HistoryReference[]; options: Pick<GenerationRequestOptions, 'tool' | 'count'> };
export function reuseParams(record: GenerationHistoryRecord): HistoryReuseDraft {
  if (record.params.nodeType && record.params.nodeData) {
    const data = structuredClone(record.params.nodeData);
    for (const key of Object.keys(data)) if (key.startsWith('generation') || ['batchId', 'batchIndex', 'batchTotal', 'resultNodeId', 'lastPreparedPayload', 'lastError', 'lastRunInputHash'].includes(key)) delete data[key];
    // Reuse the original draft, not the compiled prompt (which would append camera/preset text twice).
    if (typeof data.prompt !== 'string') data.prompt = record.prompt;
    if ('isGenerating' in data) data.isGenerating = false;
    if ('isStreaming' in data) data.isStreaming = false;
    return { surface: 'canvas', nodeType: record.params.nodeType, data, references: structuredClone(record.references), options: { tool: structuredClone(record.params.tool), count: record.params.count } };
  }
  return { surface: 'workbench', draft: { kind: record.params.kind ?? 'image', model: record.modelRef, channelModeId: record.modeId,
    prompt: record.prompt, config: structuredClone(record.params.config), referenceSlots: structuredClone(record.params.referenceSlots), references: structuredClone(record.references) } };
}
