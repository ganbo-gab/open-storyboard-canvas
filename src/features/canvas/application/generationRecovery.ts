import type { GenerationJobStatus } from '@/commands/ai';
import { useCanvasStore } from '@/stores/canvasStore';
import { recoverCustomProviderJob } from '../infrastructure/customProviderGateway';

export interface GenerationRecoveryResult {
  job: GenerationJobStatus;
  nodeIds: string[];
  status: 'succeeded';
  policy: 'poll-download-persist-only';
}

function projectRecoveredResult(
  nodeId: string,
  jobId: string,
  job: GenerationJobStatus,
): void {
  const result = typeof job.result === 'string' ? job.result.trim() : '';
  if (!result) throw new Error('结果已取回，但本机媒体路径为空，未报告成功。');
  if (job.media_type !== 'image' && job.media_type !== 'video') {
    throw new Error('该任务的媒体类型不支持安全结果投影，未报告成功。');
  }

  const node = useCanvasStore.getState().nodes.find((candidate) => candidate.id === nodeId);
  if (!node) throw new Error(`结果节点 ${nodeId} 已不存在，未报告成功。`);
  const currentData = node.data as Record<string, unknown>;
  const base = {
    isGenerating: false,
    generationJobState: 'succeeded' as const,
    generationStartedAt: null,
    generationJobPhase: 'materialize',
    generationLastJobId: jobId,
    generationJobId: null,
    generationError: null,
    generationErrorDetails: null,
    generationRetryResultUrl: null,
    generationRetryRequestedAt: null,
    generationSafeRecoveryAvailable: false,
    generationJobUpdatedAt: job.updated_at ?? Date.now(),
  };
  if (job.media_type === 'video') {
    useCanvasStore.getState().updateNodeData(nodeId, {
      ...base,
      videoUrl: result,
      localVideoUrl: result,
    });
    return;
  }
  useCanvasStore.getState().updateNodeData(nodeId, {
    ...base,
    imageUrl: result,
    previewImageUrl: result,
    ...(typeof currentData.aspectRatio === 'string' ? { aspectRatio: currentData.aspectRatio } : {}),
  });
}

function nodeJobIds(node: ReturnType<typeof useCanvasStore.getState>['nodes'][number]): string[] {
  const data = node.data as Record<string, unknown>;
  return [data.generationJobId, data.generationLastJobId]
    .filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
    .map((value) => value.trim());
}

export async function recoverPersistedGenerationResult(input: {
  jobId: string;
  nodeIds?: string[];
}): Promise<GenerationRecoveryResult> {
  const jobId = input.jobId.trim();
  if (!jobId) throw new Error('安全取回需要有效的 jobId。');
  const requested = input.nodeIds?.length ? new Set(input.nodeIds) : null;
  const linkedNodes = useCanvasStore.getState().nodes.filter((node) => (
    nodeJobIds(node).includes(jobId) && (!requested || requested.has(node.id))
  ));
  if (linkedNodes.length === 0) {
    throw new Error('当前画布没有与该 jobId 关联的结果节点，未执行网络请求。');
  }
  if (requested && linkedNodes.length !== requested.size) {
    throw new Error('请求中的节点与持久任务不匹配，未执行网络请求。');
  }

  const job = await recoverCustomProviderJob(jobId);
  if (job.status !== 'succeeded' || !job.result) {
    throw new Error(job.error || '已查询上游任务，但结果尚未成功保存到本机。');
  }

  for (const node of linkedNodes) {
    projectRecoveredResult(node.id, jobId, job);
  }
  return {
    job,
    nodeIds: linkedNodes.map((node) => node.id),
    status: 'succeeded',
    policy: 'poll-download-persist-only',
  };
}
