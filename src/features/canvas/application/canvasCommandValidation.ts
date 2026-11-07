import { z } from 'zod';
import type { CanvasCommand, CanvasCommandOrigin } from '../domain/canvasCommands';
import {
  canCreateCanvasNodeDirectly,
  canvasNodeCapabilityManifest,
  type CanvasNodeCapabilityDeclaration,
} from '../domain/canvasCapabilities';
import {
  CANVAS_NODE_TYPES,
  TAG_COLORS,
  TAG_GROUP_SHAPES,
  type CanvasNodeType,
} from '../domain/canvasNodes';
import { isDurableCanvasImageSource } from '../domain/canvasMediaSources';
import { isAgentCanvasToolType } from './canvasToolWorkflowFacade';
import { CANVAS_COMMAND_INPUT_SCHEMAS } from './canvasCommandSchemas';
import { validateMediaEditOperation, type MediaEditOperation } from './media';

const MEDIA_OPERATION_FIELDS: Record<MediaEditOperation['kind'], readonly string[]> = {
  'image.transform': ['kind', 'rotate', 'flipX', 'flipY'],
  'video.captureFrame': ['kind', 'timeSeconds'],
  'video.trim': ['kind', 'startSeconds', 'endSeconds'],
  'video.crop': ['kind', 'rect'],
  'video.separateAudio': ['kind'],
  'audio.slice': ['kind', 'startSeconds', 'endSeconds'],
  'audio.split': ['kind', 'atSeconds'],
  'audio.rate': ['kind', 'rate'],
};

const commandNodeIdSchema = z.string().min(1).refine((value) => value === value.trim());
const selectionCommandInputSchemas = {
  'batch.split': z.object({ batchId: commandNodeIdSchema }).strict(),
  'storyboard.merge': z.object({
    nodeIds: z.array(commandNodeIdSchema).min(2).max(100)
      .refine((ids) => new Set(ids).size === ids.length, 'Storyboard sources must be distinct.'),
    nodeId: commandNodeIdSchema.optional(),
    displayName: z.string().trim().min(1).max(200).optional(),
    columns: z.number().int().positive().optional(),
  }).strict().refine((input) => input.columns === undefined || input.columns <= input.nodeIds.length,
    'Grid columns cannot exceed the number of frames.'),
  'selection.connect': z.object({
    sourceNodeIds: z.array(commandNodeIdSchema).min(1).max(100),
    targetNodeId: commandNodeIdSchema,
  }).strict(),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
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

function validateChannelModeFields(value: { modeId?: unknown; referenceSlots?: unknown }, errors: string[]): void {
  if (value.modeId !== undefined) validateString(value.modeId, 'modeId', errors);
  if (value.referenceSlots === undefined) return;
  if (!isPlainRecord(value.referenceSlots)) {
    errors.push('referenceSlots must be an object.');
    return;
  }
  for (const [slot, sources] of Object.entries(value.referenceSlots)) {
    validateString(slot, 'referenceSlots slot key', errors);
    validateStringArray(sources, `referenceSlots.${slot}`, errors, true);
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

function allowedCreateConfigurationKeys(nodeType: CanvasNodeType): Record<string, true> {
  const common: Record<string, true> = { displayName: true };
  switch (nodeType) {
    case CANVAS_NODE_TYPES.imageEdit:
      return { ...common, imageUrl: true, prompt: true, modelId: true, aspectRatio: true, resolution: true, extraParams: true, modeId: true, referenceSlots: true };
    case CANVAS_NODE_TYPES.storyboardGen:
      return { ...common, prompt: true, modelId: true, aspectRatio: true, resolution: true, extraParams: true, modeId: true, referenceSlots: true };
    case CANVAS_NODE_TYPES.aiVideo:
      return { ...common, prompt: true, modelId: true, aspectRatio: true, resolution: true, duration: true, extraParams: true, modeId: true, referenceSlots: true };
    case CANVAS_NODE_TYPES.aiText:
      return { ...common, prompt: true, modelId: true, providerId: true };
    case CANVAS_NODE_TYPES.aiAudio:
      return { ...common, prompt: true, modelId: true };
    case CANVAS_NODE_TYPES.textAnnotation:
      return { ...common, content: true };
    case CANVAS_NODE_TYPES.upload:
      return { ...common, imageUrl: true, aspectRatio: true };
    case CANVAS_NODE_TYPES.panorama:
      return { ...common, aspectRatio: true };
    case CANVAS_NODE_TYPES.blueprint:
      return { ...common, aspectRatio: true, openDirectorStudio: true, directorStudioMode: true, directorStudioWorkspace: true };
    case CANVAS_NODE_TYPES.tag:
      return { ...common, enabled: true, tagColor: true };
    case CANVAS_NODE_TYPES.tagGroup:
      return { ...common, enabled: true, memberNodeIds: true, tagGroupColor: true, tagGroupShape: true };
    default:
      return common;
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
  const unknownConfigurationKey = Object.keys(value).find((key) => !Object.hasOwn(allowedKeys, key));
  if (unknownConfigurationKey) {
    errors.push(`Unknown or unsupported ${nodeType} create configuration field: ${unknownConfigurationKey}.`);
  }
  if ('displayName' in value) {
    validateString(value.displayName, 'configuration.displayName', errors);
    if (typeof value.displayName === 'string' && value.displayName.length > 200) {
      errors.push('configuration.displayName cannot exceed 200 characters.');
    }
  }
  if ('imageUrl' in value && !isDurableCanvasImageSource(value.imageUrl)) {
    errors.push('configuration.imageUrl must be a durable image source; temporary and executable URL schemes are not allowed.');
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
  validateChannelModeFields(value, errors);
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
  if (
    'directorStudioWorkspace' in value
    && value.directorStudioWorkspace !== 'director'
    && value.directorStudioWorkspace !== 'previs'
  ) {
    errors.push('configuration.directorStudioWorkspace must be director or previs.');
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

export function validateCommandInput(
  command: CanvasCommand,
  origin: CanvasCommandOrigin,
): string[] {
  const errors: string[] = [];
  const input = command.input as unknown;
  if (!isPlainRecord(input)) {
    return ['Command input must be an object.'];
  }
  const schema = CANVAS_COMMAND_INPUT_SCHEMAS[command.type];
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
    case 'batch.split':
    case 'storyboard.merge':
    case 'selection.connect': {
      const parsed = selectionCommandInputSchemas[command.type].safeParse(command.input);
      if (!parsed.success) errors.push(...parsed.error.issues.map((issue) => `${issue.path.join('.') || command.type}: ${issue.message}`));
      break;
    }
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
      validateChannelModeFields(command.input, errors);
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
    case 'batch.setPrimary':
      validateString(command.input.batchId, 'batchId', errors);
      validateString(command.input.nodeId, 'nodeId', errors);
      break;
    case 'batch.setCollapsed':
      validateString(command.input.batchId, 'batchId', errors);
      if (typeof command.input.collapsed !== 'boolean') errors.push('collapsed must be a boolean.');
      break;
    case 'node.media.edit': {
      validateString(command.input.nodeId, 'nodeId', errors);
      const operation: unknown = command.input.operation;
      if (!isPlainRecord(operation) || typeof operation.kind !== 'string'
        || !Object.prototype.hasOwnProperty.call(MEDIA_OPERATION_FIELDS, operation.kind)) {
        errors.push('Unknown local media operation.');
        break;
      }
      const kind = operation.kind as MediaEditOperation['kind'];
      if (!hasOnlyKeys(operation, MEDIA_OPERATION_FIELDS[kind])) errors.push('Media operation contains unsupported fields.');
      if (kind === 'video.crop' && (!isPlainRecord(operation.rect) || !hasOnlyKeys(operation.rect, ['x', 'y', 'width', 'height']))) {
        errors.push('Crop rect must contain only normalized x, y, width and height.');
      }
      try { validateMediaEditOperation(operation as unknown as MediaEditOperation); }
      catch (error) { errors.push(error instanceof Error ? error.message : 'Invalid media operation.'); }
      break;
    }
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
