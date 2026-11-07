import { normalizeGenerationJobResults, type GenerationJobStatus } from '@/commands/ai';
import { useCanvasStore } from '@/stores/canvasStore';
import { recoverCustomProviderJob } from '../infrastructure/providerGateway';
import { isGenerationResultNode, publishGenerationJobResults } from './generation/publishJobResults';

export interface GenerationRecoveryResult {
  job: GenerationJobStatus;
  nodeIds: string[];
  status: 'succeeded';
  policy: 'poll-download-persist-only';
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
  const anchor = linkedNodes.find(isGenerationResultNode);
  if (!anchor) throw new Error('当前画布没有与该 jobId 关联的结果节点，未执行网络请求。');

  const job = await recoverCustomProviderJob(jobId);
  if (job.status !== 'succeeded' || !normalizeGenerationJobResults(job).length) {
    throw new Error(job.error || '已查询上游任务，但结果尚未成功保存到本机。');
  }

  const nodeIds = publishGenerationJobResults(anchor.id, job);
  return {
    job,
    nodeIds,
    status: 'succeeded',
    policy: 'poll-download-persist-only',
  };
}
