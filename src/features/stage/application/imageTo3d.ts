import type { GenerationJobStatus } from '@/commands/ai';
import { resolveAsset, saveAsset } from '@/features/assets/application/assetCatalog';
import { buildCanvasAssetCatalog } from '@/features/canvas/application/canvasAssetCatalog';
import { modelGenerationModes } from '@/features/channels/application/modelGenerationCatalog';
import type { JsonValue } from '@/features/channels/domain/profile';
import { getChannelJobAsync, recoverChannelJob, submitChannelJob, subscribeChannelJob, waitForChannelJob } from '@/features/channels/runtime/channelExecution';
import type { JobInput, JobRef } from '@/features/channels/runtime/types';
import { useChannelStore } from '@/features/channels/store/channelStore';
import { useCanvasStore } from '@/stores/canvasStore';

export type ImageTo3dPhase = 'submit' | 'poll' | 'download' | 'import';
export interface ImageTo3dProgress { phase: ImageTo3dPhase; jobId?: string }
export interface ImageTo3dOptions { signal?: AbortSignal; onProgress?: (progress: ImageTo3dProgress) => void }
export interface ImageTo3dRequest {
  channelModelRef: { profileId: string; modelId: string };
  modeId?: string;
  /** Existing canvas/global-library image ids; explicit multi-slot modes require slot assignment. */
  imageRefs: (string | { assetId: string; slot?: string })[];
  params: Record<string, JsonValue>;
}
export interface ImageTo3dResult { importedModelId: string; previewAssetId?: string; jobId: string }
export class ImageTo3dJobError extends Error {
  constructor(message: string, readonly jobId?: string, readonly code?: string) { super(message); this.name = 'ImageTo3dJobError'; }
}

async function consumeModelJob(jobId: string, options: ImageTo3dOptions, recover: boolean): Promise<ImageTo3dResult> {
  const report = (job: GenerationJobStatus) => {
    if (['submit', 'poll', 'download', 'import'].includes(job.phase ?? '')) options.onProgress?.({ phase: job.phase as ImageTo3dPhase, jobId });
  };
  const unsubscribe = subscribeChannelJob(jobId, report);
  try {
    options.signal?.throwIfAborted();
    if (recover) await recoverChannelJob(jobId, options.signal);
    report(await getChannelJobAsync(jobId));
    const job = await waitForChannelJob(jobId, options.signal);
    options.signal?.throwIfAborted();
    if (job.media_type !== 'model') throw new ImageTo3dJobError('此任务不是模型生成任务。', jobId, 'validation');
    if (job.status !== 'succeeded') throw new ImageTo3dJobError(job.error || '模型生成尚未完成，请查询原任务；不会重新提交。', jobId, job.error_category ?? job.status);
    const model = job.results?.find((result) => result.kind === 'model');
    const importedModelId = model?.importedModelId ?? model?.source;
    if (!importedModelId) throw new ImageTo3dJobError('任务没有可用的模型库结果。', jobId, 'invalid_model');
    const preview = job.results?.find((result) => result.kind === 'image');
    let previewAssetId: string | undefined;
    if (preview) {
      options.signal?.throwIfAborted();
      previewAssetId = (await saveAsset({ id: `model-preview:${jobId}`, kind: 'image', source: preview.source,
        name: '生成模型预览', origin: 'generated', metadata: { jobId, importedModelId } })).id;
    }
    options.signal?.throwIfAborted();
    return { importedModelId, ...(previewAssetId ? { previewAssetId } : {}), jobId };
  } catch (error) {
    if (error instanceof ImageTo3dJobError) throw error;
    throw new ImageTo3dJobError(options.signal?.aborted ? '已停止模型生成等待与下载；已提交的上游任务可能仍在计费，可凭原任务 ID 查询。' : error instanceof Error ? error.message : String(error), jobId,
      options.signal?.aborted ? 'canceled' : undefined);
  } finally { unsubscribe(); }
}

/** No vendor defaults and no paid retries: only the explicitly selected declaration is submitted. */
export async function generateModelFromImage(request: ImageTo3dRequest, options: ImageTo3dOptions = {}): Promise<ImageTo3dResult> {
  options.signal?.throwIfAborted();
  const profile = useChannelStore.getState().channels.find((entry) => entry.origin === 'native' && entry.profile.id === request.channelModelRef.profileId)?.profile;
  if (!profile) throw new ImageTo3dJobError('渠道配置不存在，请重新选择模型。', undefined, 'validation');
  const model = profile.models.find((entry) => entry.id === request.channelModelRef.modelId);
  const modes = modelGenerationModes(profile, request.channelModelRef.modelId);
  const mode = request.modeId ? modes.find((entry) => entry.mode.id === request.modeId) : modes[0];
  if (!model || !mode) throw new ImageTo3dJobError('所选模型或模式未声明 model.generate 输出。', undefined, 'validation');
  if (!request.imageRefs.length) throw new ImageTo3dJobError('请至少选择一张参考图。', undefined, 'validation');
  const imageSlots = mode.slots.filter((slot) => slot.kind === 'image' && slot.max > 0);
  const canvasAssets = buildCanvasAssetCatalog(useCanvasStore.getState().nodes);
  const refs: JobRef[] = await Promise.all(request.imageRefs.map(async (ref) => {
    options.signal?.throwIfAborted();
    const id = typeof ref === 'string' ? ref : ref.assetId;
    const slot = typeof ref === 'string' ? undefined : ref.slot;
    if (model.modes && !slot && imageSlots.length !== 1) throw new ImageTo3dJobError('请为多槽位模式明确分配参考图。', undefined, 'validation');
    const canvas = canvasAssets.find((asset) => asset.id === id && asset.kind === 'image');
    const library = canvas ? null : await resolveAsset(id);
    const path = canvas?.url ?? (library?.kind === 'image' ? library.source : undefined);
    if (!path) throw new ImageTo3dJobError(`参考图不存在：${id}`, undefined, 'validation');
    return { kind: 'image', assetId: id, path, mime: /^data:([^;,]+)/.exec(path)?.[1] ?? 'image/png',
      ...(model.modes ? { slot: slot ?? imageSlots[0]?.key } : {}) };
  }));
  options.signal?.throwIfAborted();
  const input: JobInput = { jobId: '', channelId: profile.id, modelId: model.id, ...(model.modes ? { modeId: mode.mode.id } : {}),
    operation: 'model.generate', prompt: '', params: request.params, refs, count: 1 };
  options.onProgress?.({ phase: 'submit' });
  const jobId = await submitChannelJob(profile, input, undefined, options.signal);
  options.onProgress?.({ phase: 'submit', jobId });
  return await consumeModelJob(jobId, options, false);
}

/** Reload recovery only queries/materializes the original job; input images and prompts are not needed. */
export async function recoverModelFromImage(jobId: string, options: ImageTo3dOptions = {}): Promise<ImageTo3dResult> {
  return await consumeModelJob(jobId, options, true);
}
