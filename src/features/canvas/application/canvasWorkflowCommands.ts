import { z } from 'zod';
import {
  CANVAS_NODE_TYPES,
  type BlueprintItem,
  type BlueprintNodeData,
  type CanvasNode,
  type CanvasNodeData,
  type PanoramaNodeData,
  type StoryboardExportOptions,
  type StoryboardSplitNodeData,
  type StoryboardFrameItem,
} from '../domain/canvasNodes';
import type {
  CanvasCommandImpact,
  CanvasCommandOutput,
  CanvasDirectorItemInput,
  UpdateDirectorCommand,
  MergeStoryboardCommand,
  UpdatePanoramaCommand,
  UpdateStoryboardCommand,
} from '../domain/canvasCommands';
import { buildCanvasAssetCatalog } from './canvasAssetCatalog';
import { normalizeDirectorMotionProject } from './directorMotion';
import type {
  CanvasGraphCommandPreparation,
  CanvasGraphDraft,
} from './canvasTransactionCoordinator';

import type { NodeFactory } from './ports';
import { isDurableCanvasImageSource } from '../domain/canvasMediaSources';
import { findRelatedCanvasNodePositions } from './canvasNodePlacement';
import { resolveAbsoluteNodePosition } from '../clipboard/clipboardIO';
import type { ProjectMediaReference } from '../domain/projectMedia';
import { normalizeAssetMetadata } from '@/features/assets/application/assetMetadata';

const missingMediaReferenceSchema = z.object({
  status: z.literal('missing'), source: z.string(),
  reason: z.enum(['unavailable-blob', 'unresolved-image-pool', 'unresolved-asset-id', 'persistence-failed']),
  message: z.string().optional(),
});
const mediaReferenceSchema = z.discriminatedUnion('status', [
  missingMediaReferenceSchema,
  z.object({ status: z.literal('ready'), source: z.string(), assetId: z.string().min(1),
    legacyMissing: missingMediaReferenceSchema.optional() }),
]);

const storyboardImageSourceSchema = z.object({
  imageUrl: z.string().refine(isDurableCanvasImageSource),
  previewImageUrl: z.string().nullish(),
  aspectRatio: z.string().optional(),
  displayName: z.string().optional(),
  sourceFileName: z.string().nullish(),
  assetId: z.string().optional(),
  mediaReferences: z.record(z.string(), z.unknown()).optional(),
  generationProviderId: z.string().nullish(),
  providerId: z.string().optional().catch(undefined),
  requestModel: z.string().optional().catch(undefined),
  generationDebugContext: z.object({
    providerId: z.string().optional(), requestModel: z.string().optional(), requestSize: z.string().optional(),
  }).nullish().catch(undefined),
});

const storyboardImageNodeTypes: Partial<Record<CanvasNode['type'], true>> = {
  [CANVAS_NODE_TYPES.upload]: true,
  [CANVAS_NODE_TYPES.exportImage]: true,
  [CANVAS_NODE_TYPES.imageEdit]: true,
  [CANVAS_NODE_TYPES.storyboardGen]: true,
  [CANVAS_NODE_TYPES.panorama]: true,
};

/** Copy stable image references into a storyboard, never flatten or delete the source graph. */
export function applyStoryboardMerge(
  command: MergeStoryboardCommand,
  draft: CanvasGraphDraft,
  nodeFactory: NodeFactory,
): CanvasGraphCommandPreparation {
  const nodesById = new Map(draft.nodes.map((node) => [node.id, node]));
  if (command.input.nodeId && nodesById.has(command.input.nodeId)) {
    return { ok: false, error: { code: 'conflict', message: `Node ${command.input.nodeId} already exists.` } };
  }
  const frames: StoryboardFrameItem[] = [];
  const mediaReferences: Record<string, ProjectMediaReference> = {};
  const sources: CanvasNode[] = [];
  for (const [index, nodeId] of command.input.nodeIds.entries()) {
    const source = nodesById.get(nodeId);
    if (!source) return { ok: false, error: { code: 'not_found', message: `Node ${nodeId} does not exist.` } };
    const metadata = normalizeAssetMetadata(source.data);
    const parsed = storyboardImageSourceSchema.safeParse({
      ...metadata, generationDebugContext: source.data.generationDebugContext,
    });
    if (!storyboardImageNodeTypes[source.type] || !parsed.success) {
      return reject(`Node ${nodeId} must contain a durable image to merge into a storyboard.`);
    }
    const data = parsed.data;
    const debug = data.generationDebugContext;
    const modelId = metadata.model;
    const providerId = data.generationProviderId ?? debug?.providerId ?? data.providerId;
    const requestModel = debug?.requestModel ?? data.requestModel;
    const resolution = metadata.resolution ?? debug?.requestSize;
    const generationJobId = metadata.jobId;
    sources.push(source);
    for (const field of ['imageUrl', 'previewImageUrl'] as const) {
      if (field === 'previewImageUrl' && !isDurableCanvasImageSource(data.previewImageUrl)) continue;
      const reference = mediaReferenceSchema.safeParse(data.mediaReferences?.[field]);
      if (reference.success && reference.data.source === data[field]) {
        mediaReferences[`frames[${index}].${field}`] = reference.data;
      } else if (field === 'imageUrl' && data.assetId) {
        mediaReferences[`frames[${index}].imageUrl`] = { status: 'ready', assetId: data.assetId, source: data.imageUrl };
      }
    }
    frames.push({
      id: `frame-${index + 1}`,
      imageUrl: data.imageUrl,
      ...(isDurableCanvasImageSource(data.previewImageUrl) ? { previewImageUrl: data.previewImageUrl } : {}),
      ...(data.aspectRatio ? { aspectRatio: data.aspectRatio } : {}),
      note: '', order: index,
      sourceNodeId: nodeId,
      sourceAssetId: `${nodeId}:image`,
      sourceMetadata: {
        ...(data.displayName ? { displayName: data.displayName } : {}),
        ...(data.sourceFileName ? { sourceFileName: data.sourceFileName } : {}),
        ...(modelId ? { modelId } : {}),
        ...(providerId ? { providerId } : {}),
        ...(requestModel ? { requestModel } : {}),
        ...(resolution ? { resolution } : {}),
        ...(metadata.width !== undefined ? { width: metadata.width } : {}),
        ...(metadata.height !== undefined ? { height: metadata.height } : {}),
        ...(generationJobId ? { generationJobId } : {}),
      },
    });
  }
  const columns = command.input.columns ?? Math.ceil(Math.sqrt(frames.length));
  const definitionData: Partial<StoryboardSplitNodeData> = {
    ...(command.input.displayName ? { displayName: command.input.displayName.trim() } : {}),
    gridRows: Math.ceil(frames.length / columns), gridCols: columns, frames,
    aspectRatio: frames[0]?.aspectRatio ?? '1:1',
    frameAspectRatio: frames[0]?.aspectRatio ?? '1:1',
    ...(Object.keys(mediaReferences).length ? { mediaReferences } : {}),
  };
  const source = sources[0];
  const absoluteNodes = draft.nodes.map((node) => node.parentId
    ? { ...node, position: resolveAbsoluteNodePosition(node, nodesById) } : node);
  const desired = resolveAbsoluteNodePosition(source, nodesById);
  const position = findRelatedCanvasNodePositions({
    nodes: absoluteNodes, desired, relatedNodeId: source.id, count: 1, size: { width: 560, height: 360 },
  })[0] ?? { x: desired.x + 600, y: desired.y };
  const node = nodeFactory.createNode(CANVAS_NODE_TYPES.storyboardSplit, position, definitionData);
  if (command.input.nodeId) node.id = command.input.nodeId;
  if (nodesById.has(node.id)) {
    return { ok: false, error: { code: 'conflict', message: `Node ${node.id} already exists.` } };
  }
  const affectedNodeIds = [...command.input.nodeIds, node.id];
  return {
    ok: true, changed: true,
    draft: { ...draft, nodes: [...draft.nodes, node] },
    impact: {
      effect: 'graph', summary: `Create storyboard ${node.id} from ${frames.length} ordered images.`,
      affectedNodeIds, affectedEdgeIds: [], creates: { nodes: 1, edges: 0, groups: 0 },
      deletes: { nodes: 0, edges: 0, groups: 0 }, requiresExternalSideEffect: false,
    },
    output: { references: { nodeId: node.id, nodeIds: affectedNodeIds, assetIds: command.input.nodeIds.map((nodeId) => `${nodeId}:image`) } },
  };
}

function success(
  draft: CanvasGraphDraft,
  summary: string,
  nodeId: string,
  changed: boolean,
  output: CanvasCommandOutput = { references: { nodeId, nodeIds: [nodeId] } },
): CanvasGraphCommandPreparation {
  const impact: CanvasCommandImpact = {
    effect: 'graph',
    summary,
    affectedNodeIds: [nodeId],
    affectedEdgeIds: [],
    creates: { nodes: 0, edges: 0, groups: 0 },
    deletes: { nodes: 0, edges: 0, groups: 0 },
    requiresExternalSideEffect: false,
  };
  return { ok: true, draft, impact, output, changed };
}

function reject(message: string): CanvasGraphCommandPreparation {
  return { ok: false, error: { code: 'invalid_command', message } };
}

function replaceNodeData(
  draft: CanvasGraphDraft,
  nodeId: string,
  nextData: CanvasNodeData,
  summary: string,
): CanvasGraphCommandPreparation {
  const node = draft.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) return reject(`Node ${nodeId} does not exist.`);
  const changed = JSON.stringify(node.data) !== JSON.stringify(nextData);
  return success(
    changed
      ? {
          ...draft,
          nodes: draft.nodes.map((candidate) => (
            candidate.id === nodeId ? { ...candidate, data: nextData } as CanvasNode : candidate
          )),
        }
      : draft,
    summary,
    nodeId,
    changed,
  );
}

export function applyStoryboardUpdate(
  command: UpdateStoryboardCommand,
  draft: CanvasGraphDraft,
): CanvasGraphCommandPreparation {
  const node = draft.nodes.find((candidate) => candidate.id === command.input.nodeId);
  if (!node || node.type !== CANVAS_NODE_TYPES.storyboardSplit) {
    return reject(`Node ${command.input.nodeId} is not a storyboard split node.`);
  }
  const data = node.data as StoryboardSplitNodeData;
  const patchById = new Map((command.input.frames ?? []).map((frame) => [frame.frameId, frame]));
  const frames = data.frames
    .map((frame) => {
      const patch = patchById.get(frame.id);
      if (!patch) return frame;
      return {
        ...frame,
        ...(patch.note !== undefined ? { note: patch.note } : {}),
        ...(patch.order !== undefined ? { order: patch.order } : {}),
      };
    })
    .sort((left, right) => left.order - right.order);
  const exportOptions: StoryboardExportOptions = {
    showFrameIndex: false,
    showFrameNote: false,
    notePlacement: 'overlay',
    imageFit: 'cover',
    frameIndexPrefix: 'S',
    cellGap: 8,
    outerPadding: 0,
    fontSize: 4,
    backgroundColor: '#0f1115',
    textColor: '#f8fafc',
    ...(data.exportOptions ?? {}),
    ...(command.input.exportOptions ?? {}),
  };
  return replaceNodeData(
    draft,
    node.id,
    { ...data, frames, exportOptions },
    `Update storyboard ${node.id}.`,
  );
}

function imageAssetUrl(nodes: CanvasNode[], assetId: string | null | undefined): string | null {
  if (assetId === null || assetId === undefined) return null;
  return buildCanvasAssetCatalog(nodes).find((asset) => (
    asset.id === assetId && asset.kind === 'image'
  ))?.url ?? null;
}

export function applyPanoramaUpdate(
  command: UpdatePanoramaCommand,
  draft: CanvasGraphDraft,
): CanvasGraphCommandPreparation {
  const node = draft.nodes.find((candidate) => candidate.id === command.input.nodeId);
  if (!node || node.type !== CANVAS_NODE_TYPES.panorama) {
    return reject(`Node ${command.input.nodeId} is not a panorama node.`);
  }
  const data = node.data as PanoramaNodeData;
  const sourceImageUrl = command.input.sourceAssetId === undefined
    ? data.sourceImageUrl
    : imageAssetUrl(draft.nodes, command.input.sourceAssetId);
  if (command.input.sourceAssetId && !sourceImageUrl) {
    return reject(`Asset ${command.input.sourceAssetId} does not exist or is not an image.`);
  }
  return replaceNodeData(
    draft,
    node.id,
    {
      ...data,
      ...(command.input.sourceMode !== undefined ? { sourceMode: command.input.sourceMode } : {}),
      ...(command.input.sourcePrompt !== undefined ? { sourcePrompt: command.input.sourcePrompt } : {}),
      ...(command.input.sourceAssetId !== undefined ? { sourceImageUrl } : {}),
      ...(command.input.projection !== undefined ? { projection: command.input.projection } : {}),
      ...(command.input.smartBase !== undefined ? { smartBase: command.input.smartBase } : {}),
      ...(command.input.initialYaw !== undefined ? { initialYaw: command.input.initialYaw } : {}),
      ...(command.input.initialPitch !== undefined ? { initialPitch: command.input.initialPitch } : {}),
      ...(command.input.initialFov !== undefined ? { initialFov: command.input.initialFov } : {}),
    },
    `Update panorama ${node.id}.`,
  );
}

function resolveDirectorItem(
  nodes: CanvasNode[],
  item: CanvasDirectorItemInput,
): BlueprintItem | null {
  const { referenceAssetId, ...value } = item;
  const reference = referenceAssetId ? buildCanvasAssetCatalog(nodes).find((asset) => asset.id === referenceAssetId) : null;
  if (referenceAssetId && !reference) return null;
  return {
    ...value,
    ...(reference ? { refImageUrl: reference.url, refImageName: reference.title } : {}),
  };
}

export function applyDirectorUpdate(
  command: UpdateDirectorCommand,
  draft: CanvasGraphDraft,
): CanvasGraphCommandPreparation {
  const node = draft.nodes.find((candidate) => candidate.id === command.input.nodeId);
  if (!node || node.type !== CANVAS_NODE_TYPES.blueprint) {
    return reject(`Node ${command.input.nodeId} is not a Director Studio node.`);
  }
  const data = node.data as BlueprintNodeData;
  const catalog = buildCanvasAssetCatalog(draft.nodes);
  const findAsset = (id: string | null | undefined) => (
    id === null || id === undefined
      ? null
      : catalog.find((asset) => asset.id === id && asset.kind === 'image') ?? null
  );
  const background = command.input.backgroundAssetId === undefined
    ? undefined
    : findAsset(command.input.backgroundAssetId);
  const panorama = command.input.backgroundPanoramaAssetId === undefined
    ? undefined
    : findAsset(command.input.backgroundPanoramaAssetId);
  if (command.input.backgroundAssetId && !background) return reject(`Asset ${command.input.backgroundAssetId} does not exist.`);
  if (command.input.backgroundPanoramaAssetId && !panorama) return reject(`Asset ${command.input.backgroundPanoramaAssetId} does not exist.`);

  const references = command.input.referenceAssetIds?.map((id) => findAsset(id));
  if (references?.some((asset) => !asset)) return reject('One or more Director Studio reference assets do not exist.');
  const items = command.input.items?.map((item) => resolveDirectorItem(draft.nodes, item));
  if (items?.some((item) => !item)) return reject('One or more Director Studio item reference assets do not exist.');

  return replaceNodeData(
    draft,
    node.id,
    {
      ...data,
      ...(command.input.mode !== undefined ? { mode: command.input.mode } : {}),
      ...(command.input.basePrompt !== undefined ? { basePrompt: command.input.basePrompt } : {}),
      ...(command.input.aspectRatio !== undefined ? { aspectRatio: command.input.aspectRatio } : {}),
      ...(command.input.aspectFrame !== undefined ? { aspectFrame: command.input.aspectFrame } : {}),
      ...(command.input.screenshotResolution !== undefined ? { screenshotResolution: command.input.screenshotResolution } : {}),
      ...(command.input.themeColor !== undefined ? { themeColor: command.input.themeColor } : {}),
      ...(background !== undefined ? { backgroundImageUrl: background?.url ?? null } : {}),
      ...(panorama !== undefined ? { backgroundPanoramaUrl: panorama?.url ?? null } : {}),
      ...(references !== undefined ? {
        referenceImages: references.flatMap((asset, index) => asset ? [{
          id: asset.id,
          url: asset.url,
          label: asset.title || `Reference ${index + 1}`,
        }] : []),
      } : {}),
      ...(items !== undefined ? { items: items.filter((item): item is BlueprintItem => Boolean(item)) } : {}),
      ...(command.input.customActionPresets !== undefined ? { customActionPresets: command.input.customActionPresets } : {}),
      ...(command.input.customActionPoses !== undefined ? { customActionPoses: command.input.customActionPoses } : {}),
      ...(command.input.camera !== undefined ? { camera: command.input.camera } : {}),
      ...(command.input.lighting !== undefined ? { lighting: command.input.lighting } : {}),
      ...(command.input.grid !== undefined ? { grid: command.input.grid } : {}),
      ...(command.input.viewSettings !== undefined ? { viewSettings: command.input.viewSettings } : {}),
      ...(command.input.shortcuts !== undefined ? { directorStudioShortcuts: command.input.shortcuts } : {}),
      ...(command.input.motionProject !== undefined ? {
        motionProject: command.input.motionProject === null
          ? undefined
          : normalizeDirectorMotionProject(command.input.motionProject),
      } : {}),
    },
    `Update Director Studio ${node.id}.`,
  );
}
