import {
  CANVAS_COMMAND_VERSION,
  type CanvasCommand,
  type CanvasCommandEffect,
  type CanvasCommandError,
  type CanvasCommandErrorCode,
  type CanvasCommandExecutionResult,
  type CanvasCommandImpact,
  type CanvasCommandOrigin,
  type CanvasCommandOutput,
  type CanvasCommandSchema,
  type CanvasCommandType,
  type CanvasJsonSchema,
  type CanvasTransaction,
  type CanvasTransactionPreview,
  type CanvasTransactionResult,
} from '../domain/canvasCommands';
import {
  CANVAS_AGENT_DIRECT_CREATE_NODE_TYPES,
  canCreateCanvasNodeDirectly,
  canvasNodeCapabilityManifest,
  type CanvasNodeCapabilityDeclaration,
} from '../domain/canvasCapabilities';
import {
  CANVAS_NODE_TYPES,
  TAG_COLORS,
  TAG_GROUP_SHAPES,
  isTagNode,
  type CanvasNodeType,
} from '../domain/canvasNodes';
import {
  buildCanvasAssetCatalog,
  projectCanvasAssetCatalogItem,
} from './canvasAssetCatalog';
import { projectCanvasNodeForRead } from './canvasReadProjection';
import type { NodeFactory } from './ports';
import { CanvasGenerationFacade } from './canvasGenerationFacade';
import { CanvasNavigationFacade } from './canvasNavigationFacade';
import {
  CanvasTransactionCoordinator,
  type CanvasCommandStorePort,
  type CanvasGraphCommandPreparation,
  type CanvasGraphDraft,
} from './canvasTransactionCoordinator';
import {
  applyCanvasGraphCommand,
  CANVAS_GRAPH_COMMAND_TYPES,
} from './canvasCommandGraph';
import {
  collectInputReferences,
  inspectTagGraphState,
} from './graphReferenceResolver';
import { isAgentCanvasToolType, type CanvasToolWorkflowFacade } from './canvasToolWorkflowFacade';
import type { CanvasEventBus } from './ports';

export interface CanvasCommandDefinition {
  type: CanvasCommandType;
  effect: CanvasCommandEffect;
  schema: CanvasCommandSchema;
  summarize: (command: CanvasCommand) => string;
}

export interface CanvasCommandRegistryDependencies {
  store: CanvasCommandStorePort;
  nodeFactory: NodeFactory;
  navigation: CanvasNavigationFacade;
  generation: CanvasGenerationFacade;
  tools: CanvasToolWorkflowFacade;
  eventBus: CanvasEventBus;
  nextTransactionId?: () => string;
}

function objectSchema(
  required: string[],
  properties: Record<string, CanvasJsonSchema['properties'][string]>,
): CanvasJsonSchema {
  return { type: 'object', additionalProperties: false, required, properties };
}

const stringField = (description: string, values?: readonly string[]) => ({
  type: 'string' as const,
  description,
  ...(values ? { enum: values } : {}),
});
const numberField = (description: string) => ({ type: 'number' as const, description });
const booleanField = (description: string) => ({ type: 'boolean' as const, description });
const arrayField = (description: string, items?: CanvasJsonSchema['properties'][string]) => ({
  type: 'array' as const,
  description,
  ...(items ? { items } : {}),
});
const objectField = (
  description: string,
  properties?: Record<string, CanvasJsonSchema['properties'][string]>,
  required?: string[],
  additionalProperties?: boolean,
) => ({
  type: 'object' as const,
  description,
  ...(properties ? { properties } : {}),
  ...(required ? { required } : {}),
  ...(additionalProperties !== undefined ? { additionalProperties } : {}),
});

const finitePositionField = objectField('Finite canvas position hint; the application may move it to nearby empty space.', {
  x: numberField('Finite canvas X coordinate.'),
  y: numberField('Finite canvas Y coordinate.'),
}, ['x', 'y'], false);

const createConfigurationField = objectField('Allowed create-time configuration. Use aspectRatio (not ratio) and resolution (not size).', {
  displayName: stringField('Optional visible node title.'),
  prompt: stringField('Generation prompt.'),
  content: stringField('Text annotation content.'),
  modelId: stringField('Exact configured catalog model id.'),
  providerId: stringField('Optional configured text provider id.'),
  aspectRatio: stringField('Requested ratio such as 16:9.'),
  resolution: stringField('Requested resolution such as 2K.'),
  duration: stringField('Requested video duration.'),
  extraParams: objectField('Bounded model-specific parameters.', undefined, undefined, true),
  openDirectorStudio: booleanField('Open Director Studio after creation.'),
  directorStudioMode: stringField('Director Studio mode.', ['flat', 'panorama']),
  enabled: booleanField('Whether a tag or tag group is enabled.'),
  tagColor: stringField('Legacy tag color.', TAG_COLORS),
  memberNodeIds: arrayField('Direct tag-group member node ids.', stringField('Canvas node id.')),
  tagGroupColor: stringField('Tag-group color.', TAG_COLORS),
  tagGroupShape: stringField('Tag-group shape.', TAG_GROUP_SHAPES),
}, [], false);

const EFFECTS: Record<CanvasCommandType, CanvasCommandEffect> = {
  'canvas.query': 'read',
  'node.create': 'graph',
  'node.delete': 'graph',
  'node.rename': 'graph',
  'node.setPrompt': 'graph',
  'node.setModelConfig': 'graph',
  'node.move': 'graph',
  'node.layout': 'graph',
  'node.setEnabled': 'graph',
  'node.duplicate': 'graph',
  'node.tool.run': 'generation',
  'storyboard.update': 'graph',
  'panorama.update': 'graph',
  'director.update': 'graph',
  'director.open': 'navigation',
  'director.record': 'generation',
  'tag.setColor': 'graph',
  'tagGroup.setMembers': 'graph',
  'tagGroup.setAppearance': 'graph',
  'edge.connect': 'graph',
  'edge.disconnect': 'graph',
  'group.create': 'graph',
  'group.ungroup': 'graph',
  'selection.set': 'navigation',
  'viewport.focus': 'navigation',
  'asset.list': 'read',
  'asset.locate': 'navigation',
  'generation.submit': 'generation',
  'generation.recover': 'generation',
  'generation.status': 'read',
  'generation.locateResult': 'navigation',
};

const INPUT_SCHEMAS: Record<CanvasCommandType, CanvasJsonSchema> = {
  'canvas.query': objectSchema(['scope'], {
    scope: stringField('Bounded projection to return.', ['graph', 'nodes', 'edges', 'selection']),
    nodeIds: arrayField('Optional node id filter.'),
    limit: numberField('Maximum number of records.'),
  }),
  'node.create': objectSchema(['nodeType', 'position'], {
    nodeType: stringField(
      'Exact registered directly creatable canvas node type. For image generation use imageNode.',
      CANVAS_AGENT_DIRECT_CREATE_NODE_TYPES,
    ),
    position: finitePositionField,
    nodeId: stringField('Optional caller-provided stable node id.'),
    dimensions: objectField('Optional finite positive initial dimensions.', {
      width: numberField('Positive width.'),
      height: numberField('Positive height.'),
    }, ['width', 'height'], false),
    configuration: createConfigurationField,
  }),
  'node.delete': objectSchema(['nodeIds'], { nodeIds: arrayField('Node ids to delete with descendants.') }),
  'node.rename': objectSchema(['nodeId', 'displayName'], {
    nodeId: stringField('Node id.'),
    displayName: stringField('New display name.'),
  }),
  'node.setPrompt': objectSchema(['nodeId', 'prompt'], {
    nodeId: stringField('Prompt-capable node id.'),
    prompt: stringField('New prompt or annotation content.'),
  }),
  'node.setModelConfig': objectSchema(['nodeId', 'modelId'], {
    nodeId: stringField('Generation node id.'),
    modelId: stringField('Catalog model id.'),
    providerId: stringField('Optional provider id.'),
    aspectRatio: stringField('Optional request ratio.'),
    resolution: stringField('Optional video resolution.'),
    duration: stringField('Optional video duration.'),
    extraParams: objectField('Model-specific validated parameter values.'),
  }),
  'node.move': objectSchema(['positions'], { positions: arrayField('Node id and finite position records.') }),
  'node.layout': objectSchema(['nodeIds', 'direction'], {
    nodeIds: arrayField('Node ids to lay out.'),
    direction: stringField('horizontal, vertical, or grid.'),
    origin: objectField('Optional canvas origin.'),
    gap: numberField('Optional non-negative gap.'),
    columns: numberField('Optional positive grid column count.'),
  }),
  'node.setEnabled': objectSchema(['nodeIds', 'enabled'], {
    nodeIds: arrayField('Tag or tag-group node ids to update atomically.'),
    enabled: booleanField('Whether references through these tags remain active.'),
  }),
  'node.duplicate': objectSchema(['copies'], {
    copies: arrayField('Metadata-only tag or tag-group copy records.'),
  }),
  'node.tool.run': objectSchema(['nodeId', 'toolType'], {
    nodeId: stringField('Image source node id.'),
    toolType: stringField('Registered image or storyboard tool type.'),
    options: objectField('Bounded tool-specific options.'),
  }),
  'storyboard.update': objectSchema(['nodeId'], {
    nodeId: stringField('Storyboard split node id.'),
    frames: arrayField('Frame note/order patches.'),
    exportOptions: objectField('Storyboard export display options.'),
  }),
  'panorama.update': objectSchema(['nodeId'], {
    nodeId: stringField('Panorama node id.'),
    sourceMode: stringField('text or image.'),
    sourceAssetId: stringField('Stable source image asset id.'),
    sourcePrompt: stringField('Panorama generation prompt.'),
    projection: stringField('spherical or cylindrical.'),
    smartBase: booleanField('Use the panorama base-image constraint.'),
    initialYaw: numberField('Initial viewer yaw.'),
    initialPitch: numberField('Initial viewer pitch.'),
    initialFov: numberField('Initial viewer field of view.'),
  }),
  'director.update': objectSchema(['nodeId'], {
    nodeId: stringField('Director Studio node id.'),
    mode: stringField('flat or panorama.'),
    basePrompt: stringField('Scene prompt.'),
    aspectRatio: stringField('Canvas aspect ratio.'),
    aspectFrame: stringField('Director aspect frame.'),
    screenshotResolution: stringField('Screenshot resolution.'),
    themeColor: stringField('Director Studio theme color.'),
    backgroundAssetId: stringField('Stable background image asset id.'),
    backgroundPanoramaAssetId: stringField('Stable panorama background asset id.'),
    referenceAssetIds: arrayField('Stable reference asset ids.'),
    items: arrayField('Structured Director Studio scene items.'),
    customActionPresets: arrayField('Custom action names.'),
    customActionPoses: objectField('Custom action poses.'),
    camera: objectField('Camera settings.'),
    lighting: objectField('Lighting settings.'),
    grid: objectField('Grid settings.'),
    viewSettings: objectField('View settings.'),
    shortcuts: objectField('Shortcut bindings.'),
    motionProject: objectField('Versioned Director Studio motion project, or null.'),
  }),
  'director.open': objectSchema(['nodeId'], {
    nodeId: stringField('Director Studio node id.'),
    focus: booleanField('Focus the owning canvas node before opening.'),
  }),
  'director.record': objectSchema(['nodeId', 'resolution', 'fps'], {
    nodeId: stringField('Director Studio node id.'),
    resolution: stringField('720p or 1080p.'),
    fps: numberField('24 or 30 frames per second.'),
    addToCanvas: booleanField('Create and locate a canvas video node after recording.'),
  }),
  'tag.setColor': objectSchema(['tagId', 'color'], {
    tagId: stringField('Tag node id.'),
    color: stringField('Registered semantic tag color.'),
  }),
  'tagGroup.setMembers': objectSchema(['groupId', 'memberNodeIds'], {
    groupId: stringField('Tag-group node id.'),
    memberNodeIds: arrayField('Explicit direct image, video, and text member node ids.'),
  }),
  'tagGroup.setAppearance': objectSchema(['groupId'], {
    groupId: stringField('Tag-group node id.'),
    color: stringField('Registered semantic group color.'),
    shape: stringField('rectangle, rounded, or frame.'),
  }),
  'edge.connect': objectSchema(['sourceNodeId', 'targetNodeId'], {
    sourceNodeId: stringField('Source node id.'),
    targetNodeId: stringField('Target node id.'),
    edgeId: stringField('Optional caller-provided stable edge id.'),
  }),
  'edge.disconnect': objectSchema(['edgeIds'], { edgeIds: arrayField('Edge ids to delete.') }),
  'group.create': objectSchema(['nodeIds'], {
    nodeIds: arrayField('Member node ids.'),
    groupId: stringField('Optional caller-provided stable group id.'),
    displayName: stringField('Optional group display name.'),
  }),
  'group.ungroup': objectSchema(['groupIds'], { groupIds: arrayField('Group ids to dissolve.') }),
  'selection.set': objectSchema(['nodeIds'], { nodeIds: arrayField('Node ids to select, or empty to clear.') }),
  'viewport.focus': objectSchema(['nodeIds'], {
    nodeIds: arrayField('Node ids to focus.'),
    padding: numberField('Viewport padding from zero to one.'),
    select: booleanField('Whether to select focused nodes.'),
  }),
  'asset.list': objectSchema([], {
    kind: stringField('Optional image, video, or audio filter.'),
    query: stringField('Optional case-insensitive title, source, or asset id search.'),
    nodeIds: arrayField('Optional exact owning node ids.'),
    relatedToNodeIds: arrayField('Optional node ids whose direct graph neighbors should be searched.'),
    selectedOnly: booleanField('Only return assets owned by selected nodes.'),
    region: objectField('Optional finite canvas rectangle with x, y, width, and height.'),
    limit: numberField('Maximum number of assets.'),
  }),
  'asset.locate': objectSchema(['assetId'], {
    assetId: stringField('Stable asset id from asset.list.'),
    select: booleanField('Whether to select the asset node.'),
  }),
  'generation.submit': objectSchema(['nodeIds'], { nodeIds: arrayField('Generation-capable node ids.') }),
  'generation.recover': objectSchema(['jobId'], {
    jobId: stringField('Persisted generation job id with a safe upstream handle.'),
    nodeIds: arrayField('Optional canvas nodes already associated with this job.'),
  }),
  'generation.status': objectSchema([], {
    nodeId: stringField('Generation node id.'),
    jobId: stringField('Stable generation job id.'),
  }),
  'generation.locateResult': objectSchema([], {
    nodeId: stringField('Generation node id.'),
    jobId: stringField('Stable generation job id.'),
    select: booleanField('Whether to select the result node.'),
  }),
};

export const CANVAS_REGISTERED_COMMAND_TYPES = Object.freeze(
  Object.keys(INPUT_SCHEMAS) as CanvasCommandType[],
);

function summarizeCommand(command: CanvasCommand): string {
  switch (command.type) {
    case 'node.setPrompt':
      return `Update prompt for node ${command.input.nodeId} (${command.input.prompt.length} characters).`;
    case 'node.setModelConfig':
      return `Update model configuration for node ${command.input.nodeId}.`;
    case 'node.create':
      return `Create ${command.input.nodeType} node.`;
    case 'node.setEnabled':
      return `${command.input.enabled ? 'Enable' : 'Disable'} ${command.input.nodeIds.length} tag item(s).`;
    case 'node.duplicate':
      return `Duplicate ${command.input.copies.length} tag item(s) without edges.`;
    case 'tag.setColor':
      return `Update tag ${command.input.tagId} color.`;
    case 'tagGroup.setMembers':
      return `Update tag group ${command.input.groupId} membership.`;
    case 'tagGroup.setAppearance':
      return `Update tag group ${command.input.groupId} appearance.`;
    case 'generation.submit':
      return `Submit generation for ${command.input.nodeIds.length} node(s).`;
    case 'generation.recover':
      return `Retrieve the existing result for job ${command.input.jobId}; no generation request will be submitted.`;
    case 'node.tool.run':
      return `Run ${command.input.toolType} on node ${command.input.nodeId}.`;
    case 'storyboard.update':
      return `Update storyboard node ${command.input.nodeId}.`;
    case 'panorama.update':
      return `Update panorama node ${command.input.nodeId}.`;
    case 'director.update':
      return `Update Director Studio node ${command.input.nodeId}.`;
    case 'director.open':
      return `Open Director Studio node ${command.input.nodeId}.`;
    case 'director.record':
      return `Record Director Studio node ${command.input.nodeId} at ${command.input.resolution}/${command.input.fps}fps.`;
    default:
      return `${command.type} command.`;
  }
}

function createDefinitions(): Map<CanvasCommandType, CanvasCommandDefinition> {
  return new Map(CANVAS_REGISTERED_COMMAND_TYPES.map((type) => [type, {
    type,
    effect: EFFECTS[type],
    schema: { commandType: type, version: CANVAS_COMMAND_VERSION, input: INPUT_SCHEMAS[type] },
    summarize: summarizeCommand,
  }]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isCanvasCommandOrigin(value: unknown): value is CanvasCommandOrigin {
  return value === 'ui' || value === 'agent' || value === 'system';
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function validateFinitePosition(value: unknown, label: string, errors: string[]): void {
  if (!isPlainRecord(value)
    || !hasOnlyKeys(value, ['x', 'y'])
    || !Object.prototype.hasOwnProperty.call(value, 'x')
    || !Object.prototype.hasOwnProperty.call(value, 'y')
    || !Number.isFinite(value.x)
    || !Number.isFinite(value.y)) {
    errors.push(`${label} must contain only finite x and y values.`);
  }
}

function validateString(value: unknown, label: string, errors: string[], allowEmpty = false): void {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) {
    errors.push(`${label} must be a ${allowEmpty ? '' : 'non-empty '}string.`);
  }
}

function validateStringArray(value: unknown, label: string, errors: string[], allowEmpty = false): void {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    errors.push(`${label} must be ${allowEmpty ? 'an' : 'a non-empty'} array.`);
    return;
  }
  if (value.some((item) => typeof item !== 'string' || !item.trim())) {
    errors.push(`${label} must contain only non-empty strings.`);
  }
}

function validateJsonConfiguration(
  value: unknown,
  label: string,
  errors: string[],
  depth = 0,
): void {
  if (depth > 6) {
    errors.push(`${label} cannot exceed 6 nested levels.`);
    return;
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) errors.push(`${label} numbers must be finite.`);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 100) errors.push(`${label} arrays cannot exceed 100 items.`);
    value.slice(0, 100).forEach((item, index) => {
      validateJsonConfiguration(item, `${label}[${index}]`, errors, depth + 1);
    });
    return;
  }
  if (!isPlainRecord(value)) {
    errors.push(`${label} must contain only JSON-compatible values.`);
    return;
  }
  const entries = Object.entries(value);
  if (entries.length > 100) errors.push(`${label} objects cannot exceed 100 fields.`);
  for (const [key, child] of entries.slice(0, 100)) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (['__proto__', 'prototype', 'constructor'].includes(key)) {
      errors.push(`${label}.${key} is not allowed.`);
      continue;
    }
    if ([
      'apikey',
      'xapikey',
      'authorization',
      'proxyauthorization',
      'cookie',
      'setcookie',
      'token',
      'accesstoken',
      'refreshtoken',
      'idtoken',
      'bearertoken',
      'password',
      'passwd',
      'secret',
      'clientsecret',
      'privatekey',
      'secretkey',
      'credential',
      'credentials',
    ].includes(normalizedKey)
      || normalizedKey.includes('apikey')
      || /(?:access|refresh|id|bearer)token(?:value)?$/.test(normalizedKey)
      || /(?:clientsecret|privatekey|secretkey|password|passwd|credentials?)$/.test(normalizedKey)) {
      errors.push(`${label}.${key} cannot contain credentials; use the approved settings workflow.`);
      continue;
    }
    validateJsonConfiguration(child, `${label}.${key}`, errors, depth + 1);
  }
}

function allowedCreateConfigurationKeys(nodeType: CanvasNodeType): Set<string> {
  const common = ['displayName'];
  switch (nodeType) {
    case CANVAS_NODE_TYPES.imageEdit:
    case CANVAS_NODE_TYPES.storyboardGen:
      return new Set([...common, 'prompt', 'modelId', 'aspectRatio', 'resolution', 'extraParams']);
    case CANVAS_NODE_TYPES.aiVideo:
      return new Set([...common, 'prompt', 'modelId', 'aspectRatio', 'resolution', 'duration', 'extraParams']);
    case CANVAS_NODE_TYPES.aiText:
      return new Set([...common, 'prompt', 'modelId', 'providerId']);
    case CANVAS_NODE_TYPES.aiAudio:
      return new Set([...common, 'prompt', 'modelId']);
    case CANVAS_NODE_TYPES.textAnnotation:
      return new Set([...common, 'content']);
    case CANVAS_NODE_TYPES.upload:
    case CANVAS_NODE_TYPES.panorama:
      return new Set([...common, 'aspectRatio']);
    case CANVAS_NODE_TYPES.blueprint:
      return new Set([...common, 'aspectRatio', 'openDirectorStudio', 'directorStudioMode']);
    case CANVAS_NODE_TYPES.tag:
      return new Set([...common, 'enabled', 'tagColor']);
    case CANVAS_NODE_TYPES.tagGroup:
      return new Set([...common, 'enabled', 'memberNodeIds', 'tagGroupColor', 'tagGroupShape']);
    default:
      return new Set(common);
  }
}

function validateCreateConfiguration(
  nodeType: CanvasNodeType,
  value: unknown,
  errors: string[],
): void {
  if (!isPlainRecord(value)) {
    errors.push('configuration must be an object.');
    return;
  }
  const allowedKeys = allowedCreateConfigurationKeys(nodeType);
  const unknownConfigurationKey = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unknownConfigurationKey) {
    errors.push(`Unknown or unsupported ${nodeType} create configuration field: ${unknownConfigurationKey}.`);
  }
  if ('displayName' in value) {
    validateString(value.displayName, 'configuration.displayName', errors);
    if (typeof value.displayName === 'string' && value.displayName.length > 200) {
      errors.push('configuration.displayName cannot exceed 200 characters.');
    }
  }
  if ('prompt' in value) {
    validateString(value.prompt, 'configuration.prompt', errors, true);
    if (typeof value.prompt === 'string' && value.prompt.length > 100_000) {
      errors.push('configuration.prompt cannot exceed 100000 characters.');
    }
  }
  if ('content' in value) {
    validateString(value.content, 'configuration.content', errors, true);
    if (typeof value.content === 'string' && value.content.length > 100_000) {
      errors.push('configuration.content cannot exceed 100000 characters.');
    }
  }
  if ('modelId' in value) validateString(value.modelId, 'configuration.modelId', errors);
  if ('providerId' in value && value.providerId !== null) {
    validateString(value.providerId, 'configuration.providerId', errors);
  }
  if ('aspectRatio' in value) validateString(value.aspectRatio, 'configuration.aspectRatio', errors);
  if ('resolution' in value) validateString(value.resolution, 'configuration.resolution', errors);
  if ('duration' in value) validateString(value.duration, 'configuration.duration', errors);
  if ('extraParams' in value) {
    if (!isPlainRecord(value.extraParams)) errors.push('configuration.extraParams must be an object.');
    else validateJsonConfiguration(value.extraParams, 'configuration.extraParams', errors);
  }
  if ('openDirectorStudio' in value && typeof value.openDirectorStudio !== 'boolean') {
    errors.push('configuration.openDirectorStudio must be a boolean.');
  }
  if (
    'directorStudioMode' in value
    && value.directorStudioMode !== 'flat'
    && value.directorStudioMode !== 'panorama'
  ) {
    errors.push('configuration.directorStudioMode must be flat or panorama.');
  }
  if ('enabled' in value && typeof value.enabled !== 'boolean') {
    errors.push('configuration.enabled must be a boolean.');
  }
  if ('tagColor' in value && !(TAG_COLORS as readonly unknown[]).includes(value.tagColor)) {
    errors.push(`configuration.tagColor must be one of: ${TAG_COLORS.join(', ')}.`);
  }
  if ('memberNodeIds' in value) {
    validateStringArray(value.memberNodeIds, 'configuration.memberNodeIds', errors, true);
    if (Array.isArray(value.memberNodeIds) && value.memberNodeIds.length > 100) {
      errors.push('configuration.memberNodeIds cannot exceed 100 items.');
    }
  }
  if ('tagGroupColor' in value && !(TAG_COLORS as readonly unknown[]).includes(value.tagGroupColor)) {
    errors.push(`configuration.tagGroupColor must be one of: ${TAG_COLORS.join(', ')}.`);
  }
  if ('tagGroupShape' in value && !(TAG_GROUP_SHAPES as readonly unknown[]).includes(value.tagGroupShape)) {
    errors.push(`configuration.tagGroupShape must be one of: ${TAG_GROUP_SHAPES.join(', ')}.`);
  }
  if (nodeType === CANVAS_NODE_TYPES.aiVideo && 'aspectRatio' in value && !('modelId' in value)) {
    errors.push('AI video create configuration requires modelId when aspectRatio is provided.');
  }
}

function validateFiniteNumber(value: unknown, label: string, errors: string[]): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    errors.push(`${label} must be a finite number.`);
  }
}

function validateBoundedStringArray(value: unknown, label: string, errors: string[], max = 100): void {
  validateStringArray(value, label, errors, true);
  if (Array.isArray(value) && value.length > max) errors.push(`${label} cannot exceed ${max} items.`);
}

function validateStoryboardUpdateInput(input: Record<string, unknown>, errors: string[]): void {
  if (input.frames !== undefined) {
    if (!Array.isArray(input.frames) || input.frames.length > 100) {
      errors.push('frames must be an array with at most 100 items.');
    } else {
      input.frames.forEach((frame, index) => {
        if (!isPlainRecord(frame) || !hasOnlyKeys(frame, ['frameId', 'note', 'order'])) {
          errors.push(`frames[${index}] contains unsupported fields.`);
          return;
        }
        validateString(frame.frameId, `frames[${index}].frameId`, errors);
        if (frame.note !== undefined) validateString(frame.note, `frames[${index}].note`, errors, true);
        if (frame.order !== undefined && (!Number.isInteger(frame.order) || Number(frame.order) < 0)) {
          errors.push(`frames[${index}].order must be a non-negative integer.`);
        }
      });
    }
  }
  if (input.exportOptions !== undefined) {
    const options = input.exportOptions;
    const allowed = ['showFrameIndex', 'showFrameNote', 'notePlacement', 'imageFit', 'frameIndexPrefix', 'cellGap', 'outerPadding', 'fontSize', 'backgroundColor', 'textColor'];
    if (!isPlainRecord(options) || !hasOnlyKeys(options, allowed)) {
      errors.push('exportOptions contains unsupported fields.');
      return;
    }
    for (const field of ['showFrameIndex', 'showFrameNote'] as const) {
      if (field in options && typeof options[field] !== 'boolean') errors.push(`exportOptions.${field} must be a boolean.`);
    }
    if (options.notePlacement !== undefined && !['overlay', 'bottom'].includes(String(options.notePlacement))) errors.push('exportOptions.notePlacement is invalid.');
    if (options.imageFit !== undefined && !['cover', 'contain'].includes(String(options.imageFit))) errors.push('exportOptions.imageFit is invalid.');
    if (options.frameIndexPrefix !== undefined) validateString(options.frameIndexPrefix, 'exportOptions.frameIndexPrefix', errors, true);
    for (const field of ['cellGap', 'outerPadding', 'fontSize'] as const) {
      if (options[field] !== undefined) {
        validateFiniteNumber(options[field], `exportOptions.${field}`, errors);
        if (typeof options[field] === 'number' && options[field] < 0) errors.push(`exportOptions.${field} cannot be negative.`);
      }
    }
    for (const field of ['backgroundColor', 'textColor'] as const) {
      if (field in options) validateString(options[field], `exportOptions.${field}`, errors);
    }
  }
}

function validateVector3(value: unknown, label: string, errors: string[]): void {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, ['x', 'y', 'z'])) {
    errors.push(`${label} must contain only x, y, and z.`);
    return;
  }
  for (const axis of ['x', 'y', 'z'] as const) validateFiniteNumber(value[axis], `${label}.${axis}`, errors);
}

function validateDirectorUpdateInput(input: Record<string, unknown>, errors: string[]): void {
  if (input.mode !== undefined && !['flat', 'panorama'].includes(String(input.mode))) errors.push('mode must be flat or panorama.');
  for (const field of ['basePrompt', 'aspectRatio', 'themeColor'] as const) {
    if (input[field] !== undefined) validateString(input[field], field, errors, field === 'basePrompt');
  }
  if (input.aspectFrame !== undefined && !['panorama', '1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3', '21:9'].includes(String(input.aspectFrame))) errors.push('aspectFrame is invalid.');
  if (input.screenshotResolution !== undefined && !['1080p', '1440p', '4k'].includes(String(input.screenshotResolution))) errors.push('screenshotResolution is invalid.');
  for (const field of ['backgroundAssetId', 'backgroundPanoramaAssetId'] as const) {
    if (input[field] !== undefined && input[field] !== null) validateString(input[field], field, errors);
  }
  for (const field of ['referenceAssetIds', 'customActionPresets'] as const) {
    if (input[field] !== undefined) validateBoundedStringArray(input[field], field, errors);
  }
  for (const field of ['customActionPoses', 'shortcuts'] as const) {
    if (input[field] !== undefined) {
      if (!isPlainRecord(input[field])) errors.push(`${field} must be an object.`);
      else validateJsonConfiguration(input[field], field, errors);
    }
  }
  if (input.items !== undefined) {
    if (!Array.isArray(input.items) || input.items.length > 100) {
      errors.push('items must be an array with at most 100 items.');
    } else {
      const allowed = ['id', 'label', 'x', 'y', 'color', 'showLabel', 'note', 'pos3d', 'rotation3d', 'scale3d', 'category', 'presetId', 'relation', 'action', 'directorStudioRole', 'directorStudioNumber', 'bodyControls', 'referenceAssetId'];
      input.items.forEach((item, index) => {
        if (!isPlainRecord(item) || !hasOnlyKeys(item, allowed)) {
          errors.push(`items[${index}] contains unsupported fields.`);
          return;
        }
        for (const field of ['id', 'label', 'color'] as const) validateString(item[field], `items[${index}].${field}`, errors);
        for (const field of ['x', 'y'] as const) validateFiniteNumber(item[field], `items[${index}].${field}`, errors);
        if (item.showLabel !== undefined && typeof item.showLabel !== 'boolean') errors.push(`items[${index}].showLabel must be a boolean.`);
        for (const field of ['note', 'presetId', 'relation', 'action', 'referenceAssetId'] as const) {
          if (item[field] !== undefined && item[field] !== null) validateString(item[field], `items[${index}].${field}`, errors, field !== 'referenceAssetId');
        }
        if (item.category !== undefined && !['person', 'object', 'scene'].includes(String(item.category))) errors.push(`items[${index}].category is invalid.`);
        if (item.directorStudioRole !== undefined && item.directorStudioRole !== 'pedestrian') errors.push(`items[${index}].directorStudioRole is invalid.`);
        if (item.directorStudioNumber !== undefined && (!Number.isInteger(item.directorStudioNumber) || Number(item.directorStudioNumber) < 0)) errors.push(`items[${index}].directorStudioNumber must be a non-negative integer.`);
        for (const field of ['pos3d', 'rotation3d', 'scale3d'] as const) if (item[field] !== undefined) validateVector3(item[field], `items[${index}].${field}`, errors);
        if (item.bodyControls !== undefined) validateJsonConfiguration(item.bodyControls, `items[${index}].bodyControls`, errors);
      });
    }
  }
  for (const [field, allowed] of [['camera', ['fov', 'lensDistance', 'activePreset']], ['lighting', ['enabled', 'mainIntensity', 'mainYaw', 'mainPitch', 'mainColor', 'ambientIntensity', 'ambientColor']], ['grid', ['visible', 'height']], ['viewSettings', ['wheelZoomEnabled', 'reverseWheelZoom', 'showAdvancedPedestrianTags']]] as const) {
    const value = input[field];
    if (value === undefined) continue;
    if (!isPlainRecord(value) || !hasOnlyKeys(value, allowed)) {
      errors.push(`${field} contains unsupported fields.`);
      continue;
    }
    const record = value as Record<string, unknown>;
    if (field === 'camera') {
      for (const key of ['fov', 'lensDistance'] as const) if (record[key] !== undefined) validateFiniteNumber(record[key], `${field}.${key}`, errors);
      if (record.activePreset !== undefined && record.activePreset !== null) validateString(record.activePreset, `${field}.activePreset`, errors);
    } else if (field === 'lighting') {
      if (record.enabled !== undefined && typeof record.enabled !== 'boolean') errors.push(`${field}.enabled must be a boolean.`);
      for (const key of ['mainIntensity', 'mainYaw', 'mainPitch', 'ambientIntensity'] as const) if (record[key] !== undefined) validateFiniteNumber(record[key], `${field}.${key}`, errors);
      for (const key of ['mainColor', 'ambientColor'] as const) if (record[key] !== undefined) validateString(record[key], `${field}.${key}`, errors);
    } else if (field === 'grid') {
      if (record.visible !== undefined && typeof record.visible !== 'boolean') errors.push(`${field}.visible must be a boolean.`);
      if (record.height !== undefined) validateFiniteNumber(record.height, `${field}.height`, errors);
    } else {
      for (const key of ['wheelZoomEnabled', 'reverseWheelZoom', 'showAdvancedPedestrianTags'] as const) {
        if (record[key] !== undefined && typeof record[key] !== 'boolean') errors.push(`${field}.${key} must be a boolean.`);
      }
    }
  }
  if (input.motionProject !== undefined && input.motionProject !== null) {
    const project = input.motionProject;
    if (!isPlainRecord(project) || !hasOnlyKeys(project, ['schemaVersion', 'durationSeconds', 'loop', 'cameraTrack', 'objectTracks', 'actionTracks', 'customClips']) || project.schemaVersion !== 1) errors.push('motionProject must be a version 1 project with only supported fields.');
    else {
      validateFiniteNumber(project.durationSeconds, 'motionProject.durationSeconds', errors);
      if (typeof project.durationSeconds === 'number' && project.durationSeconds < 0) errors.push('motionProject.durationSeconds cannot be negative.');
      for (const field of ['cameraTrack', 'objectTracks', 'actionTracks', 'customClips'] as const) {
        if (project[field] === undefined) errors.push(`motionProject.${field} is required.`);
        else validateJsonConfiguration(project[field], `motionProject.${field}`, errors);
      }
    }
  }
}

function validateCommandInput(
  command: CanvasCommand,
  origin: CanvasCommandOrigin,
): string[] {
  const errors: string[] = [];
  const input = command.input as unknown;
  if (!isPlainRecord(input)) {
    return ['Command input must be an object.'];
  }
  const schema = INPUT_SCHEMAS[command.type];
  const unknownKey = Object.keys(input).find((key) => !(key in schema.properties));
  if (unknownKey) {
    errors.push(`Unknown ${command.type} input field: ${unknownKey}.`);
  }
  for (const required of schema.required) {
    if (!Object.prototype.hasOwnProperty.call(input, required)) {
      errors.push(`Missing required ${command.type} input field: ${required}.`);
    }
  }

  switch (command.type) {
    case 'canvas.query':
      if (!['graph', 'nodes', 'edges', 'selection'].includes(command.input.scope)) errors.push('Invalid query scope.');
      if (command.input.nodeIds !== undefined) validateStringArray(command.input.nodeIds, 'nodeIds', errors, true);
      break;
    case 'node.create':
      if (!Object.prototype.hasOwnProperty.call(canvasNodeCapabilityManifest, command.input.nodeType)) {
        errors.push('nodeType is not registered.');
      } else if (!canCreateCanvasNodeDirectly(command.input.nodeType, origin)) {
        const capability: CanvasNodeCapabilityDeclaration =
          canvasNodeCapabilityManifest[command.input.nodeType];
        errors.push(
          origin === 'agent' && capability.status !== 'supported'
            ? capability.reason ?? `Node type ${command.input.nodeType} is UI-only.`
            : capability.directCreateReason
            ?? 'nodeType requires a dedicated creation workflow.',
        );
      }
      validateFinitePosition(command.input.position, 'position', errors);
      if (command.input.nodeId !== undefined) validateString(command.input.nodeId, 'nodeId', errors);
      if (command.input.dimensions !== undefined) {
        const dimensions = command.input.dimensions as unknown;
        if (!isPlainRecord(dimensions)
          || !hasOnlyKeys(dimensions, ['width', 'height'])
          || !Object.prototype.hasOwnProperty.call(dimensions, 'width')
          || !Object.prototype.hasOwnProperty.call(dimensions, 'height')
          || !Number.isFinite(dimensions.width)
          || Number(dimensions.width) <= 0
          || !Number.isFinite(dimensions.height)
          || Number(dimensions.height) <= 0) {
          errors.push('dimensions must contain only finite positive width and height values.');
        }
      }
      if (command.input.configuration !== undefined) {
        validateCreateConfiguration(command.input.nodeType, command.input.configuration, errors);
      }
      break;
    case 'node.tool.run':
      validateString(command.input.nodeId, 'nodeId', errors);
      validateString(command.input.toolType, 'toolType', errors);
      if (origin === 'agent'
        && typeof command.input.toolType === 'string'
        && !isAgentCanvasToolType(command.input.toolType)) {
        errors.push('node.tool.run only supports deterministic crop, annotate, and split-storyboard tools for Agent callers.');
      }
      if (command.input.options !== undefined) {
        validateJsonConfiguration(command.input.options, 'options', errors);
      }
      break;
    case 'storyboard.update':
      validateString(command.input.nodeId, 'nodeId', errors);
      if (command.input.frames === undefined && command.input.exportOptions === undefined) {
        errors.push('storyboard.update requires frames or exportOptions.');
      }
      validateStoryboardUpdateInput(command.input as Record<string, unknown>, errors);
      break;
    case 'panorama.update':
      validateString(command.input.nodeId, 'nodeId', errors);
      if (command.input.sourceMode !== undefined && !['text', 'image'].includes(command.input.sourceMode)) errors.push('sourceMode must be text or image.');
      if (command.input.sourceAssetId !== undefined && command.input.sourceAssetId !== null) validateString(command.input.sourceAssetId, 'sourceAssetId', errors);
      if (command.input.sourcePrompt !== undefined) validateString(command.input.sourcePrompt, 'sourcePrompt', errors, true);
      if (command.input.projection !== undefined && !['spherical', 'cylindrical'].includes(command.input.projection)) errors.push('projection must be spherical or cylindrical.');
      if (command.input.smartBase !== undefined && typeof command.input.smartBase !== 'boolean') errors.push('smartBase must be a boolean.');
      for (const field of ['initialYaw', 'initialPitch', 'initialFov'] as const) {
        if (command.input[field] !== undefined && !Number.isFinite(command.input[field])) errors.push(`${field} must be finite.`);
      }
      if (command.input.initialFov !== undefined && (command.input.initialFov < 10 || command.input.initialFov > 150)) errors.push('initialFov must be between 10 and 150.');
      break;
    case 'director.update':
      validateString(command.input.nodeId, 'nodeId', errors);
      if (Object.keys(command.input).length === 1) errors.push('director.update requires at least one scene field.');
      validateDirectorUpdateInput(command.input as Record<string, unknown>, errors);
      break;
    case 'director.open':
      validateString(command.input.nodeId, 'nodeId', errors);
      if (command.input.focus !== undefined && typeof command.input.focus !== 'boolean') errors.push('focus must be a boolean.');
      break;
    case 'director.record':
      validateString(command.input.nodeId, 'nodeId', errors);
      if (!['720p', '1080p'].includes(command.input.resolution)) errors.push('resolution must be 720p or 1080p.');
      if (command.input.fps !== 24 && command.input.fps !== 30) errors.push('fps must be 24 or 30.');
      if (command.input.addToCanvas !== undefined && typeof command.input.addToCanvas !== 'boolean') errors.push('addToCanvas must be a boolean.');
      break;
    case 'node.delete':
      validateStringArray(command.input.nodeIds, 'nodeIds', errors);
      break;
    case 'node.rename':
      validateString(command.input.nodeId, 'nodeId', errors);
      validateString(command.input.displayName, 'displayName', errors);
      if (typeof command.input.displayName === 'string' && command.input.displayName.length > 200) errors.push('displayName cannot exceed 200 characters.');
      break;
    case 'node.setPrompt':
      validateString(command.input.nodeId, 'nodeId', errors);
      validateString(command.input.prompt, 'prompt', errors, true);
      if (typeof command.input.prompt === 'string' && command.input.prompt.length > 100_000) errors.push('prompt cannot exceed 100000 characters.');
      break;
    case 'node.setModelConfig':
      validateString(command.input.nodeId, 'nodeId', errors);
      validateString(command.input.modelId, 'modelId', errors);
      if (command.input.providerId !== undefined && command.input.providerId !== null) {
        validateString(command.input.providerId, 'providerId', errors);
      }
      if (command.input.aspectRatio !== undefined) validateString(command.input.aspectRatio, 'aspectRatio', errors);
      if (command.input.resolution !== undefined) validateString(command.input.resolution, 'resolution', errors);
      if (command.input.duration !== undefined) validateString(command.input.duration, 'duration', errors);
      if (command.input.extraParams !== undefined) {
        if (!isPlainRecord(command.input.extraParams)) {
          errors.push('extraParams must be an object.');
        } else {
          validateJsonConfiguration(command.input.extraParams, 'extraParams', errors);
        }
      }
      break;
    case 'node.move':
      if (!Array.isArray(command.input.positions) || command.input.positions.length === 0) {
        errors.push('positions must be a non-empty array.');
      } else {
        command.input.positions.forEach((item, index) => {
          if (!isPlainRecord(item)
            || !hasOnlyKeys(item, ['nodeId', 'position'])
            || typeof item.nodeId !== 'string'
            || !item.nodeId.trim()) {
            errors.push(`positions[${index}] must contain only nodeId and position.`);
            return;
          }
          validateFinitePosition(item.position, `positions[${index}].position`, errors);
        });
      }
      break;
    case 'node.layout':
      validateStringArray(command.input.nodeIds, 'nodeIds', errors);
      if (!['horizontal', 'vertical', 'grid'].includes(command.input.direction)) errors.push('Invalid layout direction.');
      if (command.input.origin !== undefined) validateFinitePosition(command.input.origin, 'origin', errors);
      if (command.input.gap !== undefined && (!Number.isFinite(command.input.gap) || command.input.gap < 0)) errors.push('gap must be a non-negative finite number.');
      if (command.input.columns !== undefined && (!Number.isInteger(command.input.columns) || command.input.columns <= 0)) errors.push('columns must be a positive integer.');
      break;
    case 'node.setEnabled':
      validateStringArray(command.input.nodeIds, 'nodeIds', errors);
      if (typeof command.input.enabled !== 'boolean') errors.push('enabled must be a boolean.');
      break;
    case 'node.duplicate':
      if (!Array.isArray(command.input.copies) || command.input.copies.length === 0) {
        errors.push('copies must be a non-empty array.');
      } else if (command.input.copies.length > 100) {
        errors.push('copies cannot exceed 100 items.');
      } else {
        command.input.copies.forEach((copy, index) => {
          if (!isPlainRecord(copy) || !hasOnlyKeys(copy, ['sourceNodeId', 'nodeId', 'position'])) {
            errors.push(`copies[${index}] contains unsupported fields.`);
            return;
          }
          validateString(copy.sourceNodeId, `copies[${index}].sourceNodeId`, errors);
          if (copy.nodeId !== undefined) validateString(copy.nodeId, `copies[${index}].nodeId`, errors);
          if (copy.position !== undefined) validateFinitePosition(copy.position, `copies[${index}].position`, errors);
        });
      }
      break;
    case 'tag.setColor':
      validateString(command.input.tagId, 'tagId', errors);
      if (!(TAG_COLORS as readonly string[]).includes(command.input.color)) {
        errors.push(`color must be one of: ${TAG_COLORS.join(', ')}.`);
      }
      break;
    case 'tagGroup.setMembers':
      validateString(command.input.groupId, 'groupId', errors);
      validateStringArray(command.input.memberNodeIds, 'memberNodeIds', errors, true);
      if (Array.isArray(command.input.memberNodeIds) && command.input.memberNodeIds.length > 100) {
        errors.push('memberNodeIds cannot exceed 100 items.');
      }
      break;
    case 'tagGroup.setAppearance':
      validateString(command.input.groupId, 'groupId', errors);
      if (command.input.color === undefined && command.input.shape === undefined) {
        errors.push('At least one appearance field is required.');
      }
      if (command.input.color !== undefined && !(TAG_COLORS as readonly string[]).includes(command.input.color)) {
        errors.push(`color must be one of: ${TAG_COLORS.join(', ')}.`);
      }
      if (command.input.shape !== undefined && !(TAG_GROUP_SHAPES as readonly string[]).includes(command.input.shape)) {
        errors.push(`shape must be one of: ${TAG_GROUP_SHAPES.join(', ')}.`);
      }
      break;
    case 'edge.connect':
      validateString(command.input.sourceNodeId, 'sourceNodeId', errors);
      validateString(command.input.targetNodeId, 'targetNodeId', errors);
      if (command.input.edgeId !== undefined) validateString(command.input.edgeId, 'edgeId', errors);
      break;
    case 'edge.disconnect':
      validateStringArray(command.input.edgeIds, 'edgeIds', errors);
      break;
    case 'group.create':
      validateStringArray(command.input.nodeIds, 'nodeIds', errors);
      if (Array.isArray(command.input.nodeIds) && command.input.nodeIds.length < 2) errors.push('A group requires at least two node ids.');
      if (command.input.groupId !== undefined) validateString(command.input.groupId, 'groupId', errors);
      if (command.input.displayName !== undefined) {
        validateString(command.input.displayName, 'displayName', errors);
        if (typeof command.input.displayName === 'string' && command.input.displayName.length > 200) {
          errors.push('displayName cannot exceed 200 characters.');
        }
      }
      break;
    case 'group.ungroup':
      validateStringArray(command.input.groupIds, 'groupIds', errors);
      break;
    case 'selection.set':
      validateStringArray(command.input.nodeIds, 'nodeIds', errors, true);
      break;
    case 'viewport.focus':
      validateStringArray(command.input.nodeIds, 'nodeIds', errors);
      if (command.input.padding !== undefined && (!Number.isFinite(command.input.padding) || command.input.padding < 0 || command.input.padding > 1)) errors.push('padding must be between zero and one.');
      if (command.input.select !== undefined && typeof command.input.select !== 'boolean') errors.push('select must be a boolean.');
      break;
    case 'asset.list':
      if (command.input.kind !== undefined && !['image', 'video', 'audio'].includes(command.input.kind)) errors.push('Invalid asset kind.');
      if (command.input.query !== undefined) {
        validateString(command.input.query, 'query', errors);
        if (typeof command.input.query === 'string' && command.input.query.length > 200) errors.push('query cannot exceed 200 characters.');
      }
      if (command.input.nodeIds !== undefined) validateStringArray(command.input.nodeIds, 'nodeIds', errors);
      if (command.input.relatedToNodeIds !== undefined) validateStringArray(command.input.relatedToNodeIds, 'relatedToNodeIds', errors);
      if (command.input.selectedOnly !== undefined && typeof command.input.selectedOnly !== 'boolean') errors.push('selectedOnly must be a boolean.');
      if (command.input.region !== undefined) {
        const region = command.input.region as unknown;
        if (!isPlainRecord(region)
          || !hasOnlyKeys(region, ['x', 'y', 'width', 'height'])
          || !Number.isFinite(region.x)
          || !Number.isFinite(region.y)
          || !Number.isFinite(region.width)
          || Number(region.width) <= 0
          || !Number.isFinite(region.height)
          || Number(region.height) <= 0) {
          errors.push('region must contain only finite x, y and positive width, height values.');
        }
      }
      break;
    case 'asset.locate':
      validateString(command.input.assetId, 'assetId', errors);
      if (command.input.select !== undefined && typeof command.input.select !== 'boolean') errors.push('select must be a boolean.');
      break;
    case 'generation.submit':
      validateStringArray(command.input.nodeIds, 'nodeIds', errors);
      break;
    case 'generation.recover':
      validateString(command.input.jobId, 'jobId', errors);
      if (command.input.nodeIds !== undefined) validateStringArray(command.input.nodeIds, 'nodeIds', errors);
      break;
    case 'generation.status':
    case 'generation.locateResult':
      if (!command.input.nodeId && !command.input.jobId) errors.push('nodeId or jobId is required.');
      if (command.input.nodeId !== undefined) validateString(command.input.nodeId, 'nodeId', errors);
      if (command.input.jobId !== undefined) validateString(command.input.jobId, 'jobId', errors);
      if (command.type === 'generation.locateResult'
        && command.input.select !== undefined
        && typeof command.input.select !== 'boolean') errors.push('select must be a boolean.');
      break;
  }

  const limit = 'limit' in command.input ? command.input.limit : undefined;
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 500)) {
    errors.push('limit must be an integer between 1 and 500.');
  }
  return errors;
}

function simpleImpact(effect: CanvasCommandEffect, summary: string, nodeIds: string[] = []): CanvasCommandImpact {
  return {
    effect,
    summary,
    affectedNodeIds: nodeIds,
    affectedEdgeIds: [],
    creates: { nodes: 0, edges: 0, groups: 0 },
    deletes: { nodes: 0, edges: 0, groups: 0 },
    requiresExternalSideEffect: effect === 'generation' || effect === 'navigation',
  };
}

class CanvasCommandExecutionError extends Error {
  constructor(
    readonly code: CanvasCommandErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'CanvasCommandExecutionError';
  }
}

let fallbackTransactionSequence = 0;

export class CanvasCommandRegistry {
  private readonly definitions = createDefinitions();
  private readonly coordinator: CanvasTransactionCoordinator;
  private readonly nextTransactionId: () => string;

  constructor(private readonly dependencies: CanvasCommandRegistryDependencies) {
    this.coordinator = new CanvasTransactionCoordinator(this, dependencies.store);
    this.nextTransactionId = dependencies.nextTransactionId ?? (() => {
      fallbackTransactionSequence += 1;
      return `canvas-command-${fallbackTransactionSequence}`;
    });
  }

  list(): CanvasCommandDefinition[] {
    return Array.from(this.definitions.values());
  }

  getDefinition(type: CanvasCommandType): CanvasCommandDefinition {
    const definition = this.definitions.get(type);
    if (!definition) {
      throw new Error(`Canvas command ${type} is not registered.`);
    }
    return definition;
  }

  getRevision(): number {
    return this.coordinator.getRevision();
  }

  validate(
    command: CanvasCommand,
    origin: CanvasCommandOrigin = 'agent',
  ): CanvasCommandError[] {
    if (!isPlainRecord(command)) {
      return [{ code: 'invalid_command', message: 'Command must be an object.' }];
    }
    if (!isCanvasCommandOrigin(origin)) {
      return [{ code: 'invalid_command', message: 'Command origin must be ui, agent, or system.' }];
    }
    const unknownField = Object.keys(command).find((key) => ![
      'type',
      'version',
      'input',
    ].includes(key));
    if (unknownField) {
      return [{ code: 'invalid_command', message: `Unknown command field: ${unknownField}.` }];
    }
    const missingField = ['type', 'version', 'input'].find((key) => (
      !Object.prototype.hasOwnProperty.call(command, key)
    ));
    if (missingField) {
      return [{ code: 'invalid_command', message: `Missing command field: ${missingField}.` }];
    }
    if (command.version !== CANVAS_COMMAND_VERSION) {
      return [{ code: 'invalid_command', message: `Unsupported command version ${String(command.version)}.` }];
    }
    if (!this.definitions.has(command.type)) {
      return [{ code: 'unsupported_command', message: `Command ${String(command.type)} is not registered.` }];
    }
    return validateCommandInput(command, origin).map((message) => ({ code: 'invalid_command', message }));
  }

  summarize(command: CanvasCommand): string {
    return this.getDefinition(command.type).summarize(command);
  }

  inspect(
    command: CanvasCommand,
    origin: CanvasCommandOrigin = 'agent',
  ): CanvasTransactionPreview {
    const revision = this.getRevision();
    const errors = this.validate(command, origin);
    if (errors.length > 0) {
      return {
        transactionId: this.nextTransactionId(),
        baseRevision: revision,
        valid: false,
        impacts: [],
        references: {},
        errors,
      };
    }
    if (CANVAS_GRAPH_COMMAND_TYPES.has(command.type)) {
      return this.coordinator.preview({
        id: this.nextTransactionId(),
        origin,
        expectedRevision: revision,
        commands: [command],
      });
    }
    return {
      transactionId: this.nextTransactionId(),
      baseRevision: revision,
      valid: errors.length === 0,
      impacts: errors.length === 0 ? [this.inspectNonGraphImpact(command)] : [],
      references: {},
      errors,
    };
  }

  executeTransaction(transaction: CanvasTransaction): CanvasTransactionResult {
    return this.coordinator.execute(transaction);
  }

  async executeApproved(
    command: CanvasCommand,
    expectedRevision: number,
    origin: CanvasTransaction['origin'] = 'agent',
  ): Promise<CanvasCommandExecutionResult> {
    const revisionBefore = this.getRevision();
    const errors = this.validate(command, origin);
    if (errors.length > 0) {
      return {
        ok: false,
        commandType: command.type,
        revisionBefore,
        revisionAfter: revisionBefore,
        error: errors[0],
      };
    }
    const effect = this.getDefinition(command.type).effect;
    if ((effect === 'graph' || effect === 'generation') && revisionBefore !== expectedRevision) {
      return {
        ok: false,
        commandType: command.type,
        revisionBefore,
        revisionAfter: revisionBefore,
        error: {
          code: 'revision_conflict',
          message: `Canvas revision changed from ${expectedRevision} to ${revisionBefore} after approval.`,
        },
        retryPreview: this.inspect(command, origin),
      };
    }
    if (!CANVAS_GRAPH_COMMAND_TYPES.has(command.type)) {
      return this.execute(command, origin);
    }
    const transactionResult = this.coordinator.execute({
      id: this.nextTransactionId(),
      origin,
      expectedRevision,
      commands: [command],
    });
    if (!transactionResult.ok) {
      return {
        ok: false,
        commandType: command.type,
        revisionBefore: transactionResult.revisionBefore,
        revisionAfter: transactionResult.revisionAfter,
        error: transactionResult.error,
        retryPreview: transactionResult.retryPreview,
      };
    }
    return {
      ok: true,
      commandType: command.type,
      revisionBefore: transactionResult.revisionBefore,
      revisionAfter: transactionResult.revisionAfter,
      impact: transactionResult.impacts[0],
      output: transactionResult.outputs[0],
    };
  }

  async execute(command: CanvasCommand, origin: CanvasTransaction['origin'] = 'agent'): Promise<CanvasCommandExecutionResult> {
    const revisionBefore = this.getRevision();
    const validationErrors = this.validate(command, origin);
    if (validationErrors.length > 0) {
      const commandType = command && typeof command === 'object'
        && 'type' in command && this.definitions.has(command.type as CanvasCommandType)
        ? command.type as CanvasCommandType
        : undefined;
      return {
        ok: false,
        commandType,
        revisionBefore,
        revisionAfter: revisionBefore,
        error: validationErrors[0],
      };
    }

    if (CANVAS_GRAPH_COMMAND_TYPES.has(command.type)) {
      const transactionResult = this.coordinator.execute({
        id: this.nextTransactionId(),
        origin,
        expectedRevision: revisionBefore,
        commands: [command],
      });
      if (!transactionResult.ok) {
        return {
          ok: false,
          commandType: command.type,
          revisionBefore: transactionResult.revisionBefore,
          revisionAfter: transactionResult.revisionAfter,
          error: transactionResult.error,
          retryPreview: transactionResult.retryPreview,
        };
      }
      return {
        ok: true,
        commandType: command.type,
        revisionBefore: transactionResult.revisionBefore,
        revisionAfter: transactionResult.revisionAfter,
        impact: transactionResult.impacts[0],
        output: transactionResult.outputs[0],
      };
    }

    try {
      const output = await this.executeNonGraph(command);
      return {
        ok: true,
        commandType: command.type,
        revisionBefore,
        revisionAfter: this.getRevision(),
        impact: this.inspectNonGraphImpact(command),
        output,
      };
    } catch (error) {
      return {
        ok: false,
        commandType: command.type,
        revisionBefore,
        revisionAfter: this.getRevision(),
        error: {
          code: error instanceof CanvasCommandExecutionError
            ? error.code
            : 'execution_failed',
          message: error instanceof Error ? error.message : String(error),
          ...(error instanceof CanvasCommandExecutionError && error.details
            ? { details: error.details }
            : {}),
        },
      };
    }
  }

  prepareGraphCommand(
    command: CanvasCommand,
    draft: CanvasGraphDraft,
    origin: CanvasCommandOrigin,
  ): CanvasGraphCommandPreparation {
    const validationErrors = this.validate(command, origin);
    if (validationErrors.length > 0) {
      return { ok: false, error: validationErrors[0] };
    }
    const restrictedNodeId = this.findOriginRestrictedNodeId(command, draft, origin);
    if (restrictedNodeId) {
      const node = draft.nodes.find((candidate) => candidate.id === restrictedNodeId);
      const capability: CanvasNodeCapabilityDeclaration | null = node
        ? canvasNodeCapabilityManifest[node.type]
        : null;
      return {
        ok: false,
        error: {
          code: 'invalid_command',
          message: capability?.reason
            ?? `Node ${restrictedNodeId} can only be edited by UI-origin commands.`,
        },
      };
    }
    return applyCanvasGraphCommand(command, draft, this.dependencies.nodeFactory, origin);
  }

  private findOriginRestrictedNodeId(
    command: CanvasCommand,
    draft: CanvasGraphDraft,
    origin: CanvasCommandOrigin,
  ): string | null {
    if (origin === 'ui' || command.type === 'node.create') {
      return null;
    }

    const seedIds = new Set<string>();
    switch (command.type) {
      case 'node.delete':
      case 'node.layout':
      case 'group.create':
      case 'node.setEnabled':
        command.input.nodeIds.forEach((nodeId) => seedIds.add(nodeId));
        break;
      case 'node.duplicate':
        command.input.copies.forEach(({ sourceNodeId }) => seedIds.add(sourceNodeId));
        break;
      case 'tag.setColor':
        seedIds.add(command.input.tagId);
        break;
      case 'tagGroup.setMembers':
        seedIds.add(command.input.groupId);
        command.input.memberNodeIds.forEach((nodeId) => seedIds.add(nodeId));
        break;
      case 'tagGroup.setAppearance':
        seedIds.add(command.input.groupId);
        break;
      case 'node.rename':
      case 'node.setPrompt':
      case 'node.setModelConfig':
        seedIds.add(command.input.nodeId);
        break;
      case 'storyboard.update':
      case 'panorama.update':
      case 'director.update':
        seedIds.add(command.input.nodeId);
        break;
      case 'node.move':
        command.input.positions.forEach(({ nodeId }) => seedIds.add(nodeId));
        break;
      case 'edge.connect':
        seedIds.add(command.input.sourceNodeId);
        seedIds.add(command.input.targetNodeId);
        break;
      case 'edge.disconnect': {
        const edgeIds = new Set(command.input.edgeIds);
        draft.edges.forEach((edge) => {
          if (edgeIds.has(edge.id)) {
            seedIds.add(edge.source);
            seedIds.add(edge.target);
          }
        });
        break;
      }
      case 'group.ungroup':
        command.input.groupIds.forEach((groupId) => seedIds.add(groupId));
        break;
      default:
        return null;
    }

    let addedDescendant = true;
    while (addedDescendant) {
      addedDescendant = false;
      draft.nodes.forEach((node) => {
        if (node.parentId && seedIds.has(node.parentId) && !seedIds.has(node.id)) {
          seedIds.add(node.id);
          addedDescendant = true;
        }
      });
    }

    return draft.nodes.find((node) => (
      seedIds.has(node.id)
      && canvasNodeCapabilityManifest[node.type].status !== 'supported'
    ))?.id ?? null;
  }

  private inspectNonGraphImpact(command: CanvasCommand): CanvasCommandImpact {
    switch (command.type) {
      case 'selection.set':
      case 'viewport.focus':
      case 'generation.submit':
        return simpleImpact(EFFECTS[command.type], this.summarize(command), command.input.nodeIds);
      case 'generation.recover':
        return simpleImpact(EFFECTS[command.type], this.summarize(command), command.input.nodeIds ?? []);
      case 'asset.locate':
      case 'generation.locateResult':
      case 'generation.status':
      case 'asset.list':
      case 'canvas.query':
        return simpleImpact(EFFECTS[command.type], this.summarize(command));
      case 'node.tool.run':
      case 'director.open':
      case 'director.record':
        return simpleImpact(EFFECTS[command.type], this.summarize(command), [command.input.nodeId]);
      default:
        return simpleImpact(EFFECTS[command.type], this.summarize(command));
    }
  }

  private async executeNonGraph(command: CanvasCommand): Promise<CanvasCommandOutput> {
    const snapshot = this.dependencies.store.getSnapshot();
    switch (command.type) {
      case 'canvas.query': {
        const limit = command.input.limit ?? 100;
        const nodeFilter = command.input.nodeIds ? new Set(command.input.nodeIds) : null;
        const nodes = snapshot.nodes.filter((node) => !nodeFilter || nodeFilter.has(node.id)).slice(0, limit);
        const edges = snapshot.edges
          .filter((edge) => !nodeFilter || nodeFilter.has(edge.source) || nodeFilter.has(edge.target))
          .slice(0, limit);
        const value = command.input.scope === 'nodes'
          ? nodes.map(projectCanvasNodeForRead)
          : command.input.scope === 'edges'
            ? edges.map((edge) => ({ id: edge.id, source: edge.source, target: edge.target }))
            : command.input.scope === 'selection'
              ? { selectedNodeIds: snapshot.nodes.filter((node) => node.selected).map((node) => node.id) }
              : {
                  revision: snapshot.revision,
                  nodes: nodes.map(projectCanvasNodeForRead),
                  edges: edges.map((edge) => ({ id: edge.id, source: edge.source, target: edge.target })),
                };
        return { references: { nodeIds: nodes.map((node) => node.id), edgeIds: edges.map((edge) => edge.id) }, value };
      }
      case 'selection.set': {
        const missing = command.input.nodeIds.find((nodeId) => !snapshot.nodes.some((node) => node.id === nodeId));
        if (missing) throw new CanvasCommandExecutionError('not_found', `Node ${missing} does not exist.`);
        this.dependencies.store.setSelection(command.input.nodeIds);
        return { references: { nodeIds: command.input.nodeIds } };
      }
      case 'viewport.focus': {
        const missing = command.input.nodeIds.find((nodeId) => !snapshot.nodes.some((node) => node.id === nodeId));
        if (missing) throw new CanvasCommandExecutionError('not_found', `Node ${missing} does not exist.`);
        const focused = await this.dependencies.navigation.focusNodeIds(command.input.nodeIds, command.input);
        return { references: { nodeIds: command.input.nodeIds }, value: { focused } };
      }
      case 'asset.list': {
        const explicitNodeIds = command.input.nodeIds ? new Set(command.input.nodeIds) : null;
        const selectedNodeIds = command.input.selectedOnly
          ? new Set(snapshot.nodes.filter((node) => node.selected).map((node) => node.id))
          : null;
        const relatedSeedNodeIds = command.input.relatedToNodeIds
          ? new Set(command.input.relatedToNodeIds)
          : null;
        const relatedNodeIds = relatedSeedNodeIds ? new Set(relatedSeedNodeIds) : null;
        if (relatedNodeIds && relatedSeedNodeIds) {
          for (const edge of snapshot.edges) {
            if (relatedSeedNodeIds.has(edge.source)) relatedNodeIds.add(edge.target);
            if (relatedSeedNodeIds.has(edge.target)) {
              const targetNode = snapshot.nodes.find((node) => node.id === edge.target);
              if (!isTagNode(targetNode)) relatedNodeIds.add(edge.source);
            }
          }
          for (const seedNodeId of relatedSeedNodeIds) {
            const seedNode = snapshot.nodes.find((node) => node.id === seedNodeId);
            if (isTagNode(seedNode)) {
              const tagState = inspectTagGraphState(seedNode.id, snapshot.nodes, snapshot.edges);
              if (tagState.status === 'ready' && tagState.sourceNodeId) {
                relatedNodeIds.add(tagState.sourceNodeId);
              }
              continue;
            }
            collectInputReferences(seedNodeId, snapshot.nodes, snapshot.edges)
              .forEach((reference) => relatedNodeIds.add(reference.sourceNodeId));
          }
        }
        const regionNodeIds = command.input.region
          ? new Set(snapshot.nodes.filter((node) => {
              const width = node.measured?.width ?? node.width ?? 1;
              const height = node.measured?.height ?? node.height ?? 1;
              const right = node.position.x + width;
              const bottom = node.position.y + height;
              const regionRight = command.input.region!.x + command.input.region!.width;
              const regionBottom = command.input.region!.y + command.input.region!.height;
              return node.position.x <= regionRight
                && right >= command.input.region!.x
                && node.position.y <= regionBottom
                && bottom >= command.input.region!.y;
            }).map((node) => node.id))
          : null;
        const query = command.input.query?.trim().toLocaleLowerCase();
        const assets = buildCanvasAssetCatalog(snapshot.nodes)
          .filter((asset) => !command.input.kind || asset.kind === command.input.kind)
          .filter((asset) => !explicitNodeIds || explicitNodeIds.has(asset.nodeId))
          .filter((asset) => !selectedNodeIds || selectedNodeIds.has(asset.nodeId))
          .filter((asset) => !relatedNodeIds || relatedNodeIds.has(asset.nodeId))
          .filter((asset) => !regionNodeIds || regionNodeIds.has(asset.nodeId))
          .filter((asset) => !query || `${asset.id} ${asset.title} ${asset.sourceLabel}`.toLocaleLowerCase().includes(query))
          .slice(0, command.input.limit ?? 100)
          .map(projectCanvasAssetCatalogItem);
        return {
          references: {
            assetIds: assets.map((asset) => asset.id),
            nodeIds: Array.from(new Set(assets.map((asset) => asset.nodeId))),
          },
          value: assets,
        };
      }
      case 'asset.locate': {
        const asset = buildCanvasAssetCatalog(snapshot.nodes)
          .find((candidate) => candidate.id === command.input.assetId);
        if (!asset) {
          throw new CanvasCommandExecutionError(
            'not_found',
            `Asset ${command.input.assetId} does not exist.`,
          );
        }
        const focused = await this.dependencies.navigation.focusNodeIds([asset.nodeId], { select: command.input.select });
        return { references: { assetId: asset.id, nodeId: asset.nodeId }, value: { focused } };
      }
      case 'generation.submit': {
        const missing = command.input.nodeIds.find((nodeId) => (
          !snapshot.nodes.some((candidate) => candidate.id === nodeId)
        ));
        if (missing) {
          throw new CanvasCommandExecutionError('not_found', `Node ${missing} does not exist.`);
        }
        const unsupported = command.input.nodeIds.find((nodeId) => {
          const node = snapshot.nodes.find((candidate) => candidate.id === nodeId);
          return node ? !this.dependencies.generation.supportsNode(node) : false;
        });
        if (unsupported) {
          throw new CanvasCommandExecutionError(
            'unsupported_command',
            `Node ${unsupported} does not support generation.`,
          );
        }
        const result = this.dependencies.generation.submit(command.input.nodeIds, snapshot.nodes);
        return { references: { nodeIds: result.acceptedNodeIds }, value: result };
      }
      case 'generation.recover': {
        const result = await this.dependencies.generation.recover(command.input.jobId, command.input.nodeIds);
        return {
          references: { nodeIds: result.nodeIds, jobId: command.input.jobId, jobIds: [command.input.jobId] },
          value: result,
        };
      }
      case 'generation.status': {
        const status = this.dependencies.generation.getStatus(snapshot.nodes, snapshot.edges, command.input);
        if (!status) {
          throw new CanvasCommandExecutionError('not_found', 'Generation node or job was not found.');
        }
        return {
          references: {
            nodeId: status.nodeId,
            nodeIds: Array.from(new Set([status.nodeId, ...status.resultNodeIds])),
            jobId: status.jobId ?? undefined,
            jobIds: status.jobIds,
          },
          value: status,
        };
      }
      case 'generation.locateResult': {
        const nodeId = this.dependencies.generation.locateResultNodeId(snapshot.nodes, snapshot.edges, command.input);
        if (!nodeId) {
          throw new CanvasCommandExecutionError('not_found', 'Generation result is not available.');
        }
        const focused = await this.dependencies.navigation.focusNodeIds([nodeId], { select: command.input.select });
        return { references: { nodeId, nodeIds: [nodeId], jobId: command.input.jobId }, value: { focused } };
      }
      case 'node.tool.run': {
        const result = await this.dependencies.tools.run(command.input);
        return {
          references: {
            nodeId: result.resultNodeId,
            nodeIds: [result.sourceNodeId, result.resultNodeId],
            edgeId: result.edgeId ?? undefined,
          },
          value: result,
        };
      }
      case 'director.open': {
        const node = snapshot.nodes.find((candidate) => candidate.id === command.input.nodeId);
        if (!node || node.type !== CANVAS_NODE_TYPES.blueprint) {
          throw new CanvasCommandExecutionError('not_found', `Director Studio node ${command.input.nodeId} does not exist.`);
        }
        const focused = command.input.focus === false
          ? false
          : await this.dependencies.navigation.focusNodeIds([node.id], { select: true });
        this.dependencies.eventBus.publish('director-studio/open', { nodeId: node.id });
        return { references: { nodeId: node.id, nodeIds: [node.id] }, value: { focused, opened: true } };
      }
      case 'director.record': {
        const node = snapshot.nodes.find((candidate) => candidate.id === command.input.nodeId);
        if (!node || node.type !== CANVAS_NODE_TYPES.blueprint) {
          throw new CanvasCommandExecutionError('not_found', `Director Studio node ${command.input.nodeId} does not exist.`);
        }
        const requestId = `director-record-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
        await this.dependencies.navigation.focusNodeIds([node.id], { select: true });
        this.dependencies.eventBus.publish('director-studio/open', { nodeId: node.id });
        const result = await new Promise<{
          requestId: string;
          nodeId: string;
          resultNodeId?: string;
          error?: string;
        }>((resolve, reject) => {
          const timeoutId = globalThis.setTimeout(() => {
            unsubscribe();
            reject(new Error('Director Studio recording did not start or finish within the expected window.'));
          }, 35 * 60_000);
          const unsubscribe = this.dependencies.eventBus.subscribe('director-studio/record-result', (event) => {
            if (event.requestId !== requestId) return;
            globalThis.clearTimeout(timeoutId);
            unsubscribe();
            if (event.error) reject(new Error(event.error));
            else resolve(event);
          });
          this.dependencies.eventBus.publish('director-studio/record', {
            nodeId: node.id,
            resolution: command.input.resolution,
            fps: command.input.fps,
            addToCanvas: command.input.addToCanvas !== false,
            requestId,
          });
        });
        const resultNodeIds = result.resultNodeId ? [result.resultNodeId] : [];
        return {
          references: { nodeId: result.resultNodeId ?? node.id, nodeIds: [node.id, ...resultNodeIds] },
          value: { recorded: true, resultNodeId: result.resultNodeId ?? null },
        };
      }
      default:
        throw new CanvasCommandExecutionError(
          'not_atomic',
          `Command ${command.type} requires an atomic graph transaction.`,
        );
    }
  }
}
