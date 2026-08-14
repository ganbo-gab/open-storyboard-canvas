import {
  CANVAS_NODE_TYPES,
  type CanvasEdge,
  type CanvasNode,
} from '../domain/canvasNodes';
import type { CanvasEventBus } from './ports';
import { supportsCanvasGenerationTrigger } from './canvasGenerationTriggers';
import { recoverPersistedGenerationResult, type GenerationRecoveryResult } from './generationRecovery';

export type CanvasGenerationStatus =
  | 'idle'
  | 'queued'
  | 'submitting'
  | 'running'
  | 'recoverable_wait'
  | 'materializing'
  | 'succeeded'
  | 'failed'
  | 'unknown'
  | 'canceled';

export interface CanvasGenerationStatusProjection {
  nodeId: string;
  jobId: string | null;
  jobIds: string[];
  status: CanvasGenerationStatus;
  resultNodeId: string | null;
  resultNodeIds: string[];
  hasResult: boolean;
  error: string | null;
}

export interface CanvasGenerationSubmitResult {
  acceptedNodeIds: string[];
  status: 'accepted';
}

type GenerationData = {
  isGenerating?: unknown;
  generationJobId?: unknown;
  generationLastJobId?: unknown;
  generationJobState?: unknown;
  generationError?: unknown;
  lastError?: unknown;
  resultNodeId?: unknown;
  imageUrl?: unknown;
  videoUrl?: unknown;
  audioUrl?: unknown;
  rawContent?: unknown;
  content?: unknown;
  batchId?: unknown;
  generationStartedAt?: unknown;
};

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function hasGenerationResult(data: GenerationData): boolean {
  return [data.imageUrl, data.videoUrl, data.audioUrl, data.rawContent, data.content]
    .some((value) => typeof value === 'string' && value.length > 0);
}

function projectNodeStatus(node: CanvasNode): CanvasGenerationStatusProjection {
  const data = node.data as GenerationData;
  const error = readString(data.generationError) ?? readString(data.lastError);
  const explicitResultNodeId = readString(data.resultNodeId);
  const hasResult = Boolean(explicitResultNodeId) || hasGenerationResult(data);
  const jobId = readString(data.generationJobId) ?? readString(data.generationLastJobId);
  const explicitJobState = readString(data.generationJobState);
  let status: CanvasGenerationStatus = 'idle';
  if (
    explicitJobState === 'queued'
    || explicitJobState === 'submitting'
    || explicitJobState === 'running'
    || explicitJobState === 'recoverable_wait'
    || explicitJobState === 'materializing'
    || explicitJobState === 'succeeded'
    || explicitJobState === 'failed'
    || explicitJobState === 'unknown'
    || explicitJobState === 'canceled'
  ) {
    status = explicitJobState;
  } else if (error) {
    status = 'failed';
  } else if (data.isGenerating === true) {
    status = jobId ? 'running' : 'queued';
  } else if (hasResult) {
    status = 'succeeded';
  }

  return {
    nodeId: node.id,
    jobId,
    jobIds: jobId ? [jobId] : [],
    status,
    resultNodeId: explicitResultNodeId,
    resultNodeIds: explicitResultNodeId ? [explicitResultNodeId] : [],
    hasResult,
    error,
  };
}

function isGenerationResultNode(node: CanvasNode): boolean {
  return node.type === CANVAS_NODE_TYPES.exportImage
    || node.type === CANVAS_NODE_TYPES.video
    || node.type === CANVAS_NODE_TYPES.audio
    || node.type === CANVAS_NODE_TYPES.jsonCard;
}

function readExplicitResultNodeIds(node: CanvasNode): string[] {
  const data = node.data as GenerationData & { resultNodeIds?: unknown };
  const values = [
    readString(data.resultNodeId),
    ...(Array.isArray(data.resultNodeIds)
      ? data.resultNodeIds.map(readString)
      : []),
  ];
  return values.filter((value): value is string => Boolean(value));
}

function findGenerationResultNodes(
  nodes: CanvasNode[],
  edges: CanvasEdge[],
  sourceNode: CanvasNode,
): CanvasNode[] {
  const resultIds = new Set(readExplicitResultNodeIds(sourceNode));
  edges.forEach((edge) => {
    if (edge.source === sourceNode.id) {
      resultIds.add(edge.target);
    }
  });
  return nodes.filter((node) => resultIds.has(node.id) && isGenerationResultNode(node));
}

/**
 * A reusable generation input can accumulate many historical result nodes.
 * Status follow-through must describe the newest submitted cohort, otherwise
 * one stale historical result can keep a newly completed Agent turn "running"
 * until its outer timeout expires.
 */
function selectLatestGenerationResultCohort(resultNodes: CanvasNode[]): CanvasNode[] {
  const latest = resultNodes[resultNodes.length - 1];
  if (!latest) return [];
  const latestData = latest.data as GenerationData;
  const latestBatchId = readString(latestData.batchId);
  if (latestBatchId) {
    return resultNodes.filter((node) => readString((node.data as GenerationData).batchId) === latestBatchId);
  }
  const latestStartedAt = typeof latestData.generationStartedAt === 'number'
    && Number.isFinite(latestData.generationStartedAt)
    ? latestData.generationStartedAt
    : null;
  if (latestStartedAt !== null) {
    return resultNodes.filter((node) => (node.data as GenerationData).generationStartedAt === latestStartedAt);
  }
  return [latest];
}

function aggregateSourceStatus(
  sourceNode: CanvasNode,
  resultNodes: CanvasNode[],
): CanvasGenerationStatusProjection {
  const sourceProjection = projectNodeStatus(sourceNode);
  const projections = resultNodes.map(projectNodeStatus);
  const latestProjection = projections[projections.length - 1];
  const jobIds = Array.from(new Set([
    ...sourceProjection.jobIds,
    ...projections.flatMap((projection) => projection.jobIds),
  ]));
  const resultNodeIds = resultNodes.map((node) => node.id);
  const error = sourceProjection.error
    ?? projections.find((projection) => projection.error)?.error
    ?? null;
  const allProjections = [sourceProjection, ...projections];
  let status: CanvasGenerationStatus = 'idle';
  if (allProjections.some((projection) => projection.status === 'unknown')) {
    status = 'unknown';
  } else if (allProjections.some((projection) => projection.status === 'running')) {
    status = 'running';
  } else if (allProjections.some((projection) => projection.status === 'submitting')) {
    status = 'submitting';
  } else if (allProjections.some((projection) => projection.status === 'recoverable_wait')) {
    status = 'recoverable_wait';
  } else if (allProjections.some((projection) => projection.status === 'materializing')) {
    status = 'materializing';
  } else if (allProjections.some((projection) => projection.status === 'queued')) {
    status = 'queued';
  } else if (allProjections.some((projection) => projection.status === 'failed')) {
    status = 'failed';
  } else if (allProjections.some((projection) => projection.status === 'succeeded')) {
    status = 'succeeded';
  }

  return {
    nodeId: sourceNode.id,
    jobId: sourceProjection.status !== 'idle' && sourceProjection.status !== 'succeeded'
      ? sourceProjection.jobId
      : latestProjection?.jobId ?? sourceProjection.jobId ?? jobIds[jobIds.length - 1] ?? null,
    jobIds,
    status,
    resultNodeId: latestProjection?.nodeId ?? null,
    resultNodeIds,
    hasResult: projections.some((projection) => projection.hasResult),
    error,
  };
}

export class CanvasGenerationFacade {
  constructor(private readonly eventBus: CanvasEventBus) {}

  supportsNode(node: CanvasNode): boolean {
    return supportsCanvasGenerationTrigger(node.type);
  }

  submit(nodeIds: string[], nodes: CanvasNode[]): CanvasGenerationSubmitResult {
    const nodeById = new Map(nodes.map((node) => [node.id, node] as const));
    const acceptedNodeIds: string[] = [];

    for (const nodeId of Array.from(new Set(nodeIds))) {
      const node = nodeById.get(nodeId);
      if (!node || !this.supportsNode(node)) {
        continue;
      }
      this.eventBus.publish('generation-node/trigger', { nodeId });
      acceptedNodeIds.push(nodeId);
    }

    return { acceptedNodeIds, status: 'accepted' };
  }

  async recover(jobId: string, nodeIds?: string[]): Promise<GenerationRecoveryResult> {
    return await recoverPersistedGenerationResult({ jobId, nodeIds });
  }

  getStatus(
    nodes: CanvasNode[],
    edges: CanvasEdge[],
    input: { nodeId?: string; jobId?: string },
  ): CanvasGenerationStatusProjection | null {
    const node = input.nodeId
      ? nodes.find((candidate) => candidate.id === input.nodeId)
      : nodes.find((candidate) => {
        const data = candidate.data as GenerationData;
        return readString(data.generationJobId) === input.jobId
          || readString(data.generationLastJobId) === input.jobId;
      });
    if (!node) {
      return null;
    }

    if (this.supportsNode(node)) {
      const resultNodes = findGenerationResultNodes(nodes, edges, node);
      if (input.jobId && ![node, ...resultNodes].some((candidate) => {
        const data = candidate.data as GenerationData;
        return readString(data.generationJobId) === input.jobId
          || readString(data.generationLastJobId) === input.jobId;
      })) {
        return null;
      }
      if (resultNodes.length > 0) {
        return aggregateSourceStatus(node, selectLatestGenerationResultCohort(resultNodes));
      }
    }
    return projectNodeStatus(node);
  }

  locateResultNodeId(
    nodes: CanvasNode[],
    edges: CanvasEdge[],
    input: { nodeId?: string; jobId?: string },
  ): string | null {
    const status = this.getStatus(nodes, edges, input);
    if (!status) {
      return null;
    }
    if (status.resultNodeId && nodes.some((node) => node.id === status.resultNodeId)) {
      return status.resultNodeId;
    }
    return status.hasResult ? status.nodeId : null;
  }
}
