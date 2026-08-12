import {
  CANVAS_NODE_TYPES,
  type BlueprintItem,
  type BlueprintNodeData,
  type CanvasNode,
  type CanvasNodeData,
  type PanoramaNodeData,
  type StoryboardExportOptions,
  type StoryboardSplitNodeData,
} from '../domain/canvasNodes';
import type {
  CanvasCommandImpact,
  CanvasCommandOutput,
  CanvasDirectorItemInput,
  UpdateDirectorCommand,
  UpdatePanoramaCommand,
  UpdateStoryboardCommand,
} from '../domain/canvasCommands';
import { buildCanvasAssetCatalog } from './canvasAssetCatalog';
import { normalizeDirectorMotionProject } from './directorMotion';
import type {
  CanvasGraphCommandPreparation,
  CanvasGraphDraft,
} from './canvasTransactionCoordinator';

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
