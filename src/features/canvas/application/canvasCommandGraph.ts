import {
  CANVAS_NODE_TYPES,
  DEFAULT_NODE_WIDTH,
  IMAGE_SIZES,
  type CanvasEdge,
  type ImageSize,
  type CanvasNode,
  type CanvasNodeData,
  isEligibleTagGroupMember,
  isTagGroupNode,
  isTagNode,
} from '../domain/canvasNodes';
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
} from './canvasWorkflowCommands';
import { findRelatedCanvasNodePositions } from './canvasNodePlacement';

export const CANVAS_GRAPH_COMMAND_TYPES = new Set<CanvasCommand['type']>([
  'node.create',
  'node.delete',
  'node.rename',
  'node.setPrompt',
  'node.setModelConfig',
  'node.move',
  'node.layout',
  'node.setEnabled',
  'node.duplicate',
  'storyboard.update',
  'panorama.update',
  'director.update',
  'tag.setColor',
  'tagGroup.setMembers',
  'tagGroup.setAppearance',
  'edge.connect',
  'edge.disconnect',
  'group.create',
  'group.ungroup',
]);

function nodeCreationDimensions(command: Extract<CanvasCommand, { type: 'node.create' }>): { width: number; height: number } {
  if (command.input.dimensions) return command.input.dimensions;
  switch (command.input.nodeType) {
    case CANVAS_NODE_TYPES.imageEdit: return { width: DEFAULT_NODE_WIDTH, height: 380 };
    case CANVAS_NODE_TYPES.video: return { width: DEFAULT_NODE_WIDTH, height: 288 };
    case CANVAS_NODE_TYPES.aiVideo: return { width: DEFAULT_NODE_WIDTH, height: 360 };
    default: return { width: DEFAULT_NODE_WIDTH, height: 220 };
  }
}

export function resolveAgentNodeCreationPosition(
  command: Extract<CanvasCommand, { type: 'node.create' }>,
  nodes: readonly CanvasNode[],
): { x: number; y: number } {
  const desired = command.input.position;
  const size = nodeCreationDimensions(command);
  const margin = 18;
  const desiredCollides = nodes.some((node) => {
    const style = node.style as { width?: unknown; height?: unknown } | undefined;
    const width = node.measured?.width
      ?? node.width
      ?? (typeof style?.width === 'number' ? style.width : DEFAULT_NODE_WIDTH);
    const height = node.measured?.height
      ?? node.height
      ?? (typeof style?.height === 'number' ? style.height : 220);
    return desired.x < node.position.x + width + margin
      && desired.x + size.width + margin > node.position.x
      && desired.y < node.position.y + height + margin
      && desired.y + size.height + margin > node.position.y;
  });
  if (!desiredCollides) return { ...desired };
  return findRelatedCanvasNodePositions({ nodes, desired, size })[0] ?? { ...desired };
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

function reject(message: string, code: CanvasCommandErrorCode = 'invalid_command'): CanvasGraphCommandPreparation {
  return { ok: false, error: { code, message } };
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
  if (configuration.prompt !== undefined) {
    data.prompt = configuration.prompt;
  }
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
    data.openDirectorStudioOnCreate = true;
  }
  if (configuration.directorStudioMode !== undefined && command.input.nodeType === CANVAS_NODE_TYPES.blueprint) {
    data.mode = configuration.directorStudioMode;
  }
  if (
    configuration.enabled !== undefined
    && (command.input.nodeType === CANVAS_NODE_TYPES.tag
      || command.input.nodeType === CANVAS_NODE_TYPES.tagGroup)
  ) {
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
      ? resolveAgentNodeCreationPosition(command, draft.nodes)
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
      nodes: survivingNodes,
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
  ].filter((entry) => entry[1] !== undefined).map(([key]) => key as string);
  const allowedFields = node.type === CANVAS_NODE_TYPES.aiText
    ? new Set(['providerId'])
    : node.type === CANVAS_NODE_TYPES.aiAudio
      ? new Set(['extraParams'])
      : node.type === CANVAS_NODE_TYPES.aiVideo
        ? new Set(['aspectRatio', 'resolution', 'duration', 'extraParams'])
        : new Set(['aspectRatio', 'resolution', 'extraParams']);
  return providedOptionalFields.filter((field) => !allowedFields.has(field));
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
  const selectedNodes = selected as CanvasNode[];
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
  const unsupportedId = nodeIds.find((nodeId) => {
    const node = nodesById.get(nodeId);
    return node?.type !== CANVAS_NODE_TYPES.tag && node?.type !== CANVAS_NODE_TYPES.tagGroup;
  });
  if (unsupportedId) {
    return reject(`Node ${unsupportedId} does not support enabled state.`, 'unsupported_command');
  }
  const idSet = new Set(nodeIds);
  let changed = false;
  const nodes = draft.nodes.map((node) => {
    if (!idSet.has(node.id) || node.data.enabled === command.input.enabled) return node;
    changed = true;
    return { ...node, data: { ...node.data, enabled: command.input.enabled } as CanvasNodeData };
  });
  return success(
    { ...draft, nodes },
    impact(`${command.input.enabled ? 'Enable' : 'Disable'} ${nodeIds.length} tag item(s).`, {
      affectedNodeIds: nodeIds,
    }),
    { references: { nodeIds } },
    changed,
  );
}

function visibleTagMetadata(node: CanvasNode): Partial<CanvasNodeData> | null {
  if (isTagNode(node)) {
    return {
      displayName: node.data.displayName,
      label: node.data.label,
      enabled: node.data.enabled,
      color: node.data.color,
    } as Partial<CanvasNodeData>;
  }
  if (isTagGroupNode(node)) {
    return {
      displayName: node.data.displayName,
      label: node.data.label,
      enabled: node.data.enabled,
      color: node.data.color,
      shape: node.data.shape,
      schemaVersion: 2,
      memberNodeIds: [...node.data.memberNodeIds],
      unresolvedMemberIds: [...(node.data.unresolvedMemberIds ?? [])],
      legacyMemberTagIds: [...(node.data.legacyMemberTagIds ?? [])],
    } as Partial<CanvasNodeData>;
  }
  return null;
}

function applyDuplicateNodes(
  command: Extract<CanvasCommand, { type: 'node.duplicate' }>,
  draft: CanvasGraphDraft,
  nodeFactory: NodeFactory,
): CanvasGraphCommandPreparation {
  const existingIds = new Set(draft.nodes.map((node) => node.id));
  const requestedIds = new Set<string>();
  const createdNodes: CanvasNode[] = [];
  const sourceToCreated = new Map<string, string>();

  for (const copy of command.input.copies) {
    const source = draft.nodes.find((node) => node.id === copy.sourceNodeId);
    if (!source) return reject(`Node ${copy.sourceNodeId} does not exist.`, 'not_found');
    const data = visibleTagMetadata(source);
    if (!data) {
      return reject(`Node ${source.id} cannot be duplicated through the safe tag command.`, 'unsupported_command');
    }
    if (copy.nodeId && (existingIds.has(copy.nodeId) || requestedIds.has(copy.nodeId))) {
      return reject(`Node ${copy.nodeId} already exists.`, 'conflict');
    }
    const created = nodeFactory.createNode(
      source.type,
      copy.position ?? { x: source.position.x + 44, y: source.position.y + 30 },
      data,
    );
    if (copy.nodeId) created.id = copy.nodeId;
    requestedIds.add(created.id);
    createdNodes.push(created);
    sourceToCreated.set(source.id, created.id);
  }

  const createdIds = createdNodes.map((node) => node.id);
  return success(
    { ...draft, nodes: [...draft.nodes, ...createdNodes] },
    impact(`Duplicate ${createdNodes.length} tag item(s) without graph edges.`, {
      affectedNodeIds: [
        ...Array.from(sourceToCreated.keys()),
        ...createdIds,
      ],
      creates: {
        nodes: createdNodes.length,
        edges: 0,
        groups: createdNodes.filter((node) => node.type === CANVAS_NODE_TYPES.tagGroup).length,
      },
    }),
    {
      references: { nodeIds: createdIds },
      value: { sourceToCreated: Object.fromEntries(sourceToCreated) },
    },
    createdNodes.length > 0,
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
    return reject(validation.message ?? 'Cannot connect these nodes.', code);
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
    while (parentId) {
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
  const groupX = Math.round(bounds.minX - 20);
  const groupY = Math.round(bounds.minY - 34);
  const groupName = command.input.displayName?.trim()
    || `组 ${draft.nodes.filter((node) => node.type === CANVAS_NODE_TYPES.group).length + 1}`;
  const group = nodeFactory.createNode(CANVAS_NODE_TYPES.group, { x: groupX, y: groupY }, {
    displayName: groupName,
    label: groupName,
  } as Partial<CanvasNodeData>);
  if (command.input.groupId) {
    group.id = command.input.groupId;
  }
  group.style = {
    width: Math.max(220, Math.round(bounds.maxX - bounds.minX + 40)),
    height: Math.max(140, Math.round(bounds.maxY - bounds.minY + 54)),
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
      position: { x: Math.round(absolute.x - groupX), y: Math.round(absolute.y - groupY) },
      selected: false,
    });
  });
  return success(
    { ...draft, nodes, selectedNodeId: group.id },
    impact(`Group ${memberIds.length} node(s).`, {
      affectedNodeIds: [group.id, ...memberIds],
      creates: { nodes: 1, edges: 0, groups: 1 },
    }),
    { references: { nodeId: group.id, nodeIds: [group.id, ...memberIds] } },
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
    const nodesById = new Map(nextDraft.nodes.map((node) => [node.id, node] as const));
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
              parentId: undefined,
              extent: undefined,
              position: resolveAbsolutePosition(node, nodesById),
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
    case 'node.duplicate':
      return applyDuplicateNodes(command, draft, nodeFactory);
    case 'storyboard.update':
      return applyStoryboardUpdate(command, draft);
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
