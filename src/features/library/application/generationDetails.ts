import { isTauri } from '@tauri-apps/api/core';
import { z } from 'zod';
import { getGenerationJobRecord, normalizeGenerationJobResults, type GenerationJobStatus } from '@/commands/ai';
import { useCanvasStore } from '@/stores/canvasStore';
import { useProjectStore } from '@/stores/projectStore';
import { useWorkbenchStore } from '@/features/workbench/store/workbenchStore';
import { useGenerationHistoryStore } from '../history/historyStore';
import { jumpToHistorySource, projectWorkbenchHistory, type GenerationHistoryRecord, type HistoryAssetReference, type HistorySource } from '../history/history';
import { readBrowserJobRecord, readBrowserJobRecords } from '@/features/channels/runtime/browserJobRecords';
import { getCustomProviderJob } from '@/features/canvas/infrastructure/providerGateway';
import { sanitizeGenerationDiagnosticText } from '@/features/canvas/application/generationErrorReport';
import { redactSensitiveValue } from '@/features/canvas/agent/application/agentRedaction';
import { readGenerationConfiguration } from '@/features/canvas/domain/generationConfiguration';

export interface GenerationDetailsTarget { recordId?: string; jobId?: string; nodeId?: string; taskId?: string }
export interface GenerationDetailFact { key: string; value?: string | number | null }
export interface GenerationDetailData {
  record?: GenerationHistoryRecord;
  source: HistorySource;
  prompt?: string;
  upstreamPrompt?: string;
  facts: GenerationDetailFact[];
  jobs: GenerationJobStatus[];
  outputs: HistoryAssetReference[];
  records: GenerationHistoryRecord[];
  errors: string[];
  diagnostics: string;
}
export interface HistoryDiagnosticProjection { id: string; occurredAt: number; severity: 'info' | 'warning' | 'error'; source: 'generation'; category: string; message: string; jobId?: string; nodeIds?: string[]; recoverable: boolean }
/** Existing history is also useful in browser-only logs, without a second log store. */
export function projectHistoryDiagnostics(records: readonly GenerationHistoryRecord[]): HistoryDiagnosticProjection[] {
  return records.map((record) => ({ id: `history:${record.id}`, occurredAt: record.createdAt,
    severity: record.status === 'failed' || record.status === 'unknown' ? 'error' : record.status === 'recoverable_wait' ? 'warning' : 'info',
    source: 'generation', category: record.status,
    message: sanitizeGenerationDiagnosticText(record.error || `${record.status} · ${record.modelRef}`),
    jobId: record.jobIds?.[0], nodeIds: record.nodeId ? [record.nodeId] : record.resultNodeIds,
    recoverable: false }));
}
const objectSchema = z.record(z.string(), z.unknown());
const snapshotSchema = z.object({
  version: z.literal(2), adapter: z.string(),
  profile: z.object({ name: z.string().optional(), id: z.string().optional(), baseUrl: z.string().optional() }).optional(),
  input: z.object({ modelId: z.string().optional(), modeId: z.string().optional(), operation: z.string().optional(), count: z.number().optional(), params: objectSchema.optional() }).optional(),
  failure: z.object({ message: z.string().optional(), raw: z.string().optional(), status: z.number().optional() }).optional(),
  assets: z.array(z.string()).optional(), assetKinds: z.array(z.enum(['image', 'video', 'audio', 'model', 'text'])).optional(),
  outputs: z.array(z.object({ kind: z.enum(['image', 'video', 'audio', 'model', 'text']), url: z.string().optional(), text: z.string().optional() })).optional(),
});
const scalar = (value: unknown): string | number | undefined => typeof value === 'string' && value.trim() ? value : typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const recordOf = (value: unknown): Record<string, unknown> => objectSchema.safeParse(value).data ?? {};
export const redactGenerationDetails = (value: unknown): string => sanitizeGenerationDiagnosticText(JSON.stringify(redactSensitiveValue(value), null, 2)).replace(/__SC_SECRET_[A-Za-z0-9_-]+__/g, '[credential reference]');

/** Reads local records only. Opening details never polls or sends a provider request. */
export async function loadGenerationDetails(target: GenerationDetailsTarget): Promise<GenerationDetailData> {
  await useGenerationHistoryStore.getState().initialize();
  const records = useGenerationHistoryStore.getState().records;
  const node = target.nodeId ? useCanvasStore.getState().nodes.find((entry) => entry.id === target.nodeId) : undefined;
  const nodeData = node?.data;
  const task = target.taskId ? useWorkbenchStore.getState().tasks[target.taskId] : undefined;
  const linkedIds = [target.jobId, nodeData?.generationJobId, nodeData?.generationLastJobId].filter((value): value is string => typeof value === 'string' && !!value);
  const matches = records.filter((record) => record.id === target.recordId || (target.taskId && record.taskId === target.taskId)
    || (target.nodeId && (record.nodeId === target.nodeId || record.resultNodeIds?.includes(target.nodeId))) || record.jobIds?.some((id) => linkedIds.includes(id)))
    .sort((a, b) => b.createdAt - a.createdAt);
  const record = target.recordId ? matches.find((entry) => entry.id === target.recordId) : target.jobId
    ? matches.find((entry) => entry.jobIds?.includes(target.jobId!)) : task ? projectWorkbenchHistory(task, false, useWorkbenchStore.getState().conversations[task.conversationId]?.projectId) : matches[0];
  const jobIds = [...new Set([...(record?.jobIds ?? []), ...(target.jobId ? [target.jobId] : []), ...(record ? [] : linkedIds)])];
  const errors: string[] = [];
  const jobs = (await Promise.all(jobIds.map(async (id) => {
    try {
      if (isTauri()) return await getGenerationJobRecord(id);
      const memory = getCustomProviderJob(id);
      const key = id.startsWith('custom-local-channel-job-') ? 'channel-generation-jobs-v2' : id.startsWith('custom-local-comfy-v2-') ? 'comfy-channel-generation-jobs-v2' : undefined;
      const saved = key ? readBrowserJobRecord(readBrowserJobRecords(key), id) : undefined;
      return memory.status !== 'not_found' ? { ...saved, ...memory } : saved;
    } catch (cause) { errors.push(sanitizeGenerationDiagnosticText(cause instanceof Error ? cause.message : String(cause))); return undefined; }
  }))).filter((entry): entry is GenerationJobStatus => Boolean(entry));
  return projectGenerationDetails({ record, records: matches, jobs, target, currentNodeName: typeof nodeData?.displayName === 'string' ? nodeData.displayName : undefined,
    currentJobId: typeof nodeData?.generationJobId === 'string' ? nodeData.generationJobId : undefined,
    projectName: useProjectStore.getState().projects.find((project) => project.id === record?.projectId)?.name, currentProjectName: useProjectStore.getState().projects.find((project) => project.id === record?.currentProjectId)?.name, errors });
}

export function projectGenerationDetails({ record, records = [], jobs, target, currentNodeName, currentJobId, projectName, currentProjectName, errors = [] }: {
  record?: GenerationHistoryRecord; records?: GenerationHistoryRecord[]; jobs: GenerationJobStatus[]; target: GenerationDetailsTarget;
  currentNodeName?: string; currentJobId?: string; projectName?: string; currentProjectName?: string; errors?: string[];
}): GenerationDetailData {
  const snapshots = jobs.map((job) => snapshotSchema.safeParse(job.poll_descriptor).data);
  const snapshot = snapshots.find(Boolean); const job = jobs[0];
  const request = recordOf(record?.params.request); const config = record?.params.config;
  const params = snapshot?.input?.params ?? {};
  const extras = recordOf(request.extraParams ?? config?.extraParams);
  const nodeSnapshot = record?.params.nodeData;
  // Read only this attempt's frozen evidence. Current canvas/catalog settings
  // cannot repair or overwrite a historical request.
  const capturedConfiguration = readGenerationConfiguration(nodeSnapshot);
  const requestConfiguration = readGenerationConfiguration({ modelConfig: {
    entryId: 'recorded-request', extraParams: extras,
    ratio: scalar(request.aspectRatio) ?? scalar(config?.aspectRatio),
    resolution: scalar(request.size) ?? scalar(config?.size),
  } });
  const jobConfiguration = readGenerationConfiguration({ modelConfig: { entryId: 'recorded-job', extraParams: params } });
  const declared = (keys: readonly string[]) => { for (const values of [extras, params]) for (const key of keys) { const value = scalar(values[key]); if (value !== undefined) return value; } return undefined; };
  const prompt = typeof record?.params.nodeData?.prompt === 'string' ? record.params.nodeData.prompt : record?.prompt;
  // Only canvas capture records explicitly tagged assembled request context can
  // claim a submitted prompt. Workbench's user prompt is not renamed upstreamPrompt.
  const upstreamPrompt = record?.upstreamPrompt;
  const outputMap = new Map<string, HistoryAssetReference>();
  for (const output of record?.outputs ?? []) outputMap.set(`${output.kind}:${output.source}`, output);
  // The history/task owns its materialized results. Job URLs may be alternate
  // representations of those exact outputs, not additional generated media.
  if (!record?.outputs.length) jobs.forEach((entry, jobIndex) => {
    if (entry.status !== 'succeeded') return;
    const parsed = snapshots[jobIndex];
    const projected = normalizeGenerationJobResults(entry);
    for (const output of projected) if (!output.source.startsWith('blob:') || entry.results?.length) outputMap.set(`${output.kind}:${output.source}`, output);
    if (!entry.results?.length && parsed?.assets) parsed.assets.forEach((source, index) => {
      if (source.startsWith(`${entry.job_id}:`)) return; // IndexedDB key is not a display URL.
      const kind = parsed.assetKinds?.[index] ?? parsed.outputs?.[index]?.kind ?? (entry.media_type === 'video' ? 'video' : 'image');
      outputMap.set(`${kind}:${source}`, { kind, source });
    });
  });
  const combinedErrors = [...errors, record?.error, ...jobs.flatMap((entry, index) => [entry.error, entry.error_raw, snapshots[index]?.failure?.raw])]
    .filter((value): value is string => Boolean(value)).map((value) => sanitizeGenerationDiagnosticText(redactSensitiveValue(value)));
  const facts: GenerationDetailFact[] = [
    { key: 'source', value: record?.surface }, { key: 'project', value: record?.projectAttribution === 'current-conversation' ? undefined : projectName ?? record?.projectId }, { key: 'node', value: scalar(nodeSnapshot?.displayName) ?? record?.nodeId ?? target.nodeId },
    ...(record?.conversationId ? [{ key: 'currentProject', value: record.currentProjectId === null ? null : currentProjectName ?? record.currentProjectId ?? (record.projectAttribution === 'current-conversation' ? projectName ?? record.projectId : undefined) }] : []),
    { key: 'currentNode', value: currentNodeName },
    { key: 'channel', value: snapshot?.profile?.name ?? job?.provider_id }, { key: 'model', value: scalar(request.model) ?? scalar(snapshot?.input?.modelId) ?? scalar(job?.model_id) ?? scalar(record?.modelRef) ?? capturedConfiguration.model },
    { key: 'mode', value: snapshot?.input?.modeId ?? record?.modeId },
    { key: 'ratio', value: requestConfiguration.aspectRatio ?? jobConfiguration.aspectRatio ?? capturedConfiguration.aspectRatio },
    { key: 'size', value: requestConfiguration.size ?? jobConfiguration.size ?? capturedConfiguration.size },
    { key: 'duration', value: scalar(config?.seconds ?? declared(['duration', 'seconds'])) },
    { key: 'count', value: scalar(record?.params.count ?? extras.count ?? extras.n ?? snapshot?.input?.count) },
    { key: 'quality', value: scalar(params.quality ?? extras.quality) }, { key: 'seed', value: scalar(params.seed ?? extras.seed) },
    { key: 'references', value: record ? record.params.referenceSlots !== undefined ? Object.values(record.params.referenceSlots).reduce((count, sources) => count + sources.length, 0) + record.references.filter((reference) => reference.kind === 'text').length : record.references.length : undefined }, { key: 'results', value: outputMap.size },
    { key: 'status', value: job?.status ?? record?.status }, { key: 'phase', value: job?.phase },
    { key: 'submittedAt', value: record?.createdAt ?? job?.created_at }, { key: 'updatedAt', value: job?.updated_at },
    { key: 'currentTask', value: currentJobId }, { key: 'record', value: record?.id },
  ];
  const source = record ? jumpToHistorySource(record) : target.nodeId ? { surface: 'canvas' as const, nodeId: target.nodeId } : { surface: 'unavailable' as const };
  const diagnostics = redactGenerationDetails({ record: record && { id: record.id, createdAt: record.createdAt, surface: record.surface, projectId: record.projectId, projectAttribution: record.projectAttribution, currentProjectId: record.currentProjectId, nodeId: record.nodeId,
    taskId: record.taskId, model: record.modelRef, mode: record.modeId,
    params: { config: record.params.config, count: record.params.count, tool: record.params.tool, request: record.params.request,
      node: nodeSnapshot && { nodeType: record.params.nodeType, displayAspectRatio: nodeSnapshot.imageUrl || nodeSnapshot.previewImageUrl ? nodeSnapshot.aspectRatio : undefined,
        generationConfiguration: { ...capturedConfiguration, meaning: 'configuration-at-capture' } } },
    references: record.references.map(({ source: _source, ...ref }) => ref) },
    jobs: jobs.map((entry) => ({ jobId: entry.job_id, upstreamTaskId: entry.external_task_id, status: entry.status, phase: entry.phase, provider: entry.provider_id,
      model: entry.model_id, route: entry.network_route, attempts: entry.submit_attempts, updatedAt: entry.updated_at, error: entry.error, upstreamError: entry.error_raw })), errors: combinedErrors });
  return { record, source, prompt, upstreamPrompt, facts, jobs, outputs: [...outputMap.values()], records, errors: [...new Set(combinedErrors)], diagnostics };
}
