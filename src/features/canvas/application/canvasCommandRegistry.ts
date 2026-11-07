import {
  CANVAS_COMMAND_VERSION,
  type CanvasCommand,
  type CanvasCommandEffect,
  type CanvasCommandError,
  type CanvasCommandErrorCode,
  type CanvasCommandExecutionOptions,
  type CanvasCommandExecutionResult,
  type CanvasCommandImpact,
  type CanvasCommandOrigin,
  type CanvasCommandOutput,
  type CanvasCommandSchema,
  type CanvasCommandType,
  type CanvasTransaction,
  type CanvasTransactionPreview,
  type CanvasTransactionResult,
} from '../domain/canvasCommands';
import { CANVAS_NODE_TYPES, isTagNode } from '../domain/canvasNodes';
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
  isAtomicCanvasGraphCommand,
} from './canvasCommandGraph';
import {
  collectInputReferences,
  inspectTagGraphState,
} from './graphReferenceResolver';
import type { CanvasToolWorkflowFacade } from './canvasToolWorkflowFacade';
import type { CanvasEventBus } from './ports';
import { withCanvasHistoryGroup } from '@/stores/canvasHistory';
import { runNodeMediaEdit } from './media';
import { CANVAS_COMMAND_INPUT_SCHEMAS } from './canvasCommandSchemas';
import { isPlainRecord, validateCommandInput } from './canvasCommandValidation';
import {
  getCanvasGraphCommandOriginError,
  isCanvasCommandOrigin,
} from './canvasCommandOriginPolicy';

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
  'batch.setPrimary': 'graph',
  'batch.setCollapsed': 'graph',
  'batch.split': 'graph',
  'node.media.edit': 'graph',
  'node.tool.run': 'generation',
  'storyboard.update': 'graph',
  'storyboard.merge': 'graph',
  'panorama.update': 'graph',
  'director.update': 'graph',
  'director.open': 'navigation',
  'director.record': 'generation',
  'tag.setColor': 'graph',
  'tagGroup.setMembers': 'graph',
  'tagGroup.setAppearance': 'graph',
  'edge.connect': 'graph',
  'edge.disconnect': 'graph',
  'selection.connect': 'graph',
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

export const CANVAS_REGISTERED_COMMAND_TYPES = Object.freeze(
  Object.keys(CANVAS_COMMAND_INPUT_SCHEMAS) as CanvasCommandType[],
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
      return `${command.input.enabled ? 'Enable' : 'Disable'} ${command.input.nodeIds.length} node(s).`;
    case 'node.duplicate':
      return `Duplicate ${command.input.copies.length} node(s) with all graph connections.`;
    case 'batch.setPrimary':
      return `Set ${command.input.nodeId} as primary result of ${command.input.batchId}.`;
    case 'batch.setCollapsed':
      return `${command.input.collapsed ? 'Collapse' : 'Expand'} result stack ${command.input.batchId}.`;
    case 'batch.split':
      return `Separate result stack ${command.input.batchId} into independent nodes.`;
    case 'storyboard.merge':
      return `Create a storyboard from ${command.input.nodeIds.length} ordered image nodes.`;
    case 'selection.connect':
      return `Connect ${command.input.sourceNodeIds.length} source node(s) to ${command.input.targetNodeId}.`;
    case 'node.media.edit':
      return `Apply local ${command.input.operation.kind} to ${command.input.nodeId}; no generation request.`;
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
    schema: { commandType: type, version: CANVAS_COMMAND_VERSION, input: CANVAS_COMMAND_INPUT_SCHEMAS[type] },
    summarize: summarizeCommand,
  }]));
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
    if (isAtomicCanvasGraphCommand(command.type)) {
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
    historyGroupId?: string,
    options: CanvasCommandExecutionOptions = {},
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
    if (!isAtomicCanvasGraphCommand(command.type)) {
      return this.execute(command, origin, options);
    }
    const transactionResult = withCanvasHistoryGroup(historyGroupId, () => this.coordinator.execute({
      id: this.nextTransactionId(),
      origin,
      expectedRevision,
      commands: [command],
    }));
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

  async execute(command: CanvasCommand, origin: CanvasTransaction['origin'] = 'agent', options: CanvasCommandExecutionOptions = {}): Promise<CanvasCommandExecutionResult> {
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

    if (isAtomicCanvasGraphCommand(command.type)) {
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
      const output = await this.executeNonGraph(command, origin, options);
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
    const originError = getCanvasGraphCommandOriginError(command, draft, origin);
    if (originError) {
      return { ok: false, error: originError };
    }
    return applyCanvasGraphCommand(command, draft, this.dependencies.nodeFactory, origin);
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
      case 'node.media.edit':
        return simpleImpact(EFFECTS[command.type], this.summarize(command), [command.input.nodeId]);
      default:
        return simpleImpact(EFFECTS[command.type], this.summarize(command));
    }
  }

  private async executeNonGraph(command: CanvasCommand, origin: CanvasCommandOrigin, options: CanvasCommandExecutionOptions): Promise<CanvasCommandOutput> {
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
        const result = await this.dependencies.generation.submit(command.input.nodeIds, snapshot.nodes, origin === 'agent' ? 'agent' : 'canvas');
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
      case 'node.media.edit': {
        const result = await runNodeMediaEdit(command.input.nodeId, command.input.operation, { signal: options.signal });
        return { references: { nodeId: result.nodeIds[0], nodeIds: result.nodeIds }, value: result };
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
