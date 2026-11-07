import { normalizeGenerationJobResults, type GenerationJobStatus, type GenerationJobResult } from '@/commands/ai';
import { useCanvasStore, type CanvasNode, type CanvasNodeData } from '@/stores/canvasStore';
import { CANVAS_NODE_TYPES, EXPORT_RESULT_NODE_DEFAULT_WIDTH, EXPORT_RESULT_NODE_LAYOUT_HEIGHT } from '../../domain/canvasNodes';
import { generationCanvasMutations } from './canvasMutations';

export function isGenerationResultNode(node: CanvasNode): boolean {
  return [CANVAS_NODE_TYPES.exportImage, CANVAS_NODE_TYPES.video, CANVAS_NODE_TYPES.audio, CANVAS_NODE_TYPES.jsonCard, CANVAS_NODE_TYPES.panorama, CANVAS_NODE_TYPES.blueprint]
    .some((type) => type === node.type);
}
function hasJob(node: CanvasNode, jobId: string): boolean {
  const data = node.data as Record<string, unknown>;
  return data.generationJobId === jobId || data.generationLastJobId === jobId;
}
function nodeType(kind: GenerationJobResult['kind']) {
  return kind === 'image' ? CANVAS_NODE_TYPES.exportImage : kind === 'video' ? CANVAS_NODE_TYPES.video
    : kind === 'audio' ? CANVAS_NODE_TYPES.audio : kind === 'model' ? CANVAS_NODE_TYPES.blueprint : CANVAS_NODE_TYPES.jsonCard;
}
function resultPatch(result: GenerationJobResult, existing?: CanvasNode): Partial<CanvasNodeData> {
  if (result.kind === 'image') return { imageUrl: result.source, previewImageUrl: result.source };
  if (result.kind === 'video') return { videoUrl: result.source, localVideoUrl: result.source };
  if (result.kind === 'audio') return { audioUrl: result.source, localAudioUrl: result.source };
  if (result.kind === 'model') {
    const importedModelId = result.importedModelId ?? result.source;
    const items = (existing?.data as { items?: { importedModelId?: string }[] } | undefined)?.items;
    if (items?.some((item) => item.importedModelId === importedModelId)) return {};
    return { items: [{ id: `model:${importedModelId}`, label: '模型', x: 0, y: 0, color: '#b8b8b8', importedModelId }] };
  }
  return { rawContent: result.source, parsedJson: null, isStreaming: false };
}

/** Already-materialized outputs are projected once per job, including mixed-media tail frames. */
export function publishGenerationJobResults(anchorId: string, job: GenerationJobStatus): string[] {
  const state = useCanvasStore.getState();
  const anchor = state.nodes.find((node) => node.id === anchorId);
  // A withdrawn/deleted placeholder is not permission to resurrect its results.
  if (!anchor) return [];
  if (!isGenerationResultNode(anchor)) throw new Error(`结果节点 ${anchorId} 类型已变化，未报告成功。`);
  const results = normalizeGenerationJobResults(job);
  if (!results.length) throw new Error('结果已取回，但本机媒体路径为空，未报告成功。');
  const agentTurnId = typeof anchor.data.generationAgentTurnId === 'string' ? anchor.data.generationAgentTurnId : undefined;
  const mutations = generationCanvasMutations(agentTurnId);
  const associated = state.nodes.filter((node) => isGenerationResultNode(node) && hasJob(node, job.job_id));
  const anchorData = anchor.data as Record<string, unknown>;
  const sourceId = state.edges.find((edge) => edge.target === anchorId)?.source;
  const batchId = typeof anchorData.batchId === 'string' ? anchorData.batchId : job.job_id;
  const existing = new Map<number, CanvasNode>();
  for (const [index, node] of associated.entries()) {
    const data = node.data as Record<string, unknown>;
    const resultIndex = associated.length > 1 && Number.isInteger(data.batchIndex) ? Number(data.batchIndex) : index;
    existing.set(resultIndex, node);
  }
  const nodeIds: string[] = [];
  for (const [index, result] of results.entries()) {
    let node = existing.get(index);
    const common: Partial<CanvasNodeData> = {
      isGenerating: false, generationJobState: 'succeeded', generationStartedAt: null,
      generationJobPhase: 'done', generationLastJobId: job.job_id, generationJobId: null,
      generationProviderId: null, generationClientSessionId: null,
      generationError: null, generationErrorDetails: null, generationRetryResultUrl: null,
      generationFailure: null,
      generationRetryRequestedAt: null, generationSafeRecoveryAvailable: false,
      generationJobUpdatedAt: job.updated_at ?? Date.now(),
      sourcePrompt: typeof anchorData.sourcePrompt === 'string' ? anchorData.sourcePrompt : '',
      ...(results.length > 1 ? { batchId, batchIndex: index, batchTotal: results.length } : {}),
      ...resultPatch(result, node),
    };
    if (!node) {
      const id = mutations.addNode(nodeType(result.kind), state.findNodePosition(anchorId, EXPORT_RESULT_NODE_DEFAULT_WIDTH, EXPORT_RESULT_NODE_LAYOUT_HEIGHT), common);
      if (sourceId) mutations.addEdge(sourceId, id, { provenance: 'generationResult' });
      nodeIds.push(id);
      continue;
    }
    const sameKind = node.type === nodeType(result.kind) || (result.kind === 'image' && node.type === CANVAS_NODE_TYPES.panorama);
    if (sameKind) mutations.updateNodeData(node.id, common);
    else mutations.replaceNodeType(node.id, nodeType(result.kind), { ...node.data, ...common });
    nodeIds.push(node.id);
  }
  return nodeIds;
}
