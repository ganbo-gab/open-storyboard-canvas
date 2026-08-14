import type { CanvasCommandOrigin, CanvasCommandType } from './canvasCommands';
import {
  CANVAS_NODE_TYPES,
  type CanvasNodeType,
} from './canvasNodes';

export type CanvasCapabilityStatus = 'supported' | 'ui-only' | 'deferred';

export interface CanvasCapabilityDeclaration {
  status: CanvasCapabilityStatus;
  reason?: string;
}

export interface CanvasNodeCapabilityDeclaration extends CanvasCapabilityDeclaration {
  commands: CanvasCommandType[];
  directCreate: boolean;
  directCreateReason?: string;
}

const COMMON_NODE_COMMANDS: CanvasCommandType[] = [
  'canvas.query',
  'node.delete',
  'node.rename',
  'node.move',
  'node.layout',
  'group.create',
  'selection.set',
  'viewport.focus',
];

const TAG_NODE_COMMANDS: CanvasCommandType[] = [
  ...COMMON_NODE_COMMANDS,
  'node.setEnabled',
  'node.duplicate',
  'tag.setColor',
  'edge.connect',
  'edge.disconnect',
];

const TAG_GROUP_NODE_COMMANDS: CanvasCommandType[] = [
  ...COMMON_NODE_COMMANDS,
  'node.setEnabled',
  'node.duplicate',
  'tagGroup.setAppearance',
  'tagGroup.setMembers',
  'edge.connect',
  'edge.disconnect',
];

const GENERATION_NODE_COMMANDS: CanvasCommandType[] = [
  ...COMMON_NODE_COMMANDS,
  'node.setPrompt',
  'node.setModelConfig',
  'generation.submit',
  'generation.status',
  'generation.locateResult',
];

const IMAGE_TOOL_NODE_COMMANDS: CanvasCommandType[] = [
  ...COMMON_NODE_COMMANDS,
  'node.tool.run',
];

export const CANVAS_GENERATION_NODE_TYPES = [
  CANVAS_NODE_TYPES.imageEdit,
  CANVAS_NODE_TYPES.aiVideo,
  CANVAS_NODE_TYPES.aiText,
  CANVAS_NODE_TYPES.aiAudio,
  CANVAS_NODE_TYPES.storyboardGen,
  CANVAS_NODE_TYPES.panorama,
] as const satisfies readonly CanvasNodeType[];

export const canvasNodeCapabilityManifest = {
  [CANVAS_NODE_TYPES.upload]: { status: 'supported', commands: IMAGE_TOOL_NODE_COMMANDS, directCreate: true },
  [CANVAS_NODE_TYPES.imageEdit]: { status: 'supported', commands: [...GENERATION_NODE_COMMANDS, 'node.tool.run'], directCreate: true },
  [CANVAS_NODE_TYPES.aiVideo]: { status: 'supported', commands: GENERATION_NODE_COMMANDS, directCreate: true },
  [CANVAS_NODE_TYPES.aiText]: { status: 'supported', commands: GENERATION_NODE_COMMANDS, directCreate: true },
  [CANVAS_NODE_TYPES.aiAudio]: { status: 'supported', commands: GENERATION_NODE_COMMANDS, directCreate: true },
  [CANVAS_NODE_TYPES.exportImage]: {
    status: 'supported',
    commands: [...COMMON_NODE_COMMANDS, 'asset.list', 'asset.locate', 'node.tool.run'],
    directCreate: false,
    directCreateReason: 'Image result nodes are created by validated generation or export workflows.',
  },
  [CANVAS_NODE_TYPES.video]: {
    status: 'supported',
    commands: [...COMMON_NODE_COMMANDS, 'asset.list', 'asset.locate'],
    directCreate: false,
    directCreateReason: 'Video result nodes are created by upload or generation workflows.',
  },
  [CANVAS_NODE_TYPES.audio]: {
    status: 'supported',
    commands: [...COMMON_NODE_COMMANDS, 'asset.list', 'asset.locate'],
    directCreate: false,
    directCreateReason: 'Audio result nodes are created by upload or generation workflows.',
  },
  [CANVAS_NODE_TYPES.textAnnotation]: {
    status: 'supported',
    commands: [...COMMON_NODE_COMMANDS, 'node.setPrompt'],
    directCreate: true,
  },
  [CANVAS_NODE_TYPES.jsonCard]: { status: 'supported', commands: COMMON_NODE_COMMANDS, directCreate: true },
  [CANVAS_NODE_TYPES.group]: {
    status: 'supported',
    commands: ['canvas.query', 'node.delete', 'node.rename', 'node.move', 'group.ungroup', 'selection.set', 'viewport.focus'],
    directCreate: false,
    directCreateReason: 'Groups must be created with group.create so membership remains valid.',
  },
  [CANVAS_NODE_TYPES.tag]: {
    status: 'supported',
    commands: TAG_NODE_COMMANDS,
    directCreate: true,
  },
  [CANVAS_NODE_TYPES.tagGroup]: {
    status: 'supported',
    commands: TAG_GROUP_NODE_COMMANDS,
    directCreate: true,
  },
  [CANVAS_NODE_TYPES.storyboardSplit]: {
    status: 'supported',
    commands: [...COMMON_NODE_COMMANDS, 'storyboard.update', 'asset.list', 'asset.locate'],
    directCreate: false,
    directCreateReason: 'Storyboard split nodes require validated frame data from the split workflow.',
  },
  [CANVAS_NODE_TYPES.storyboardGen]: { status: 'supported', commands: GENERATION_NODE_COMMANDS, directCreate: true },
  [CANVAS_NODE_TYPES.panorama]: {
    status: 'supported',
    commands: [...COMMON_NODE_COMMANDS, 'panorama.update', 'asset.list', 'asset.locate', 'generation.submit', 'generation.status', 'generation.locateResult'],
    directCreate: true,
  },
  [CANVAS_NODE_TYPES.blueprint]: {
    status: 'supported',
    commands: [...COMMON_NODE_COMMANDS, 'director.update', 'director.open', 'director.record', 'asset.list', 'asset.locate'],
    directCreate: true,
  },
} satisfies Record<CanvasNodeType, CanvasNodeCapabilityDeclaration>;

export const CANVAS_AGENT_DIRECT_CREATE_NODE_TYPES = Object.freeze(
  (Object.entries(canvasNodeCapabilityManifest) as Array<[CanvasNodeType, CanvasNodeCapabilityDeclaration]>)
    .filter(([, capability]) => capability.status === 'supported' && capability.directCreate)
    .map(([nodeType]) => nodeType),
);

export const canvasActionCapabilityManifest = {
  'canvas.query': { status: 'supported' },
  'node.create': { status: 'supported' },
  'node.delete': { status: 'supported' },
  'node.rename': { status: 'supported' },
  'node.setPrompt': { status: 'supported' },
  'node.setModelConfig': { status: 'supported' },
  'node.move': { status: 'supported' },
  'node.layout': { status: 'supported' },
  'node.setEnabled': { status: 'supported' },
  'node.duplicate': { status: 'supported' },
  'node.tool.run': { status: 'supported' },
  'storyboard.update': { status: 'supported' },
  'panorama.update': { status: 'supported' },
  'director.update': { status: 'supported' },
  'director.open': { status: 'supported' },
  'director.record': { status: 'supported' },
  'tag.setColor': { status: 'supported' },
  'tagGroup.setMembers': { status: 'supported' },
  'tagGroup.setAppearance': { status: 'supported' },
  'edge.connect': { status: 'supported' },
  'edge.disconnect': { status: 'supported' },
  'group.create': { status: 'supported' },
  'group.ungroup': { status: 'supported' },
  'selection.set': { status: 'supported' },
  'viewport.focus': { status: 'supported' },
  'asset.list': { status: 'supported' },
  'asset.locate': { status: 'supported' },
  'generation.submit': { status: 'supported' },
  'generation.recover': { status: 'supported' },
  'generation.status': { status: 'supported' },
  'generation.locateResult': { status: 'supported' },
} satisfies Record<CanvasCommandType, CanvasCapabilityDeclaration>;

export interface CanvasCapabilityCoverageInput {
  nodeTypes: readonly string[];
  actionIds: readonly string[];
  generationNodeTypes: readonly string[];
}

export interface CanvasCapabilityCoverageResult {
  covered: boolean;
  missingNodeTypes: string[];
  staleNodeTypes: string[];
  missingActionIds: string[];
  staleActionIds: string[];
  missingGenerationStrategies: string[];
  staleGenerationStrategies: string[];
}

function difference(left: readonly string[], right: readonly string[]): string[] {
  const rightSet = new Set(right);
  return Array.from(new Set(left)).filter((value) => !rightSet.has(value)).sort();
}

export function inspectCanvasCapabilityCoverage(
  input: CanvasCapabilityCoverageInput,
): CanvasCapabilityCoverageResult {
  const declaredNodeTypes = Object.keys(canvasNodeCapabilityManifest);
  const declaredActionIds = Object.keys(canvasActionCapabilityManifest);
  const declaredGenerationTypes = CANVAS_GENERATION_NODE_TYPES as readonly string[];
  const missingNodeTypes = difference(input.nodeTypes, declaredNodeTypes);
  const staleNodeTypes = difference(declaredNodeTypes, input.nodeTypes);
  const missingActionIds = difference(input.actionIds, declaredActionIds);
  const staleActionIds = difference(declaredActionIds, input.actionIds);
  const missingGenerationStrategies = difference(input.generationNodeTypes, declaredGenerationTypes);
  const staleGenerationStrategies = difference(declaredGenerationTypes, input.generationNodeTypes);

  return {
    covered: [
      missingNodeTypes,
      staleNodeTypes,
      missingActionIds,
      staleActionIds,
      missingGenerationStrategies,
      staleGenerationStrategies,
    ].every((values) => values.length === 0),
    missingNodeTypes,
    staleNodeTypes,
    missingActionIds,
    staleActionIds,
    missingGenerationStrategies,
    staleGenerationStrategies,
  };
}

export const canvasCapabilityManifest = {
  nodes: canvasNodeCapabilityManifest,
  actions: canvasActionCapabilityManifest,
  generationNodeTypes: CANVAS_GENERATION_NODE_TYPES,
};

export function canCreateCanvasNodeDirectly(
  nodeType: CanvasNodeType,
  origin: CanvasCommandOrigin = 'agent',
): boolean {
  const capability = canvasNodeCapabilityManifest[nodeType];
  return capability.directCreate
    && (origin === 'ui' || capability.status === 'supported');
}
