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
  canCreateCanvasNodeDirectly,
  canvasNodeCapabilityManifest,
  type CanvasNodeCapabilityDeclaration,
} from '../domain/canvasCapabilities';
import {
  CANVAS_NODE_TYPES,
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
  nextTransactionId?: () => string;
}

function objectSchema(
  required: string[],
  properties: Record<string, CanvasJsonSchema['properties'][string]>,
): CanvasJsonSchema {
  return { type: 'object', additionalProperties: false, required, properties };
}

const stringField = (description: string) => ({ type: 'string' as const, description });
const numberField = (description: string) => ({ type: 'number' as const, description });
const booleanField = (description: string) => ({ type: 'boolean' as const, description });
const arrayField = (description: string) => ({ type: 'array' as const, description });
const objectField = (description: string) => ({ type: 'object' as const, description });

const EFFECTS: Record<CanvasCommandType, CanvasCommandEffect> = {
  'canvas.query': 'read',
  'node.create': 'graph',
  'node.delete': 'graph',
  'node.rename': 'graph',
  'node.setPrompt': 'graph',
  'node.setModelConfig': 'graph',
  'node.move': 'graph',
  'node.layout': 'graph',
  'edge.connect': 'graph',
  'edge.disconnect': 'graph',
  'group.create': 'graph',
  'group.ungroup': 'graph',
  'selection.set': 'navigation',
  'viewport.focus': 'navigation',
  'asset.list': 'read',
  'asset.locate': 'navigation',
  'generation.submit': 'generation',
  'generation.status': 'read',
  'generation.locateResult': 'navigation',
};

const INPUT_SCHEMAS: Record<CanvasCommandType, CanvasJsonSchema> = {
  'canvas.query': objectSchema(['scope'], {
    scope: stringField('Bounded projection to return.'),
    nodeIds: arrayField('Optional node id filter.'),
    limit: numberField('Maximum number of records.'),
  }),
  'node.create': objectSchema(['nodeType', 'position'], {
    nodeType: stringField('Registered canvas node type.'),
    position: objectField('Finite canvas position.'),
    nodeId: stringField('Optional caller-provided stable node id.'),
    dimensions: objectField('Optional finite positive initial dimensions.'),
    configuration: objectField('Allowed create-time node configuration.'),
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
    limit: numberField('Maximum number of assets.'),
  }),
  'asset.locate': objectSchema(['assetId'], {
    assetId: stringField('Stable asset id from asset.list.'),
    select: booleanField('Whether to select the asset node.'),
  }),
  'generation.submit': objectSchema(['nodeIds'], { nodeIds: arrayField('Generation-capable node ids.') }),
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
    case 'generation.submit':
      return `Submit generation for ${command.input.nodeIds.length} node(s).`;
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

function isFinitePosition(value: unknown): boolean {
  return isRecord(value) && Number.isFinite(value.x) && Number.isFinite(value.y);
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
  if (!isRecord(value)) {
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
      return new Set([...common, 'prompt', 'modelId', 'aspectRatio']);
    case CANVAS_NODE_TYPES.aiVideo:
      return new Set([...common, 'prompt', 'modelId', 'aspectRatio']);
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
      return new Set([...common, 'aspectRatio', 'openDirectorStudio']);
    default:
      return new Set(common);
  }
}

function validateCreateConfiguration(
  nodeType: CanvasNodeType,
  value: unknown,
  errors: string[],
): void {
  if (!isRecord(value)) {
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
  if ('openDirectorStudio' in value && typeof value.openDirectorStudio !== 'boolean') {
    errors.push('configuration.openDirectorStudio must be a boolean.');
  }
  if (nodeType === CANVAS_NODE_TYPES.aiVideo && 'aspectRatio' in value && !('modelId' in value)) {
    errors.push('AI video create configuration requires modelId when aspectRatio is provided.');
  }
}

function validateCommandInput(
  command: CanvasCommand,
  origin: CanvasCommandOrigin,
): string[] {
  const errors: string[] = [];
  const input = command.input as unknown;
  if (!isRecord(input)) {
    return ['Command input must be an object.'];
  }
  const schema = INPUT_SCHEMAS[command.type];
  const unknownKey = Object.keys(input).find((key) => !(key in schema.properties));
  if (unknownKey) {
    errors.push(`Unknown ${command.type} input field: ${unknownKey}.`);
  }
  for (const required of schema.required) {
    if (!(required in input)) {
      errors.push(`Missing required ${command.type} input field: ${required}.`);
    }
  }

  switch (command.type) {
    case 'canvas.query':
      if (!['graph', 'nodes', 'edges', 'selection'].includes(command.input.scope)) errors.push('Invalid query scope.');
      if (command.input.nodeIds !== undefined) validateStringArray(command.input.nodeIds, 'nodeIds', errors, true);
      break;
    case 'node.create':
      if (!(command.input.nodeType in canvasNodeCapabilityManifest)) {
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
      if (!isFinitePosition(command.input.position)) errors.push('position must contain finite x and y values.');
      if (command.input.nodeId !== undefined) validateString(command.input.nodeId, 'nodeId', errors);
      if (command.input.dimensions && (
        !Number.isFinite(command.input.dimensions.width)
        || command.input.dimensions.width <= 0
        || !Number.isFinite(command.input.dimensions.height)
        || command.input.dimensions.height <= 0
      )) errors.push('dimensions must contain finite positive width and height values.');
      if (command.input.configuration !== undefined) {
        validateCreateConfiguration(command.input.nodeType, command.input.configuration, errors);
      }
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
        validateJsonConfiguration(command.input.extraParams, 'extraParams', errors);
      }
      break;
    case 'node.move':
      if (!Array.isArray(command.input.positions) || command.input.positions.length === 0) {
        errors.push('positions must be a non-empty array.');
      } else if (command.input.positions.some((item) => !item || typeof item.nodeId !== 'string' || !item.nodeId.trim() || !isFinitePosition(item.position))) {
        errors.push('positions must contain valid nodeId and position records.');
      }
      break;
    case 'node.layout':
      validateStringArray(command.input.nodeIds, 'nodeIds', errors);
      if (!['horizontal', 'vertical', 'grid'].includes(command.input.direction)) errors.push('Invalid layout direction.');
      if (command.input.origin !== undefined && !isFinitePosition(command.input.origin)) errors.push('origin must contain finite x and y values.');
      if (command.input.gap !== undefined && (!Number.isFinite(command.input.gap) || command.input.gap < 0)) errors.push('gap must be a non-negative finite number.');
      if (command.input.columns !== undefined && (!Number.isInteger(command.input.columns) || command.input.columns <= 0)) errors.push('columns must be a positive integer.');
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
      break;
    case 'asset.list':
      if (command.input.kind !== undefined && !['image', 'video', 'audio'].includes(command.input.kind)) errors.push('Invalid asset kind.');
      break;
    case 'asset.locate':
      validateString(command.input.assetId, 'assetId', errors);
      break;
    case 'generation.submit':
      validateStringArray(command.input.nodeIds, 'nodeIds', errors);
      break;
    case 'generation.status':
    case 'generation.locateResult':
      if (!command.input.nodeId && !command.input.jobId) errors.push('nodeId or jobId is required.');
      if (command.input.nodeId !== undefined) validateString(command.input.nodeId, 'nodeId', errors);
      if (command.input.jobId !== undefined) validateString(command.input.jobId, 'jobId', errors);
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
    if (!command || typeof command !== 'object') {
      return [{ code: 'invalid_command', message: 'Command must be an object.' }];
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
    return applyCanvasGraphCommand(command, draft, this.dependencies.nodeFactory, origin);
  }

  private inspectNonGraphImpact(command: CanvasCommand): CanvasCommandImpact {
    switch (command.type) {
      case 'selection.set':
      case 'viewport.focus':
      case 'generation.submit':
        return simpleImpact(EFFECTS[command.type], this.summarize(command), command.input.nodeIds);
      case 'asset.locate':
      case 'generation.locateResult':
      case 'generation.status':
      case 'asset.list':
      case 'canvas.query':
        return simpleImpact(EFFECTS[command.type], this.summarize(command));
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
        const assets = buildCanvasAssetCatalog(snapshot.nodes)
          .filter((asset) => !command.input.kind || asset.kind === command.input.kind)
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
      default:
        throw new CanvasCommandExecutionError(
          'not_atomic',
          `Command ${command.type} requires an atomic graph transaction.`,
        );
    }
  }
}
