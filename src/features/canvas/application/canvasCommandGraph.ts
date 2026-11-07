import {
  CANVAS_NODE_TYPES,
  DEFAULT_NODE_WIDTH,
  IMAGE_SIZES,
  type CanvasEdge,
  type ImageSize,
  type CanvasNode,
  type CanvasNodeType,
  type CanvasNodeData,
  isEligibleTagGroupMember,
  isTagGroupNode,
} from '../domain/canvasNodes';
import { getNodeDefinition } from '../domain/nodeRegistry';
import {
  canCreateCanvasNodeDirectly,
  canvasNodeCapabilityManifest,
  type CanvasNodeCapabilityDeclaration,
} from '../domain/canvasCapabilities';
import type {
  CanvasCommand,
  CanvasCommandErrorCode,
  CanvasCommandImpact,
  CanvasCommandOrigin,
  CanvasCommandOutput,
  CanvasCommandType,
} from '../domain/canvasCommands';
import type { NodeFactory } from './ports';
import type {
  CanvasGraphCommandPreparation,
  CanvasGraphDraft,
} from './canvasTransactionCoordinator';
import { validateCanvasConnection } from './canvasConnectionRules';
import {
  applyDirectorUpdate,
  applyPanoramaUpdate,
  applyStoryboardUpdate,
  applyStoryboardMerge,
} from './canvasWorkflowCommands';
import {
  collidesWithNodes,
  findRelatedCanvasNodePositions,
  type CanvasPlacementViewport,
} from './canvasNodePlacement';
import { duplicateCanvasGraph } from '../clipboard/canvasDuplication';
import { sortNodesForDuplication } from '../clipboard/clipboardIO';
import { normalizeBatchStacks, selectBatchStack, splitBatchStack, updateBatchStack } from './stacks';

const GRAPH_COMMAND_TYPES: Partial<Record<CanvasCommandType, true>> = {
  'node.create': true,
  'node.delete': true,
  'node.rename': true,
  'node.setPrompt': true,
  'node.setModelConfig': true,
  'node.move': true,
  'node.layout': true,
  'node.setEnabled': true,
  'node.duplicate': true,
  'batch.setPrimary': true,
  'batch.setCollapsed': true,
  'batch.split': true,
  'storyboard.update': true,
  'storyboard.merge': true,
  'panorama.update': true,
  'director.update': true,
  'tag.setColor': true,
  'tagGroup.setMembers': true,
  'tagGroup.setAppearance': true,
  'edge.connect': true,
  'edge.disconnect': true,
  'selection.connect': true,
  'group.create': true,
  'group.ungroup': true,
};

export function isAtomicCanvasGraphCommand(type: CanvasCommandType): boolean {
  return GRAPH_COMMAND_TYPES[type] === true;
}

/**
 * Rendered footprint of a node that does not exist yet. Registry `defaultSize` wins; the rest
 * mirror the minimum sizes the node components render at, so placement never under-estimates.
 */
const CREATION_FOOTPRINTS: Partial<Record<CanvasNodeType, { width: number; height: number }>> = {
  [CANVAS_NODE_TYPES.video]: { width: 384, height: 288 },
  [CANVAS_NODE_TYPES.audio]: { width: 360, height: 170 },
  [CANVAS_NODE_TYPES.textAnnotation]: { width: DEFAULT_NODE_WIDTH, height: 140 },
};

function nodeCreationDimensions(command: Extract<CanvasCommand, { type: 'node.create' }>): { width: number; height: number } {
  if (command.input.dimensions) return command.input.dimensions;
  const type = command.input.nodeType;
  return getNodeDefinition(type).defaultSize
    ?? CREATION_FOOTPRINTS[type]
    ?? { width: DEFAULT_NODE_WIDTH, height: 220 };
}

/** Nearest free slot to the requested position; used when the caller has no exact drop point. */
export function resolveCollisionFreeNodePosition(
  command: Extract<CanvasCommand, { type: 'node.create' }>,
  nodes: readonly CanvasNode[],
  viewport?: CanvasPlacementViewport | null,
): { x: number; y: number } {
  const desired = command.input.position;
  const size = nodeCreationDimensions(command);
  if (!collidesWithNodes({ ...desired, ...size }, nodes)) return { ...desired };
  return findRelatedCanvasNodePositions({ nodes, desired, size, viewport, strictViewport: Boolean(viewport) })[0] ?? { ...desired };
}

function impact(
  summary: string,
  options: Partial<Omit<CanvasCommandImpact, 'effect' | 'summary' | 'requiresExternalSideEffect'>> = {},
): CanvasCommandImpact {
  return {
    effect: 'graph',
    summary,
    affectedNodeIds: options.affectedNodeIds ?? [],
    affectedEdgeIds: options.affectedEdgeIds ?? [],
    creates: options.creates ?? { nodes: 0, edges: 0, groups: 0 },
    deletes: options.deletes ?? { nodes: 0, edges: 0, groups: 0 },
    requiresExternalSideEffect: false,
  };
}

function success(
  draft: CanvasGraphDraft,
  commandImpact: CanvasCommandImpact,
  output: CanvasCommandOutput,
  changed = true,
): CanvasGraphCommandPreparation {
  return { ok: true, draft, impact: commandImpact, output, changed };
}

function reject(
  message: string,
  code: CanvasCommandErrorCode = 'invalid_command',
  details?: Record<string, unknown>,
): CanvasGraphCommandPreparation {
  return { ok: false, error: { code, message, ...(details ? { details } : {}) } };
}

function uniqueNonEmpty(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cloneJsonValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => cloneJsonValue(item)) as T;
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, cloneJsonValue(child)]),
    ) as T;
  }
  return value;
}

function areCanvasValuesEquivalent(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length
      && left.every((item, index) => areCanvasValuesEquivalent(item, right[index]));
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return leftKeys.length === rightKeys.length
      && leftKeys.every((key) => (
        Object.prototype.hasOwnProperty.call(right, key)
        && areCanvasValuesEquivalent(left[key], right[key])
      ));
  }
  return false;
}

function collectNodeIdsWithDescendants(nodes: CanvasNode[], seedIds: string[]): Set<string> {
  const ids = new Set(seedIds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes) {
      if (node.parentId && ids.has(node.parentId) && !ids.has(node.id)) {
        ids.add(node.id);
        changed = true;
      }
    }
  }
  return ids;
}

function getNodeSize(node: CanvasNode): { width: number; height: number } {
  const style = node.style as { width?: unknown; height?: unknown } | undefined;
  return {
    width: node.measured?.width ?? node.width ?? (typeof style?.width === 'number' ? style.width : DEFAULT_NODE_WIDTH),
    height: node.measured?.height ?? node.height ?? (typeof style?.height === 'number' ? style.height : 200),
  };
}

function resolveAbsolutePosition(
  node: CanvasNode,
  nodesById: Map<string, CanvasNode>,
): { x: number; y: number } {
  let x = node.position.x;
  let y = node.position.y;
  let parentId = node.parentId;
  const visited = new Set<string>();
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = nodesById.get(parentId);
    if (!parent) {
      break;
    }
    x += parent.position.x;
    y += parent.position.y;
    parentId = parent.parentId;
  }
  return { x, y };
}

function createNodeData(command: Extract<CanvasCommand, { type: 'node.create' }>): Partial<CanvasNodeData> {
  const configuration = command.input.configuration;
  if (!configuration) {
    return {};
  }
  const data: Record<string, unknown> = {};
  if (configuration.displayName !== undefined) {
    data.displayName = configuration.displayName;
    if (
      command.input.nodeType === CANVAS_NODE_TYPES.tag
      || command.input.nodeType === CANVAS_NODE_TYPES.tagGroup
    ) {
      data.label = configuration.displayName;
    }
  }
  if (configuration.imageUrl !== undefined
    && (command.input.nodeType === CANVAS_NODE_TYPES.imageEdit || command.input.nodeType === CANVAS_NODE_TYPES.upload)) {
    data.imageUrl = configuration.imageUrl;
  }
  if (configuration.prompt !== undefined) {
    data.prompt = configuration.prompt;
  }
  if (configuration.modeId !== undefined) data.channelModeId = configuration.modeId;
  if (configuration.referenceSlots !== undefined) data.referenceSlots = cloneJsonValue(configuration.referenceSlots);
  if (configuration.content !== undefined && command.input.nodeType === CANVAS_NODE_TYPES.textAnnotation) {
    data.content = configuration.content;
  }
  if (configuration.modelId !== undefined) {
    if (command.input.nodeType === CANVAS_NODE_TYPES.aiAudio) {
      data.modelId = configuration.modelId;
    } else if (command.input.nodeType === CANVAS_NODE_TYPES.aiVideo) {
      data.modelConfig = {
        entryId: configuration.modelId,
        duration: configuration.duration ?? '5',
        resolution: configuration.resolution ?? '720p',
        aspectRatio: configuration.aspectRatio,
        extraParams: cloneJsonValue(configuration.extraParams ?? {}),
      };
      data.extraParams = cloneJsonValue(configuration.extraParams ?? {});
    } else if (
      command.input.nodeType === CANVAS_NODE_TYPES.imageEdit
      || command.input.nodeType === CANVAS_NODE_TYPES.storyboardGen
    ) {
      const extraParams = {
        ...cloneJsonValue(configuration.extraParams ?? {}),
        ...(configuration.resolution ? { resolutionType: configuration.resolution } : {}),
      };
      data.model = configuration.modelId;
      data.modelConfig = {
        entryId: configuration.modelId,
        ratio: configuration.aspectRatio ?? 'auto',
        extraParams,
      };
      data.extraParams = cloneJsonValue(extraParams);
      if (configuration.resolution && (IMAGE_SIZES as readonly string[]).includes(configuration.resolution)) {
        data.size = configuration.resolution as ImageSize;
      }
    } else {
      data.model = configuration.modelId;
    }
  }
  if (configuration.aspectRatio !== undefined) {
    if (
      command.input.nodeType === CANVAS_NODE_TYPES.imageEdit
      || command.input.nodeType === CANVAS_NODE_TYPES.storyboardGen
    ) {
      data.requestAspectRatio = configuration.aspectRatio;
      if (data.modelConfig && typeof data.modelConfig === 'object') {
        data.modelConfig = { ...data.modelConfig, ratio: configuration.aspectRatio };
      }
    } else if (command.input.nodeType === CANVAS_NODE_TYPES.aiVideo) {
      const current = data.modelConfig && typeof data.modelConfig === 'object'
        ? data.modelConfig as Record<string, unknown>
        : null;
      if (current) {
        data.modelConfig = { ...current, aspectRatio: configuration.aspectRatio };
      }
    } else {
      data.aspectRatio = configuration.aspectRatio;
    }
  }
  if (configuration.providerId !== undefined && command.input.nodeType === CANVAS_NODE_TYPES.aiText) {
    data.providerId = configuration.providerId;
  }
  if (configuration.openDirectorStudio && command.input.nodeType === CANVAS_NODE_TYPES.blueprint) {
    data.openDirectorStudioOnCreate = configuration.directorStudioWorkspace === 'previs' ? 'previs' : true;
  }
  if (configuration.directorStudioMode !== undefined && command.input.nodeType === CANVAS_NODE_TYPES.blueprint) {
    data.mode = configuration.directorStudioMode;
  }
  if (configuration.enabled !== undefined) {
    data.enabled = configuration.enabled;
  }
  if (configuration.tagColor !== undefined && command.input.nodeType === CANVAS_NODE_TYPES.tag) {
    data.color = configuration.tagColor;
  }
  if (configuration.memberNodeIds !== undefined && command.input.nodeType === CANVAS_NODE_TYPES.tagGroup) {
    data.memberNodeIds = uniqueNonEmpty(configuration.memberNodeIds);
  }
  if (configuration.tagGroupColor !== undefined && command.input.nodeType === CANVAS_NODE_TYPES.tagGroup) {
    data.color = configuration.tagGroupColor;
  }
  if (configuration.tagGroupShape !== undefined && command.input.nodeType === CANVAS_NODE_TYPES.tagGroup) {
    data.shape = configuration.tagGroupShape;
  }
  return data as Partial<CanvasNodeData>;
}

function applyCreateNode(
  command: Extract<CanvasCommand, { type: 'node.create' }>,
  draft: CanvasGraphDraft,
  nodeFactory: NodeFactory,
  origin: CanvasCommandOrigin,
): CanvasGraphCommandPreparation {
  const capability: CanvasNodeCapabilityDeclaration | undefined =
    canvasNodeCapabilityManifest[command.input.nodeType];
  if (!capability) {
    return reject(`Node type ${command.input.nodeType} cannot be created through canvas commands.`, 'unsupported_command');
  }
  if (!canCreateCanvasNodeDirectly(command.input.nodeType, origin)) {
    return reject(
      origin === 'agent' && capability.status !== 'supported'
        ? capability.reason ?? `Node type ${command.input.nodeType} is UI-only.`
        : capability.directCreateReason
        ?? `Node type ${command.input.nodeType} requires a dedicated workflow.`,
      'unsupported_command',
    );
  }
  if (command.input.nodeId && draft.nodes.some((node) => node.id === command.input.nodeId)) {
    return reject(`Node ${command.input.nodeId} already exists.`, 'conflict');
  }
  if (
    command.input.nodeType === CANVAS_NODE_TYPES.tagGroup
    && command.input.configuration?.memberNodeIds
  ) {
    const invalidMemberId = uniqueNonEmpty(command.input.configuration.memberNodeIds).find((memberId) => (
      !isEligibleTagGroupMember(draft.nodes.find((node) => node.id === memberId))
    ));
    if (invalidMemberId) {
      return reject(`Node ${invalidMemberId} is not an eligible tag-group member.`, 'not_found');
    }
  }
  const node = nodeFactory.createNode(
    command.input.nodeType,
    origin === 'agent'
      ? resolveCollisionFreeNodePosition(command, draft.nodes)
      : { ...command.input.position },
    createNodeData(command),
  );
  if (command.input.nodeId) {
    node.id = command.input.nodeId;
  }
  if (command.input.nodeType === CANVAS_NODE_TYPES.tagGroup) {
    node.zIndex = -1;
  }
  if (command.input.dimensions) {
    node.measured = { ...command.input.dimensions };
    node.style = {
      ...(node.style ?? {}),
      width: command.input.dimensions.width,
      height: command.input.dimensions.height,
    };
  }
  return success(
    { ...draft, nodes: [...draft.nodes, node] },
    impact(`Create ${command.input.nodeType} node.`, {
      affectedNodeIds: [node.id],
      creates: {
        nodes: 1,
        edges: 0,
        groups: command.input.nodeType === CANVAS_NODE_TYPES.group
          || command.input.nodeType === CANVAS_NODE_TYPES.tagGroup ? 1 : 0,
      },
    }),
    { references: { nodeId: node.id, nodeIds: [node.id] } },
  );
}

function applyDeleteNodes(
  command: Extract<CanvasCommand, { type: 'node.delete' }>,
  draft: CanvasGraphDraft,
): CanvasGraphCommandPreparation {
  const requestedIds = uniqueNonEmpty(command.input.nodeIds);
  const nodeIds = new Set(draft.nodes.map((node) => node.id));
  const missingId = requestedIds.find((nodeId) => !nodeIds.has(nodeId));
  if (missingId) {
    return reject(`Node ${missingId} does not exist.`, 'not_found');
  }
  const deletedIds = collectNodeIdsWithDescendants(draft.nodes, requestedIds);
  const deletedEdges = draft.edges.filter((edge) => deletedIds.has(edge.source) || deletedIds.has(edge.target));
  const deletedGroups = draft.nodes.filter((node) => (
    deletedIds.has(node.id)
    && (node.type === CANVAS_NODE_TYPES.group || node.type === CANVAS_NODE_TYPES.tagGroup)
  )).length;
  const survivingNodes = draft.nodes
    .filter((node) => !deletedIds.has(node.id))
    .map((node) => {
      if (!isTagGroupNode(node)) return node;
      const memberNodeIds = node.data.memberNodeIds.filter((memberId) => !deletedIds.has(memberId));
      return memberNodeIds.length === node.data.memberNodeIds.length
        ? node
        : { ...node, data: { ...node.data, memberNodeIds } };
    });
  return success(
    {
      nodes: normalizeBatchStacks(survivingNodes, draft.nodes),
      edges: draft.edges.filter((edge) => !deletedIds.has(edge.source) && !deletedIds.has(edge.target)),
      selectedNodeId: draft.selectedNodeId && deletedIds.has(draft.selectedNodeId) ? null : draft.selectedNodeId,
    },
    impact(`Delete ${deletedIds.size} node(s).`, {
      affectedNodeIds: Array.from(deletedIds),
      affectedEdgeIds: deletedEdges.map((edge) => edge.id),
      deletes: { nodes: deletedIds.size, edges: deletedEdges.length, groups: deletedGroups },
    }),
    { references: { nodeIds: Array.from(deletedIds), edgeIds: deletedEdges.map((edge) => edge.id) } },
    deletedIds.size > 0,
  );
}

function applyRenameNode(
  command: Extract<CanvasCommand, { type: 'node.rename' }>,
  draft: CanvasGraphDraft,
): CanvasGraphCommandPreparation {
  const node = draft.nodes.find((candidate) => candidate.id === command.input.nodeId);
  if (!node) {
    return reject(`Node ${command.input.nodeId} does not exist.`, 'not_found');
  }
  const displayName = command.input.displayName.trim();
  const currentName = typeof node.data.displayName === 'string' ? node.data.displayName : '';
  const isLabelNode = node.type === CANVAS_NODE_TYPES.group
    || node.type === CANVAS_NODE_TYPES.tag
    || node.type === CANVAS_NODE_TYPES.tagGroup;
  const currentLabel = isLabelNode && typeof node.data.label === 'string'
    ? node.data.label
    : currentName;
  const marksGeneratedNameCustom = (
    node.type === CANVAS_NODE_TYPES.exportImage
    || node.type === CANVAS_NODE_TYPES.video
  ) && node.data.generatedNamingMode !== 'custom';
  const changed = currentName !== displayName
    || currentLabel !== displayName
    || marksGeneratedNameCustom;
  const nodes = changed
    ? draft.nodes.map((candidate) => candidate.id === node.id
      ? {
          ...candidate,
          data: {
            ...candidate.data,
            displayName,
            ...(candidate.type === CANVAS_NODE_TYPES.group
              || candidate.type === CANVAS_NODE_TYPES.tag
              || candidate.type === CANVAS_NODE_TYPES.tagGroup
              ? { label: displayName }
              : {}),
            ...(candidate.type === CANVAS_NODE_TYPES.exportImage
              || candidate.type === CANVAS_NODE_TYPES.video
              ? { generatedNamingMode: 'custom' as const }
              : {}),
          } as CanvasNodeData,
        }
      : candidate)
    : draft.nodes;
  return success(
    { ...draft, nodes },
    impact(`Rename node ${node.id}.`, { affectedNodeIds: [node.id] }),
    { references: { nodeId: node.id, nodeIds: [node.id] } },
    changed,
  );
}

function applySetPrompt(
  command: Extract<CanvasCommand, { type: 'node.setPrompt' }>,
  draft: CanvasGraphDraft,
): CanvasGraphCommandPreparation {
  const node = draft.nodes.find((candidate) => candidate.id === command.input.nodeId);
  if (!node) {
    return reject(`Node ${command.input.nodeId} does not exist.`, 'not_found');
  }
  if (!(canvasNodeCapabilityManifest[node.type].commands as readonly CanvasCommandType[]).includes('node.setPrompt')) {
    return reject(`Node ${node.id} does not support prompt configuration.`, 'unsupported_command');
  }
  const key = node.type === CANVAS_NODE_TYPES.textAnnotation ? 'content' : 'prompt';
  const changed = !Object.is((node.data as Record<string, unknown>)[key], command.input.prompt);
  const nodes = changed
    ? draft.nodes.map((candidate) => candidate.id === node.id
      ? { ...candidate, data: { ...candidate.data, [key]: command.input.prompt } as CanvasNodeData }
      : candidate)
    : draft.nodes;
  return success(
    { ...draft, nodes },
    impact(`Update ${key} for node ${node.id}.`, { affectedNodeIds: [node.id] }),
    { references: { nodeId: node.id, nodeIds: [node.id] } },
    changed,
  );
}

function buildModelPatch(
  node: CanvasNode,
  input: Extract<CanvasCommand, { type: 'node.setModelConfig' }>['input'],
): Partial<CanvasNodeData> | null {
  if (!(canvasNodeCapabilityManifest[node.type].commands as readonly CanvasCommandType[]).includes('node.setModelConfig')) {
    return null;
  }
  if (node.type === CANVAS_NODE_TYPES.aiVideo) {
    const current = (node.data as { modelConfig?: Record<string, unknown> }).modelConfig ?? {};
    const extraParams = cloneJsonValue(input.extraParams
      ?? (current.extraParams && typeof current.extraParams === 'object'
        ? current.extraParams as Record<string, unknown>
        : (node.data as { extraParams?: Record<string, unknown> }).extraParams));
    return {
      ...(input.modeId !== undefined ? { channelModeId: input.modeId } : {}),
      ...(input.referenceSlots !== undefined ? { referenceSlots: cloneJsonValue(input.referenceSlots) } : {}),
      modelConfig: {
        entryId: input.modelId,
        duration: input.duration ?? (typeof current.duration === 'string' ? current.duration : '5'),
        resolution: input.resolution ?? (typeof current.resolution === 'string' ? current.resolution : '720p'),
        aspectRatio: input.aspectRatio
          ?? (typeof current.aspectRatio === 'string' ? current.aspectRatio : undefined),
        extraParams,
      },
      extraParams,
    } as Partial<CanvasNodeData>;
  }
  if (node.type === CANVAS_NODE_TYPES.aiAudio) {
    return {
      modelId: input.modelId,
      ...(input.extraParams !== undefined
        ? { audioGenerationParams: cloneJsonValue(input.extraParams) }
        : {}),
    } as Partial<CanvasNodeData>;
  }
  if (node.type === CANVAS_NODE_TYPES.aiText) {
    return {
      model: input.modelId,
      providerId: input.providerId === undefined
        ? (node.data as { providerId?: string | null }).providerId
        : input.providerId,
    } as Partial<CanvasNodeData>;
  }
  const current = (node.data as {
    modelConfig?: { ratio?: string; extraParams?: Record<string, unknown> };
    requestAspectRatio?: string;
    extraParams?: Record<string, unknown>;
    size?: ImageSize;
  });
  const ratio = input.aspectRatio
    ?? current.modelConfig?.ratio
    ?? current.requestAspectRatio
    ?? 'auto';
  const baseExtraParams = cloneJsonValue(input.extraParams
    ?? current.modelConfig?.extraParams
    ?? current.extraParams);
  const extraParams = input.resolution === undefined
    ? baseExtraParams
    : { ...(baseExtraParams ?? {}), resolutionType: input.resolution };
  const size = input.resolution && (IMAGE_SIZES as readonly string[]).includes(input.resolution)
    ? input.resolution as ImageSize
    : current.size;
  return {
    ...(input.modeId !== undefined ? { channelModeId: input.modeId } : {}),
    ...(input.referenceSlots !== undefined ? { referenceSlots: cloneJsonValue(input.referenceSlots) } : {}),
    model: input.modelId,
    modelConfig: {
      entryId: input.modelId,
      ratio,
      extraParams,
    },
    requestAspectRatio: ratio,
    extraParams,
    ...(size ? { size } : {}),
  } as Partial<CanvasNodeData>;
}

function findUnsupportedModelConfigFields(
  node: CanvasNode,
  input: Extract<CanvasCommand, { type: 'node.setModelConfig' }>['input'],
): string[] {
  const providedOptionalFields = [
    ['providerId', input.providerId],
    ['aspectRatio', input.aspectRatio],
    ['resolution', input.resolution],
    ['duration', input.duration],
    ['extraParams', input.extraParams],
    ['modeId', input.modeId],
    ['referenceSlots', input.referenceSlots],
  ].filter((entry) => entry[1] !== undefined).map(([key]) => key as string);
  const allowedFields: Record<string, true> = node.type === CANVAS_NODE_TYPES.aiText
    ? { providerId: true }
    : node.type === CANVAS_NODE_TYPES.aiAudio
      ? { extraParams: true }
      : { aspectRatio: true, resolution: true, extraParams: true, modeId: true, referenceSlots: true,
        ...(node.type === CANVAS_NODE_TYPES.aiVideo ? { duration: true as const } : {}) };
  return providedOptionalFields.filter((field) => !Object.hasOwn(allowedFields, field));
}

function applySetModelConfig(
  command: Extract<CanvasCommand, { type: 'node.setModelConfig' }>,
  draft: CanvasGraphDraft,
): CanvasGraphCommandPreparation {
  const node = draft.nodes.find((candidate) => candidate.id === command.input.nodeId);
  if (!node) {
    return reject(`Node ${command.input.nodeId} does not exist.`, 'not_found');
  }
  const unsupportedFields = findUnsupportedModelConfigFields(node, command.input);
  if (unsupportedFields.length > 0) {
    return reject(
      `Node ${node.id} does not support model configuration field(s): ${unsupportedFields.join(', ')}.`,
    );
  }
  const patch = buildModelPatch(node, command.input);
  if (!patch) {
    return reject(`Node ${node.id} does not support model configuration.`, 'unsupported_command');
  }
  const changed = Object.entries(patch).some(([key, value]) => (
    !areCanvasValuesEquivalent((node.data as Record<string, unknown>)[key], value)
  ));
  const nodes = changed
    ? draft.nodes.map((candidate) => candidate.id === node.id
      ? { ...candidate, data: { ...candidate.data, ...patch } as CanvasNodeData }
      : candidate)
    : draft.nodes;
  return success(
    { ...draft, nodes },
    impact(`Update model configuration for node ${node.id}.`, { affectedNodeIds: [node.id] }),
    { references: { nodeId: node.id, nodeIds: [node.id] } },
    changed,
  );
}

function applyMoveNodes(
  command: Extract<CanvasCommand, { type: 'node.move' }>,
  draft: CanvasGraphDraft,
): CanvasGraphCommandPreparation {
  const positions = new Map(command.input.positions.map((item) => [item.nodeId, item.position] as const));
  const missingId = Array.from(positions.keys()).find((nodeId) => !draft.nodes.some((node) => node.id === nodeId));
  if (missingId) {
    return reject(`Node ${missingId} does not exist.`, 'not_found');
  }
  let changed = false;
  const nodes = draft.nodes.map((node) => {
    const position = positions.get(node.id);
    if (!position || (position.x === node.position.x && position.y === node.position.y)) {
      return node;
    }
    changed = true;
    return { ...node, position: { ...position } };
  });
  const nodeIds = Array.from(positions.keys());
  return success(
    { ...draft, nodes },
    impact(`Move ${nodeIds.length} node(s).`, { affectedNodeIds: nodeIds }),
    { references: { nodeIds } },
    changed,
  );
}

function applyLayoutNodes(
  command: Extract<CanvasCommand, { type: 'node.layout' }>,
  draft: CanvasGraphDraft,
): CanvasGraphCommandPreparation {
  const nodeIds = uniqueNonEmpty(command.input.nodeIds);
  const selected = nodeIds.map((nodeId) => draft.nodes.find((node) => node.id === nodeId));
  const missingIndex = selected.findIndex((node) => !node);
  if (missingIndex >= 0) {
    return reject(`Node ${nodeIds[missingIndex]} does not exist.`, 'not_found');
  }
  const selectedNodes = (selected as CanvasNode[]).filter((node) => !node.hidden);
  if (!selectedNodes.length) return success(draft, impact('No visible nodes to lay out.'), { references: { nodeIds: [] } }, false);
  const origin = command.input.origin ?? selectedNodes.reduce(
    (current, node) => ({ x: Math.min(current.x, node.position.x), y: Math.min(current.y, node.position.y) }),
    { x: Number.POSITIVE_INFINITY, y: Number.POSITIVE_INFINITY },
  );
  const gap = command.input.gap ?? 48;
  const columns = command.input.direction === 'grid'
    ? command.input.columns ?? Math.max(1, Math.ceil(Math.sqrt(selectedNodes.length)))
    : selectedNodes.length;
  let cursorX = origin.x;
  let cursorY = origin.y;
  let rowHeight = 0;
  const nextPositions = new Map<string, { x: number; y: number }>();
  selectedNodes.forEach((node, index) => {
    nextPositions.set(node.id, { x: cursorX, y: cursorY });
    const size = getNodeSize(node);
    if (command.input.direction === 'horizontal') {
      cursorX += size.width + gap;
    } else if (command.input.direction === 'vertical') {
      cursorY += size.height + gap;
    } else {
      rowHeight = Math.max(rowHeight, size.height);
      if ((index + 1) % columns === 0) {
        cursorX = origin.x;
        cursorY += rowHeight + gap;
        rowHeight = 0;
      } else {
        cursorX += size.width + gap;
      }
    }
  });
  return applyMoveNodes({
    type: 'node.move',
    version: command.version,
    input: { positions: Array.from(nextPositions, ([nodeId, position]) => ({ nodeId, position })) },
  }, draft);
}

function applySetNodeEnabled(
  command: Extract<CanvasCommand, { type: 'node.setEnabled' }>,
  draft: CanvasGraphDraft,
): CanvasGraphCommandPreparation {
  const nodeIds = uniqueNonEmpty(command.input.nodeIds);
  const nodesById = new Map(draft.nodes.map((node) => [node.id, node] as const));
  const missingId = nodeIds.find((nodeId) => !nodesById.has(nodeId));
  if (missingId) return reject(`Node ${missingId} does not exist.`, 'not_found');
  const idSet = new Set(nodeIds);
  let changed = false;
  const nodes = draft.nodes.map((node) => {
    if (!idSet.has(node.id) || node.data.enabled === command.input.enabled) return node;
    changed = true;
    return { ...node, data: { ...node.data, enabled: command.input.enabled } as CanvasNodeData };
  });
  return success(
    { ...draft, nodes },
    impact(`${command.input.enabled ? 'Enable' : 'Disable'} ${nodeIds.length} node(s).`, {
      affectedNodeIds: nodeIds,
    }),
    { references: { nodeIds } },
    changed,
  );
}

function applyBatchStack(
  command: Extract<CanvasCommand, { type: 'batch.setPrimary' | 'batch.setCollapsed' }>,
  draft: CanvasGraphDraft,
): CanvasGraphCommandPreparation {
  const stack = selectBatchStack(draft.nodes, command.input.batchId);
  if (!stack.primaryId) return reject(`Batch ${command.input.batchId} does not exist.`, 'not_found');
  if (command.type === 'batch.setPrimary' && !stack.memberIds.includes(command.input.nodeId)) {
    return reject('Primary node must belong to the requested batch.', 'invalid_command');
  }
  const nodes = updateBatchStack(draft.nodes, command.input.batchId, command.type === 'batch.setPrimary'
    ? { primaryId: command.input.nodeId } : { collapsed: command.input.collapsed });
  const nextStack = selectBatchStack(nodes, command.input.batchId);
  return success(
    { ...draft, nodes },
    impact(`Update result stack ${command.input.batchId}.`, { affectedNodeIds: stack.memberIds }),
    { references: { nodeId: nextStack.primaryId ?? undefined, nodeIds: stack.memberIds }, value: nextStack },
    nodes !== draft.nodes,
  );
}

function applySplitBatch(
  command: Extract<CanvasCommand, { type: 'batch.split' }>,
  draft: CanvasGraphDraft,
): CanvasGraphCommandPreparation {
  const stack = selectBatchStack(draft.nodes, command.input.batchId);
  if (!stack.primaryId) return reject(`Batch ${command.input.batchId} does not exist.`, 'not_found');
  const nodes = splitBatchStack(draft.nodes, command.input.batchId);
  return success(
    { ...draft, nodes },
    impact(`Separate result stack ${command.input.batchId}.`, { affectedNodeIds: stack.memberIds }),
    { references: { nodeIds: stack.memberIds }, value: { batchId: command.input.batchId, nodeIds: stack.memberIds } },
    nodes !== draft.nodes,
  );
}


function applyDuplicateNodes(
  command: Extract<CanvasCommand, { type: 'node.duplicate' }>,
  draft: CanvasGraphDraft,
  nodeFactory: NodeFactory,
): CanvasGraphCommandPreparation {
  const existingIds = new Set(draft.nodes.map((node) => node.id));
  const requestedIds = new Set<string>();
  const requests = new Map(command.input.copies.map((copy) => [copy.sourceNodeId, copy]));
  if (requests.size !== command.input.copies.length) return reject('A node can only be duplicated once per command.', 'conflict');
  for (const copy of command.input.copies) {
    if (!draft.nodes.some((node) => node.id === copy.sourceNodeId)) {
      return reject(`Node ${copy.sourceNodeId} does not exist.`, 'not_found');
    }
  }
  const sourceIds = collectNodeIdsWithDescendants(draft.nodes, [...requests.keys()]);
  const sourceNodes = sortNodesForDuplication(draft.nodes.filter((node) => sourceIds.has(node.id)));
  const copies = [];
  for (const source of sourceNodes) {
    const requested = requests.get(source.id);
    const nodeId = requested?.nodeId ?? nodeFactory.createNode(source.type, source.position, {}).id;
    if (existingIds.has(nodeId) || requestedIds.has(nodeId)) {
      return reject(`Node ${nodeId} already exists.`, 'conflict');
    }
    requestedIds.add(nodeId);
    copies.push({ sourceNodeId: source.id, nodeId, position: requested?.position });
  }
  const duplicated = duplicateCanvasGraph({
    sourceNodes,
    sourceEdges: draft.edges,
    existingNodes: draft.nodes,
    existingEdges: draft.edges,
    copies,
  });
  const createdIds = duplicated.nodes.map((node) => node.id);
  const createdEdgeIds = duplicated.edges.map((edge) => edge.id);
  return success(
    { ...draft, nodes: [...draft.nodes, ...duplicated.nodes], edges: [...draft.edges, ...duplicated.edges] },
    impact(`Duplicate ${createdIds.length} node(s) with all graph connections.`, {
      affectedNodeIds: [...sourceIds, ...createdIds],
      affectedEdgeIds: createdEdgeIds,
      creates: {
        nodes: createdIds.length,
        edges: createdEdgeIds.length,
        groups: duplicated.nodes.filter((node) => node.type === CANVAS_NODE_TYPES.group || node.type === CANVAS_NODE_TYPES.tagGroup).length,
      },
    }),
    {
      references: { nodeIds: createdIds, edgeIds: createdEdgeIds },
      value: { sourceToCreated: Object.fromEntries(duplicated.idMap) },
    },
    createdIds.length > 0,
  );
}

function applySetTagColor(
  command: Extract<CanvasCommand, { type: 'tag.setColor' }>,
  draft: CanvasGraphDraft,
): CanvasGraphCommandPreparation {
  const tag = draft.nodes.find((node) => node.id === command.input.tagId);
  if (!tag) return reject(`Node ${command.input.tagId} does not exist.`, 'not_found');
  if (tag.type !== CANVAS_NODE_TYPES.tag) {
    return reject(`Node ${tag.id} is not a tag.`, 'unsupported_command');
  }
  const changed = tag.data.color !== command.input.color;
  const nodes = changed
    ? draft.nodes.map((node) => node.id === tag.id
      ? { ...node, data: { ...node.data, color: command.input.color } as CanvasNodeData }
      : node)
    : draft.nodes;
  return success(
    { ...draft, nodes },
    impact(`Set color for tag ${tag.id}.`, { affectedNodeIds: [tag.id] }),
    { references: { nodeId: tag.id, nodeIds: [tag.id] } },
    changed,
  );
}

function applySetTagGroupMembers(
  command: Extract<CanvasCommand, { type: 'tagGroup.setMembers' }>,
  draft: CanvasGraphDraft,
): CanvasGraphCommandPreparation {
  const group = draft.nodes.find((node) => node.id === command.input.groupId);
  if (!group) return reject(`Node ${command.input.groupId} does not exist.`, 'not_found');
  if (group.type !== CANVAS_NODE_TYPES.tagGroup) {
    return reject(`Node ${group.id} is not a tag group.`, 'unsupported_command');
  }
  const memberNodeIds = uniqueNonEmpty(command.input.memberNodeIds);
  const invalidMemberId = memberNodeIds.find((memberId) => (
    !isEligibleTagGroupMember(draft.nodes.find((node) => node.id === memberId))
  ));
  if (invalidMemberId) {
    return reject(`Node ${invalidMemberId} is not an eligible tag-group member.`, 'not_found');
  }
  const changed = !areCanvasValuesEquivalent(group.data.memberNodeIds, memberNodeIds);
  const nodes = changed
    ? draft.nodes.map((node) => node.id === group.id
      ? { ...node, data: { ...node.data, memberNodeIds, unresolvedMemberIds: [], legacyMemberTagIds: [] } as CanvasNodeData }
      : node)
    : draft.nodes;
  return success(
    { ...draft, nodes },
    impact(`Update ${memberNodeIds.length} direct member(s) for group ${group.id}.`, {
      affectedNodeIds: [group.id, ...memberNodeIds],
    }),
    { references: { nodeId: group.id, nodeIds: [group.id, ...memberNodeIds] } },
    changed,
  );
}

function applySetTagGroupAppearance(
  command: Extract<CanvasCommand, { type: 'tagGroup.setAppearance' }>,
  draft: CanvasGraphDraft,
): CanvasGraphCommandPreparation {
  const group = draft.nodes.find((node) => node.id === command.input.groupId);
  if (!group) return reject(`Node ${command.input.groupId} does not exist.`, 'not_found');
  if (!isTagGroupNode(group)) return reject(`Node ${group.id} is not a tag group.`, 'unsupported_command');
  const nextColor = command.input.color ?? group.data.color;
  const nextShape = command.input.shape ?? group.data.shape;
  const changed = nextColor !== group.data.color || nextShape !== group.data.shape;
  const nodes = changed ? draft.nodes.map((node) => node.id === group.id
    ? { ...node, data: { ...node.data, color: nextColor, shape: nextShape } as CanvasNodeData }
    : node) : draft.nodes;
  return success(
    { ...draft, nodes },
    impact(`Update appearance for tag group ${group.id}.`, { affectedNodeIds: [group.id] }),
    { references: { nodeId: group.id, nodeIds: [group.id] } },
    changed,
  );
}

function createEdgeId(draft: CanvasGraphDraft, sourceNodeId: string, targetNodeId: string): string {
  const base = `e-${sourceNodeId}-${targetNodeId}`;
  if (!draft.edges.some((edge) => edge.id === base)) {
    return base;
  }
  let suffix = 2;
  while (draft.edges.some((edge) => edge.id === `${base}-${suffix}`)) {
    suffix += 1;
  }
  return `${base}-${suffix}`;
}

function applyConnectEdge(
  command: Extract<CanvasCommand, { type: 'edge.connect' }>,
  draft: CanvasGraphDraft,
): CanvasGraphCommandPreparation {
  const source = draft.nodes.find((node) => node.id === command.input.sourceNodeId);
  const target = draft.nodes.find((node) => node.id === command.input.targetNodeId);
  const validation = validateCanvasConnection(
    command.input.sourceNodeId,
    command.input.targetNodeId,
    draft.nodes,
    draft.edges,
  );
  if (!validation.valid || !source || !target) {
    const code = validation.code === 'missing-node'
      ? 'not_found'
      : validation.code === 'tag-source-conflict'
        || validation.code === 'tag-cycle'
        || validation.code === 'self-connection'
        ? 'conflict'
        : 'unsupported_command';
    return reject(validation.message ?? 'Cannot connect these nodes.', code, {
      sourceNodeId: command.input.sourceNodeId,
      targetNodeId: command.input.targetNodeId,
      connectionCode: validation.code,
      reason: validation.reason,
    });
  }
  const existing = validation.existingEdgeId
    ? draft.edges.find((edge) => edge.id === validation.existingEdgeId)
    : undefined;
  if (existing) {
    return success(
      draft,
      impact(`Connection ${existing.id} already exists.`, { affectedEdgeIds: [existing.id] }),
      { references: { edgeId: existing.id, edgeIds: [existing.id] } },
      false,
    );
  }
  const edgeId = command.input.edgeId ?? createEdgeId(draft, source.id, target.id);
  if (draft.edges.some((edge) => edge.id === edgeId)) {
    return reject(`Edge ${edgeId} already exists.`, 'conflict');
  }
  const edge: CanvasEdge = {
    id: edgeId,
    source: source.id,
    target: target.id,
    sourceHandle: 'source',
    targetHandle: 'target',
    type: 'disconnectableEdge',
  };
  return success(
    { ...draft, edges: [...draft.edges, edge] },
    impact(`Connect ${source.id} to ${target.id}.`, {
      affectedNodeIds: [source.id, target.id],
      affectedEdgeIds: [edge.id],
      creates: { nodes: 0, edges: 1, groups: 0 },
    }),
    { references: { edgeId: edge.id, edgeIds: [edge.id], nodeIds: [source.id, target.id] } },
  );
}

function applyConnectSelection(
  command: Extract<CanvasCommand, { type: 'selection.connect' }>,
  draft: CanvasGraphDraft,
): CanvasGraphCommandPreparation {
  const sourceNodeIds = uniqueNonEmpty(command.input.sourceNodeIds);
  let nextDraft = draft;
  const edgeIds: string[] = [];
  for (const sourceNodeId of sourceNodeIds) {
    const result = applyConnectEdge({
      type: 'edge.connect', version: command.version,
      input: { sourceNodeId, targetNodeId: command.input.targetNodeId },
    }, nextDraft);
    if (!result.ok) return result;
    nextDraft = result.draft;
    edgeIds.push(...(result.output.references.edgeIds ?? []));
  }
  const nodeIds = [...sourceNodeIds, command.input.targetNodeId];
  return success(
    nextDraft,
    impact(`Connect ${sourceNodeIds.length} source node(s) to ${command.input.targetNodeId}.`, {
      affectedNodeIds: nodeIds, affectedEdgeIds: edgeIds,
      creates: { nodes: 0, edges: nextDraft.edges.length - draft.edges.length, groups: 0 },
    }),
    { references: { nodeIds, edgeIds } },
    nextDraft.edges !== draft.edges,
  );
}

function applyDisconnectEdges(
  command: Extract<CanvasCommand, { type: 'edge.disconnect' }>,
  draft: CanvasGraphDraft,
): CanvasGraphCommandPreparation {
  const edgeIds = uniqueNonEmpty(command.input.edgeIds);
  const missingId = edgeIds.find((edgeId) => !draft.edges.some((edge) => edge.id === edgeId));
  if (missingId) {
    return reject(`Edge ${missingId} does not exist.`, 'not_found');
  }
  const edgeIdSet = new Set(edgeIds);
  const affectedNodes = draft.edges
    .filter((edge) => edgeIdSet.has(edge.id))
    .flatMap((edge) => [edge.source, edge.target]);
  return success(
    { ...draft, edges: draft.edges.filter((edge) => !edgeIdSet.has(edge.id)) },
    impact(`Disconnect ${edgeIds.length} edge(s).`, {
      affectedNodeIds: Array.from(new Set(affectedNodes)),
      affectedEdgeIds: edgeIds,
      deletes: { nodes: 0, edges: edgeIds.length, groups: 0 },
    }),
    { references: { edgeIds } },
    edgeIds.length > 0,
  );
}

/** Expanding a container rebases its direct children, leaving their absolute positions intact. */
function fitGroupAncestors(nodes: CanvasNode[], childId: string): { nodes: CanvasNode[]; affectedNodeIds: string[] } {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const affected = new Set<string>();
  const visited = new Set<string>();
  let child = nodesById.get(childId);
  while (child?.parentId && !visited.has(child.parentId)) {
    visited.add(child.parentId);
    const parent = nodesById.get(child.parentId);
    if (!parent || parent.type !== CANVAS_NODE_TYPES.group) break;
    const parentSize = getNodeSize(parent);
    const childSize = getNodeSize(child);
    const dx = Math.min(0, child.position.x);
    const dy = Math.min(0, child.position.y);
    const width = Math.max(parentSize.width - dx, child.position.x + childSize.width - dx);
    const height = Math.max(parentSize.height - dy, child.position.y + childSize.height - dy);
    if (dx === 0 && dy === 0 && width === parentSize.width && height === parentSize.height) break;
    const nextParent: CanvasNode = {
      ...parent, position: { x: parent.position.x + dx, y: parent.position.y + dy },
      width, height, style: { ...parent.style, width, height },
      ...(parent.measured ? { measured: { ...parent.measured, width, height } } : {}),
    };
    nodesById.set(parent.id, nextParent);
    affected.add(parent.id);
    if (dx !== 0 || dy !== 0) {
      for (const member of nodesById.values()) {
        if (member.parentId !== parent.id) continue;
        nodesById.set(member.id, { ...member, position: { x: member.position.x - dx, y: member.position.y - dy } });
        affected.add(member.id);
      }
    }
    child = nextParent;
  }
  return {
    nodes: affected.size ? nodes.map((node) => nodesById.get(node.id) ?? node) : nodes,
    affectedNodeIds: [...affected],
  };
}

function applyCreateGroup(
  command: Extract<CanvasCommand, { type: 'group.create' }>,
  draft: CanvasGraphDraft,
  nodeFactory: NodeFactory,
): CanvasGraphCommandPreparation {
  const requestedIds = uniqueNonEmpty(command.input.nodeIds);
  const nodesById = new Map(draft.nodes.map((node) => [node.id, node] as const));
  const missingId = requestedIds.find((nodeId) => !nodesById.has(nodeId));
  if (missingId) {
    return reject(`Node ${missingId} does not exist.`, 'not_found');
  }
  const requestedSet = new Set(requestedIds);
  const memberIds = requestedIds.filter((nodeId) => {
    let parentId = nodesById.get(nodeId)?.parentId;
    const visited = new Set<string>();
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId);
      if (requestedSet.has(parentId)) {
        return false;
      }
      parentId = nodesById.get(parentId)?.parentId;
    }
    return true;
  });
  if (memberIds.length < 2) {
    return reject('A group requires at least two independent nodes.');
  }
  if (command.input.groupId && nodesById.has(command.input.groupId)) {
    return reject(`Node ${command.input.groupId} already exists.`, 'conflict');
  }
  const members = memberIds.map((nodeId) => nodesById.get(nodeId) as CanvasNode);
  const ancestorIds = (node: CanvasNode): string[] => {
    const ids: string[] = [];
    let parentId = node.parentId;
    while (parentId && !ids.includes(parentId)) {
      ids.push(parentId);
      parentId = nodesById.get(parentId)?.parentId;
    }
    return ids;
  };
  const memberAncestors = members.map(ancestorIds);
  const parentId = memberAncestors[0].find((id) => memberAncestors.every((ids) => ids.includes(id)));
  const parent = parentId ? nodesById.get(parentId) : undefined;
  const parentPosition = parent ? resolveAbsolutePosition(parent, nodesById) : { x: 0, y: 0 };
  const bounds = members.reduce((current, node) => {
    const position = resolveAbsolutePosition(node, nodesById);
    const size = getNodeSize(node);
    return {
      minX: Math.min(current.minX, position.x),
      minY: Math.min(current.minY, position.y),
      maxX: Math.max(current.maxX, position.x + size.width),
      maxY: Math.max(current.maxY, position.y + size.height),
    };
  }, {
    minX: Number.POSITIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
  });
  const groupX = bounds.minX - 20;
  const groupY = bounds.minY - 34;
  const groupName = command.input.displayName?.trim()
    || `组 ${draft.nodes.filter((node) => node.type === CANVAS_NODE_TYPES.group).length + 1}`;
  const group = nodeFactory.createNode(CANVAS_NODE_TYPES.group, {
    x: groupX - parentPosition.x, y: groupY - parentPosition.y,
  }, {
    displayName: groupName,
    label: groupName,
  } as Partial<CanvasNodeData>);
  if (command.input.groupId) {
    group.id = command.input.groupId;
  }
  if (nodesById.has(group.id)) return reject(`Node ${group.id} already exists.`, 'conflict');
  if (parent) {
    group.parentId = parent.id;
    group.extent = 'parent';
  }
  group.style = {
    width: Math.max(220, bounds.maxX - bounds.minX + 40),
    height: Math.max(140, bounds.maxY - bounds.minY + 54),
  };
  const memberSet = new Set(memberIds);
  group.selected = true;
  const firstMemberIndex = draft.nodes.reduce((current, node, index) => (
    memberSet.has(node.id) && current === -1 ? index : current
  ), -1);
  const nodes: CanvasNode[] = [];
  draft.nodes.forEach((node, index) => {
    if (index === firstMemberIndex) {
      nodes.push(group);
    }
    if (!memberSet.has(node.id)) {
      nodes.push(Boolean(node.selected) ? { ...node, selected: false } : node);
      return;
    }
    const absolute = resolveAbsolutePosition(node, nodesById);
    nodes.push({
      ...node,
      parentId: group.id,
      extent: 'parent' as const,
      position: { x: absolute.x - groupX, y: absolute.y - groupY },
      selected: false,
    });
  });
  const fitted = parent ? fitGroupAncestors(nodes, group.id) : { nodes, affectedNodeIds: [] };
  const affectedNodeIds = [...new Set([group.id, ...memberIds, ...fitted.affectedNodeIds])];
  return success(
    { ...draft, nodes: fitted.nodes, selectedNodeId: group.id },
    impact(`Group ${memberIds.length} node(s).`, {
      affectedNodeIds,
      creates: { nodes: 1, edges: 0, groups: 1 },
    }),
    { references: { nodeId: group.id, nodeIds: affectedNodeIds } },
  );
}

function applyUngroup(
  command: Extract<CanvasCommand, { type: 'group.ungroup' }>,
  draft: CanvasGraphDraft,
): CanvasGraphCommandPreparation {
  const groupIds = uniqueNonEmpty(command.input.groupIds);
  let nextDraft = draft;
  const affectedNodeIds = new Set<string>();
  const affectedEdgeIds = new Set<string>();
  for (const groupId of groupIds) {
    const group = nextDraft.nodes.find((node) => node.id === groupId && node.type === CANVAS_NODE_TYPES.group);
    if (!group) {
      return reject(`Group ${groupId} does not exist.`, 'not_found');
    }
    const children = nextDraft.nodes.filter((node) => node.parentId === groupId);
    if (children.length === 0) {
      return reject(`Group ${groupId} has no children.`, 'conflict');
    }
    children.forEach((node) => affectedNodeIds.add(node.id));
    affectedNodeIds.add(groupId);
    const removedEdges = nextDraft.edges.filter((edge) => edge.source === groupId || edge.target === groupId);
    removedEdges.forEach((edge) => affectedEdgeIds.add(edge.id));
    nextDraft = {
      nodes: nextDraft.nodes
        .filter((node) => node.id !== groupId)
        .map((node) => node.parentId === groupId
          ? {
              ...node,
              parentId: group.parentId,
              extent: group.parentId ? group.extent : undefined,
              position: { x: group.position.x + node.position.x, y: group.position.y + node.position.y },
            }
          : node),
      edges: nextDraft.edges.filter((edge) => edge.source !== groupId && edge.target !== groupId),
      selectedNodeId: nextDraft.selectedNodeId === groupId ? null : nextDraft.selectedNodeId,
    };
  }
  return success(
    nextDraft,
    impact(`Ungroup ${groupIds.length} group(s).`, {
      affectedNodeIds: Array.from(affectedNodeIds),
      affectedEdgeIds: Array.from(affectedEdgeIds),
      deletes: { nodes: groupIds.length, edges: affectedEdgeIds.size, groups: groupIds.length },
    }),
    { references: { nodeIds: Array.from(affectedNodeIds), edgeIds: Array.from(affectedEdgeIds) } },
    groupIds.length > 0,
  );
}

export function applyCanvasGraphCommand(
  command: CanvasCommand,
  draft: CanvasGraphDraft,
  nodeFactory: NodeFactory,
  origin: CanvasCommandOrigin,
): CanvasGraphCommandPreparation {
  switch (command.type) {
    case 'node.create':
      return applyCreateNode(command, draft, nodeFactory, origin);
    case 'node.delete':
      return applyDeleteNodes(command, draft);
    case 'node.rename':
      return applyRenameNode(command, draft);
    case 'node.setPrompt':
      return applySetPrompt(command, draft);
    case 'node.setModelConfig':
      return applySetModelConfig(command, draft);
    case 'node.move':
      return applyMoveNodes(command, draft);
    case 'node.layout':
      return applyLayoutNodes(command, draft);
    case 'node.setEnabled':
      return applySetNodeEnabled(command, draft);
    case 'batch.setPrimary':
    case 'batch.setCollapsed':
      return applyBatchStack(command, draft);
    case 'batch.split':
      return applySplitBatch(command, draft);
    case 'node.duplicate':
      return applyDuplicateNodes(command, draft, nodeFactory);
    case 'storyboard.update':
      return applyStoryboardUpdate(command, draft);
    case 'storyboard.merge':
      return applyStoryboardMerge(command, draft, nodeFactory);
    case 'panorama.update':
      return applyPanoramaUpdate(command, draft);
    case 'director.update':
      return applyDirectorUpdate(command, draft);
    case 'tag.setColor':
      return applySetTagColor(command, draft);
    case 'tagGroup.setMembers':
      return applySetTagGroupMembers(command, draft);
    case 'tagGroup.setAppearance':
      return applySetTagGroupAppearance(command, draft);
    case 'edge.connect':
      return applyConnectEdge(command, draft);
    case 'selection.connect':
      return applyConnectSelection(command, draft);
    case 'edge.disconnect':
      return applyDisconnectEdges(command, draft);
    case 'group.create':
      return applyCreateGroup(command, draft, nodeFactory);
    case 'group.ungroup':
      return applyUngroup(command, draft);
    default:
      return reject(`Command ${command.type} is not atomic graph work.`, 'not_atomic');
  }
}
