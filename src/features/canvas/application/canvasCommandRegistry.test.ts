import { beforeEach, describe, expect, it } from 'vitest';

import { useCanvasStore } from '@/stores/canvasStore';
import {
  CANVAS_COMMAND_VERSION,
  CANVAS_COMMAND_TYPES,
  type CanvasCommand,
  type CanvasTransaction,
} from '../domain/canvasCommands';
import { CANVAS_NODE_TYPES } from '../domain/canvasNodes';
import { canvasCommandRegistry } from './canvasCommandService';
import { canvasEventBus } from './canvasServices';
import { CanvasTransactionCoordinator } from './canvasTransactionCoordinator';

function resetCanvas(): void {
  useCanvasStore.setState({
    nodes: [],
    edges: [],
    revision: 0,
    selectedNodeId: null,
    activeDirectorStudioNodeId: null,
    activeToolDialog: null,
    history: { past: [], future: [] },
    dragHistorySnapshot: null,
    currentViewport: { x: 0, y: 0, zoom: 1 },
    canvasViewportSize: { width: 1280, height: 720 },
  });
}

function createAtomicGraphTransaction(expectedRevision = 0): CanvasTransaction {
  return {
    id: 'create-connected-pair',
    origin: 'agent',
    expectedRevision,
    commands: [
      {
        type: 'node.create',
        version: CANVAS_COMMAND_VERSION,
        input: {
          nodeType: CANVAS_NODE_TYPES.imageEdit,
          nodeId: 'source-node',
          position: { x: 10, y: 20 },
          configuration: { prompt: 'Opening shot' },
        },
      },
      {
        type: 'node.create',
        version: CANVAS_COMMAND_VERSION,
        input: {
          nodeType: CANVAS_NODE_TYPES.imageEdit,
          nodeId: 'target-node',
          position: { x: 400, y: 20 },
          configuration: { prompt: 'Continuation' },
        },
      },
      {
        type: 'edge.connect',
        version: CANVAS_COMMAND_VERSION,
        input: {
          sourceNodeId: 'source-node',
          targetNodeId: 'target-node',
          edgeId: 'stable-edge',
        },
      },
    ],
  };
}

describe('CanvasCommandRegistry transactions', () => {
  beforeEach(resetCanvas);

  it('registers a schema, effect, validator, inspector, and redacted summary for every command', () => {
    const definitions = canvasCommandRegistry.list();
    expect(definitions.map((definition) => definition.type)).toEqual(CANVAS_COMMAND_TYPES);
    expect(definitions.every((definition) => (
      definition.schema.version === CANVAS_COMMAND_VERSION
      && definition.schema.input.additionalProperties === false
      && typeof definition.effect === 'string'
      && typeof definition.summarize === 'function'
    ))).toBe(true);

    const summary = canvasCommandRegistry.summarize({
      type: 'node.setPrompt',
      version: CANVAS_COMMAND_VERSION,
      input: { nodeId: 'node', prompt: 'private prompt text' },
    });
    expect(summary).not.toContain('private prompt text');
  });

  it('commits a multi-command graph transaction once with one undo and stable references', () => {
    let mutationCount = 0;
    const unsubscribe = useCanvasStore.subscribe(() => {
      mutationCount += 1;
    });

    const result = canvasCommandRegistry.executeTransaction(createAtomicGraphTransaction());
    unsubscribe();

    expect(result).toMatchObject({
      ok: true,
      revisionBefore: 0,
      revisionAfter: 1,
      references: {
        nodeIds: ['source-node', 'target-node'],
        edgeIds: ['stable-edge'],
      },
    });
    expect(useCanvasStore.getState()).toMatchObject({
      revision: 1,
      history: { past: [{ nodes: [], edges: [] }], future: [] },
    });
    expect(useCanvasStore.getState().nodes.map((node) => node.id)).toEqual(['source-node', 'target-node']);
    expect(useCanvasStore.getState().edges.map((edge) => edge.id)).toEqual(['stable-edge']);
    expect(mutationCount).toBe(1);

    expect(useCanvasStore.getState().undo()).toBe(true);
    expect(useCanvasStore.getState().nodes).toEqual([]);
    expect(useCanvasStore.getState().edges).toEqual([]);
  });

  it('moves Agent-created nodes to deterministic empty space when requested coordinates are occupied', async () => {
    useCanvasStore.setState({
      nodes: [{
        id: 'occupied', type: CANVAS_NODE_TYPES.imageEdit, position: { x: 100, y: 100 },
        measured: { width: 220, height: 380 }, data: { prompt: 'existing' },
      }],
      revision: 1,
    });
    const result = await canvasCommandRegistry.executeApproved({
      type: 'node.create', version: CANVAS_COMMAND_VERSION,
      input: { nodeType: CANVAS_NODE_TYPES.imageEdit, nodeId: 'agent-created', position: { x: 100, y: 100 } },
    }, 1, 'agent');
    expect(result.ok).toBe(true);
    expect(useCanvasStore.getState().nodes.find((node) => node.id === 'agent-created')?.position).not.toEqual({ x: 100, y: 100 });
  });

  it('rolls back every draft change when a later command fails', () => {
    const result = canvasCommandRegistry.executeTransaction({
      id: 'rollback-test',
      origin: 'agent',
      expectedRevision: 0,
      commands: [
        {
          type: 'node.create',
          version: CANVAS_COMMAND_VERSION,
          input: {
            nodeType: CANVAS_NODE_TYPES.imageEdit,
            nodeId: 'must-not-remain',
            position: { x: 0, y: 0 },
          },
        },
        {
          type: 'node.rename',
          version: CANVAS_COMMAND_VERSION,
          input: { nodeId: 'missing-node', displayName: 'Invalid' },
        },
      ],
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'not_found', commandIndex: 1, commandType: 'node.rename' },
    });
    expect(useCanvasStore.getState()).toMatchObject({
      nodes: [],
      edges: [],
      revision: 0,
      history: { past: [], future: [] },
    });
  });

  it('rejects a stale revision before execution and returns a current retry preview', () => {
    useCanvasStore.getState().addNode(CANVAS_NODE_TYPES.upload, { x: 0, y: 0 });
    const stateBefore = useCanvasStore.getState();
    const result = canvasCommandRegistry.executeTransaction(createAtomicGraphTransaction(0));

    expect(result).toMatchObject({
      ok: false,
      revisionBefore: 1,
      revisionAfter: 1,
      error: {
        code: 'revision_conflict',
        details: { expectedRevision: 0, actualRevision: 1 },
      },
      retryPreview: { baseRevision: 1, valid: true },
    });
    expect(useCanvasStore.getState().nodes).toBe(stateBefore.nodes);
    expect(useCanvasStore.getState().history).toBe(stateBefore.history);
  });

  it('enforces the approval-bound revision for a single Agent mutation', async () => {
    useCanvasStore.getState().addNode(CANVAS_NODE_TYPES.upload, { x: 0, y: 0 });
    const node = useCanvasStore.getState().nodes[0];
    const command = {
      type: 'node.rename' as const,
      version: CANVAS_COMMAND_VERSION,
      input: { nodeId: node.id, displayName: 'Approved name' },
    };

    const stale = await canvasCommandRegistry.executeApproved(command, 0, 'agent');
    expect(stale).toMatchObject({
      ok: false,
      revisionBefore: 1,
      revisionAfter: 1,
      error: { code: 'revision_conflict' },
      retryPreview: { baseRevision: 1, valid: true },
    });
    expect(useCanvasStore.getState().nodes[0].data.displayName).not.toBe('Approved name');

    const current = await canvasCommandRegistry.executeApproved(command, 1, 'agent');
    expect(current).toMatchObject({ ok: true, revisionBefore: 1, revisionAfter: 2 });
    expect(useCanvasStore.getState().nodes[0].data.displayName).toBe('Approved name');
  });

  it('rejects a revision change at commit and rebuilds the retry preview', () => {
    let revision = 0;
    const coordinator = new CanvasTransactionCoordinator({
      prepareGraphCommand: (_command, draft) => ({
        ok: true,
        draft,
        impact: {
          effect: 'graph',
          summary: 'Simulated graph change.',
          affectedNodeIds: ['node'],
          affectedEdgeIds: [],
          creates: { nodes: 0, edges: 0, groups: 0 },
          deletes: { nodes: 0, edges: 0, groups: 0 },
          requiresExternalSideEffect: false,
        },
        output: { references: { nodeId: 'node' } },
        changed: true,
      }),
    }, {
      getSnapshot: () => ({
        nodes: [],
        edges: [],
        selectedNodeId: null,
        revision,
      }),
      commitGraphTransaction: () => {
        revision = 1;
        return null;
      },
      setSelection: () => undefined,
    });

    const result = coordinator.execute({
      id: 'commit-cas',
      origin: 'agent',
      expectedRevision: 0,
      commands: [{
        type: 'node.delete',
        version: CANVAS_COMMAND_VERSION,
        input: { nodeIds: ['node'] },
      }],
    });

    expect(result).toMatchObject({
      ok: false,
      revisionBefore: 0,
      revisionAfter: 1,
      error: {
        code: 'revision_conflict',
        details: { expectedRevision: 0, actualRevision: 1 },
      },
      retryPreview: { baseRevision: 1, valid: true },
    });
  });

  it('rejects unknown command fields instead of allowing arbitrary node patches', async () => {
    const result = await canvasCommandRegistry.execute({
      type: 'node.rename',
      version: CANVAS_COMMAND_VERSION,
      input: {
        nodeId: 'node',
        displayName: 'Name',
        data: { isGenerating: true },
      },
    } as never);
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_command' } });
  });

  it('returns structured failures for malformed commands and transaction envelopes', async () => {
    await expect(canvasCommandRegistry.execute(null as never)).resolves.toMatchObject({
      ok: false,
      commandType: undefined,
      error: { code: 'invalid_command', message: 'Command must be an object.' },
    });
    expect(canvasCommandRegistry.inspect(null as never)).toMatchObject({
      valid: false,
      errors: [{ code: 'invalid_command', message: 'Command must be an object.' }],
    });

    expect(canvasCommandRegistry.executeTransaction(null as never)).toMatchObject({
      ok: false,
      transactionId: '',
      error: { code: 'invalid_command', message: 'Transaction must be an object.' },
    });
    expect(canvasCommandRegistry.executeTransaction({
      id: 'invalid-command-entry',
      origin: 'agent',
      expectedRevision: 0,
      commands: [null],
    } as never)).toMatchObject({
      ok: false,
      error: { code: 'invalid_command', commandIndex: 0 },
    });

    await expect(canvasCommandRegistry.execute({
      type: 'canvas.query',
      version: CANVAS_COMMAND_VERSION,
      input: { scope: 'graph' },
      unsafe: true,
    } as never)).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_command', message: 'Unknown command field: unsafe.' },
    });
    await expect(canvasCommandRegistry.execute({
      type: 'node.create',
      version: CANVAS_COMMAND_VERSION,
      input: { nodeType: CANVAS_NODE_TYPES.panorama, position: { x: 0, y: 0 } },
    }, 'external' as never)).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_command', message: 'Command origin must be ui, agent, or system.' },
    });
    expect(canvasCommandRegistry.executeTransaction({
      id: 'unknown-transaction-field',
      origin: 'agent',
      expectedRevision: 0,
      commands: [createAtomicGraphTransaction().commands[0]],
      unsafe: true,
    } as never)).toMatchObject({
      ok: false,
      error: { code: 'invalid_command', message: 'Unknown transaction field: unsafe.' },
    });

    const inheritedCommand = Object.create({
      type: 'canvas.query',
      version: CANVAS_COMMAND_VERSION,
      input: { scope: 'graph' },
    });
    await expect(canvasCommandRegistry.execute(inheritedCommand as never)).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_command' },
    });

    const malformedPosition = {
      type: 'node.create',
      version: CANVAS_COMMAND_VERSION,
      input: {
        nodeType: CANVAS_NODE_TYPES.imageEdit,
        position: { x: 0, y: 0, localPath: '/private/bypass' },
      },
    } as never;
    await expect(canvasCommandRegistry.execute(malformedPosition)).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_command', message: expect.stringContaining('only finite x and y') },
    });
    expect(canvasCommandRegistry.inspect(malformedPosition)).toMatchObject({
      valid: false,
      errors: [{ code: 'invalid_command', message: expect.stringContaining('only finite x and y') }],
    });

    await expect(canvasCommandRegistry.execute({
      type: 'node.setModelConfig',
      version: CANVAS_COMMAND_VERSION,
      input: { nodeId: 'node', modelId: 'model', extraParams: 'invalid' },
    } as never)).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_command', message: 'extraParams must be an object.' },
    });
    await expect(canvasCommandRegistry.execute({
      type: 'viewport.focus',
      version: CANVAS_COMMAND_VERSION,
      input: { nodeIds: ['node'], select: 'yes' },
    } as never)).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_command', message: 'select must be a boolean.' },
    });
  });

  it('rejects direct creation of result and workflow-owned node types', async () => {
    const result = await canvasCommandRegistry.execute({
      type: 'node.create',
      version: CANVAS_COMMAND_VERSION,
      input: {
        nodeType: CANVAS_NODE_TYPES.exportImage,
        position: { x: 0, y: 0 },
      },
    });
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_command',
        message: expect.stringContaining('validated generation or export workflows'),
      },
    });
    expect(useCanvasStore.getState().nodes).toEqual([]);
  });

  it('rejects external-side-effect commands inside graph transactions', () => {
    const result = canvasCommandRegistry.executeTransaction({
      id: 'not-atomic',
      origin: 'agent',
      expectedRevision: 0,
      commands: [{
        type: 'generation.submit',
        version: CANVAS_COMMAND_VERSION,
        input: { nodeIds: ['node'] },
      }],
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'not_atomic', commandIndex: 0, commandType: 'generation.submit' },
    });
  });

  it('rejects credentials and non-JSON values in model extra parameters', async () => {
    const credentialResult = await canvasCommandRegistry.execute({
      type: 'node.setModelConfig',
      version: CANVAS_COMMAND_VERSION,
      input: {
        nodeId: 'node',
        modelId: 'model',
        extraParams: { headers: { Authorization: 'Bearer secret' } },
      },
    });
    expect(credentialResult).toMatchObject({
      ok: false,
      error: { code: 'invalid_command', message: expect.stringContaining('approved settings workflow') },
    });

    const nestedCredentialResult = await canvasCommandRegistry.execute({
      type: 'node.setModelConfig',
      version: CANVAS_COMMAND_VERSION,
      input: {
        nodeId: 'node',
        modelId: 'model',
        extraParams: { transport: { proxyAuthorization: 'Bearer secret' } },
      },
    });
    expect(nestedCredentialResult).toMatchObject({
      ok: false,
      error: { code: 'invalid_command', message: expect.stringContaining('approved settings workflow') },
    });

    const nonJsonResult = await canvasCommandRegistry.execute({
      type: 'node.setModelConfig',
      version: CANVAS_COMMAND_VERSION,
      input: {
        nodeId: 'node',
        modelId: 'model',
        extraParams: { callback: () => undefined },
      },
    } as never);
    expect(nonJsonResult).toMatchObject({
      ok: false,
      error: { code: 'invalid_command', message: expect.stringContaining('JSON-compatible') },
    });
  });

  it('writes model configuration to the fields each generation node actually consumes', async () => {
    const imageCreate = await canvasCommandRegistry.execute({
      type: 'node.create',
      version: CANVAS_COMMAND_VERSION,
      input: {
        nodeType: CANVAS_NODE_TYPES.imageEdit,
        nodeId: 'image-model-node',
        position: { x: 0, y: 0 },
        configuration: { modelId: 'custom:image-model', aspectRatio: '3:4' },
      },
    }, 'agent');
    expect(imageCreate.ok).toBe(true);
    expect(useCanvasStore.getState().nodes.find((node) => node.id === 'image-model-node')?.data)
      .toMatchObject({
        model: 'custom:image-model',
        requestAspectRatio: '3:4',
        modelConfig: { entryId: 'custom:image-model', ratio: '3:4' },
      });

    const videoCreate = await canvasCommandRegistry.execute({
      type: 'node.create',
      version: CANVAS_COMMAND_VERSION,
      input: {
        nodeType: CANVAS_NODE_TYPES.aiVideo,
        nodeId: 'video-model-node',
        position: { x: 400, y: 0 },
        configuration: { modelId: 'custom:video-model', aspectRatio: '16:9' },
      },
    }, 'agent');
    expect(videoCreate.ok).toBe(true);
    expect(useCanvasStore.getState().nodes.find((node) => node.id === 'video-model-node')?.data)
      .toMatchObject({
        modelConfig: {
          entryId: 'custom:video-model',
          duration: '5',
          resolution: '720p',
          aspectRatio: '16:9',
        },
      });

    const setImageConfig = await canvasCommandRegistry.execute({
      type: 'node.setModelConfig',
      version: CANVAS_COMMAND_VERSION,
      input: {
        nodeId: 'image-model-node',
        modelId: 'dreamina:new-image-model',
        aspectRatio: '9:16',
        resolution: '4K',
        extraParams: { quality: 'high' },
      },
    }, 'agent');
    expect(setImageConfig.ok).toBe(true);
    expect(useCanvasStore.getState().nodes.find((node) => node.id === 'image-model-node')?.data)
      .toMatchObject({
        model: 'dreamina:new-image-model',
        size: '4K',
        requestAspectRatio: '9:16',
        extraParams: { quality: 'high', resolutionType: '4K' },
        modelConfig: {
          entryId: 'dreamina:new-image-model',
          ratio: '9:16',
          extraParams: { quality: 'high', resolutionType: '4K' },
        },
      });

    const setVideoConfig = await canvasCommandRegistry.execute({
      type: 'node.setModelConfig',
      version: CANVAS_COMMAND_VERSION,
      input: {
        nodeId: 'video-model-node',
        modelId: 'dreamina:new-video-model',
        duration: '10',
        resolution: '1080p',
        aspectRatio: '9:16',
        extraParams: { mode: 'frames' },
      },
    }, 'agent');
    expect(setVideoConfig.ok).toBe(true);
    expect(useCanvasStore.getState().nodes.find((node) => node.id === 'video-model-node')?.data)
      .toMatchObject({
        extraParams: { mode: 'frames' },
        modelConfig: {
          entryId: 'dreamina:new-video-model',
          duration: '10',
          resolution: '1080p',
          aspectRatio: '9:16',
          extraParams: { mode: 'frames' },
        },
      });
  });

  it('creates a Director Studio node in the requested mode through the shared command boundary', async () => {
    const result = await canvasCommandRegistry.execute({
      type: 'node.create',
      version: CANVAS_COMMAND_VERSION,
      input: {
        nodeType: CANVAS_NODE_TYPES.blueprint,
        nodeId: 'panorama-director-node',
        position: { x: 120, y: 80 },
        configuration: {
          openDirectorStudio: true,
          directorStudioMode: 'panorama',
        },
      },
    }, 'ui');

    expect(result.ok).toBe(true);
    expect(useCanvasStore.getState().nodes.find((node) => node.id === 'panorama-director-node')?.data)
      .toMatchObject({
        mode: 'panorama',
        openDirectorStudioOnCreate: true,
      });

    const invalidMode = await canvasCommandRegistry.execute({
      type: 'node.create',
      version: CANVAS_COMMAND_VERSION,
      input: {
        nodeType: CANVAS_NODE_TYPES.blueprint,
        position: { x: 0, y: 0 },
        configuration: { directorStudioMode: 'invalid' },
      },
    } as never, 'ui');

    expect(invalidMode).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_command',
        message: 'configuration.directorStudioMode must be flat or panorama.',
      },
    });
  });

  it('rejects node-inapplicable model fields instead of silently dropping them', async () => {
    useCanvasStore.getState().addNode(CANVAS_NODE_TYPES.aiAudio, { x: 0, y: 0 });
    const nodeId = useCanvasStore.getState().nodes[0].id;
    const result = await canvasCommandRegistry.execute({
      type: 'node.setModelConfig',
      version: CANVAS_COMMAND_VERSION,
      input: {
        nodeId,
        modelId: 'audio-model',
        duration: '10',
      },
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'invalid_command', message: expect.stringContaining('duration') },
    });
  });

  it('marks generated media renames as custom so downloads use the new name', async () => {
    useCanvasStore.getState().addNode(CANVAS_NODE_TYPES.exportImage, { x: 0, y: 0 }, {
      displayName: 'Generated image',
      generatedNamingMode: 'default',
      generatedFileName: 'genimg_20260810_0001.png',
    });
    const nodeId = useCanvasStore.getState().nodes[0].id;
    const result = await canvasCommandRegistry.execute({
      type: 'node.rename',
      version: CANVAS_COMMAND_VERSION,
      input: { nodeId, displayName: 'Hero close-up' },
    });
    expect(result.ok).toBe(true);
    expect(useCanvasStore.getState().nodes[0].data).toMatchObject({
      displayName: 'Hero close-up',
      generatedNamingMode: 'custom',
    });
  });

  it('does not add history for equivalent model config and isolates stored command objects', async () => {
    const position = { x: 10, y: 20 };
    await canvasCommandRegistry.execute({
      type: 'node.create',
      version: CANVAS_COMMAND_VERSION,
      input: {
        nodeType: CANVAS_NODE_TYPES.imageEdit,
        nodeId: 'isolated-node',
        position,
      },
    });
    position.x = 999;
    expect(useCanvasStore.getState().nodes[0].position).toEqual({ x: 10, y: 20 });

    const extraParams = { nested: { quality: 'high' } };
    await canvasCommandRegistry.execute({
      type: 'node.setModelConfig',
      version: CANVAS_COMMAND_VERSION,
      input: {
        nodeId: 'isolated-node',
        modelId: 'custom:model',
        aspectRatio: '16:9',
        extraParams,
      },
    });
    const stateAfterFirstUpdate = useCanvasStore.getState();
    extraParams.nested.quality = 'mutated';
    expect(stateAfterFirstUpdate.nodes[0].data.extraParams).toEqual({
      nested: { quality: 'high' },
    });

    const secondResult = await canvasCommandRegistry.execute({
      type: 'node.setModelConfig',
      version: CANVAS_COMMAND_VERSION,
      input: {
        nodeId: 'isolated-node',
        modelId: 'custom:model',
        aspectRatio: '16:9',
        extraParams: { nested: { quality: 'high' } },
      },
    });
    expect(secondResult).toMatchObject({
      ok: true,
      revisionBefore: stateAfterFirstUpdate.revision,
      revisionAfter: stateAfterFirstUpdate.revision,
    });
    expect(useCanvasStore.getState().history).toBe(stateAfterFirstUpdate.history);
  });

  it('allows Agent creation only after a dedicated workflow command covers the node type', async () => {
    const agentResult = await canvasCommandRegistry.execute({
      type: 'node.create',
      version: CANVAS_COMMAND_VERSION,
      input: { nodeType: CANVAS_NODE_TYPES.panorama, position: { x: 0, y: 0 } },
    }, 'agent');
    expect(agentResult).toMatchObject({ ok: true, commandType: 'node.create' });
    expect(useCanvasStore.getState().nodes.filter((node) => node.type === CANVAS_NODE_TYPES.panorama)).toHaveLength(1);

    const uiResult = await canvasCommandRegistry.execute({
      type: 'node.create',
      version: CANVAS_COMMAND_VERSION,
      input: { nodeType: CANVAS_NODE_TYPES.panorama, position: { x: 0, y: 0 } },
    }, 'ui');
    expect(uiResult).toMatchObject({ ok: true });
    expect(useCanvasStore.getState().nodes.filter((node) => node.type === CANVAS_NODE_TYPES.panorama)).toHaveLength(2);

    const panoramaNodeId = useCanvasStore.getState().nodes[0].id;
    const agentEditResult = await canvasCommandRegistry.execute({
      type: 'node.rename',
      version: CANVAS_COMMAND_VERSION,
      input: { nodeId: panoramaNodeId, displayName: 'Bypass' },
    }, 'agent');
    expect(agentEditResult).toMatchObject({ ok: true, commandType: 'node.rename' });
    expect(useCanvasStore.getState().nodes[0].data.displayName).toBe('Bypass');

    const systemCreateResult = await canvasCommandRegistry.execute({
      type: 'node.create',
      version: CANVAS_COMMAND_VERSION,
      input: { nodeType: CANVAS_NODE_TYPES.blueprint, position: { x: 100, y: 0 } },
    }, 'system');
    expect(systemCreateResult).toMatchObject({ ok: true, commandType: 'node.create' });
  });

  it('produces equivalent graph/history results for UI and Agent origins', () => {
    const uiResult = canvasCommandRegistry.executeTransaction({
      ...createAtomicGraphTransaction(),
      id: 'ui-parity',
      origin: 'ui',
    });
    expect(uiResult.ok).toBe(true);
    const uiState = useCanvasStore.getState();
    const uiProjection = {
      nodes: uiState.nodes,
      edges: uiState.edges,
      history: uiState.history,
      revision: uiState.revision,
    };

    resetCanvas();
    const agentResult = canvasCommandRegistry.executeTransaction({
      ...createAtomicGraphTransaction(),
      id: 'agent-parity',
      origin: 'agent',
    });
    expect(agentResult.ok).toBe(true);
    const agentState = useCanvasStore.getState();
    expect({
      nodes: agentState.nodes,
      edges: agentState.edges,
      history: agentState.history,
      revision: agentState.revision,
    }).toEqual(uiProjection);
  });

  it('groups and ungroups through atomic commands with stable ordering and one undo per action', async () => {
    const createResult = canvasCommandRegistry.executeTransaction({
      id: 'group-seed',
      origin: 'ui',
      expectedRevision: 0,
      commands: [
        {
          type: 'node.create',
          version: CANVAS_COMMAND_VERSION,
          input: { nodeType: CANVAS_NODE_TYPES.upload, nodeId: 'prefix', position: { x: -300, y: 0 } },
        },
        {
          type: 'node.create',
          version: CANVAS_COMMAND_VERSION,
          input: { nodeType: CANVAS_NODE_TYPES.imageEdit, nodeId: 'left', position: { x: 0, y: 0 } },
        },
        {
          type: 'node.create',
          version: CANVAS_COMMAND_VERSION,
          input: { nodeType: CANVAS_NODE_TYPES.imageEdit, nodeId: 'right', position: { x: 320, y: 40 } },
        },
      ],
    });
    expect(createResult.ok).toBe(true);
    useCanvasStore.setState((state) => ({
      nodes: state.nodes.map((node) => node.id === 'prefix' ? { ...node, selected: true } : node),
    }));

    const groupResult = await canvasCommandRegistry.execute({
      type: 'group.create',
      version: CANVAS_COMMAND_VERSION,
      input: { nodeIds: ['left', 'right'], groupId: 'group', displayName: 'Shot group' },
    }, 'ui');
    expect(groupResult).toMatchObject({ ok: true, revisionBefore: 1, revisionAfter: 2 });
    expect(useCanvasStore.getState().nodes.map((node) => node.id)).toEqual([
      'prefix',
      'group',
      'left',
      'right',
    ]);
    expect(useCanvasStore.getState().nodes.find((node) => node.id === 'prefix')?.selected).toBe(false);
    expect(useCanvasStore.getState().nodes.find((node) => node.id === 'group')?.selected).toBe(true);
    expect(useCanvasStore.getState().history.past).toHaveLength(2);

    const ungroupResult = await canvasCommandRegistry.execute({
      type: 'group.ungroup',
      version: CANVAS_COMMAND_VERSION,
      input: { groupIds: ['group'] },
    }, 'agent');
    expect(ungroupResult).toMatchObject({ ok: true, revisionBefore: 2, revisionAfter: 3 });
    expect(useCanvasStore.getState().nodes.map((node) => node.id)).toEqual(['prefix', 'left', 'right']);
    expect(useCanvasStore.getState().nodes.find((node) => node.id === 'left')).toMatchObject({
      parentId: undefined,
      position: { x: 0, y: 0 },
    });
    expect(useCanvasStore.getState().nodes.find((node) => node.id === 'right')).toMatchObject({
      parentId: undefined,
      position: { x: 320, y: 40 },
    });
    expect(useCanvasStore.getState().history.past).toHaveLength(3);
  });

  it('creates and edits a direct-member tag group through versioned commands', async () => {
    const seed = canvasCommandRegistry.executeTransaction({
      id: 'tag-group-seed',
      origin: 'ui',
      expectedRevision: 0,
      commands: [
        { type: 'node.create', version: CANVAS_COMMAND_VERSION, input: { nodeType: CANVAS_NODE_TYPES.upload, nodeId: 'image', position: { x: 0, y: 0 } } },
        { type: 'node.create', version: CANVAS_COMMAND_VERSION, input: { nodeType: CANVAS_NODE_TYPES.textAnnotation, nodeId: 'text', position: { x: 300, y: 0 }, configuration: { content: 'Scene note' } } },
        {
          type: 'node.create',
          version: CANVAS_COMMAND_VERSION,
          input: {
            nodeType: CANVAS_NODE_TYPES.tagGroup,
            nodeId: 'tag-group',
            position: { x: -40, y: -40 },
            dimensions: { width: 620, height: 260 },
            configuration: { displayName: 'Scene assets', memberNodeIds: ['image', 'text'] },
          },
        },
      ],
    });
    expect(seed.ok).toBe(true);
    expect(useCanvasStore.getState().nodes.find((node) => node.id === 'tag-group')?.data).toMatchObject({
      schemaVersion: 2,
      memberNodeIds: ['image', 'text'],
      color: 'neutral',
      shape: 'rounded',
    });

    const appearance = await canvasCommandRegistry.execute({
      type: 'tagGroup.setAppearance',
      version: CANVAS_COMMAND_VERSION,
      input: { groupId: 'tag-group', color: 'violet', shape: 'frame' },
    }, 'ui');
    expect(appearance.ok).toBe(true);
    expect(useCanvasStore.getState().nodes.find((node) => node.id === 'tag-group')?.data).toMatchObject({ color: 'violet', shape: 'frame' });

    const invalid = await canvasCommandRegistry.execute({
      type: 'tagGroup.setMembers',
      version: CANVAS_COMMAND_VERSION,
      input: { groupId: 'tag-group', memberNodeIds: ['tag-group'] },
    }, 'ui');
    expect(invalid).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(useCanvasStore.getState().nodes.find((node) => node.id === 'tag-group')?.data).toMatchObject({ memberNodeIds: ['image', 'text'] });
  });
});

describe('CanvasCommandRegistry read and generation facades', () => {
  beforeEach(resetCanvas);

  it('returns typed lookup and capability errors for non-graph commands', async () => {
    const missingSelection = await canvasCommandRegistry.execute({
      type: 'selection.set',
      version: CANVAS_COMMAND_VERSION,
      input: { nodeIds: ['missing-node'] },
    });
    expect(missingSelection).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });

    useCanvasStore.getState().addNode(CANVAS_NODE_TYPES.upload, { x: 0, y: 0 });
    const uploadNodeId = useCanvasStore.getState().nodes[0].id;
    const unsupportedGeneration = await canvasCommandRegistry.execute({
      type: 'generation.submit',
      version: CANVAS_COMMAND_VERSION,
      input: { nodeIds: [uploadNodeId] },
    });
    expect(unsupportedGeneration).toMatchObject({
      ok: false,
      error: { code: 'unsupported_command' },
    });

    const missingStatus = await canvasCommandRegistry.execute({
      type: 'generation.status',
      version: CANVAS_COMMAND_VERSION,
      input: { jobId: 'missing-job' },
    });
    expect(missingStatus).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
  });

  it('returns bounded serializable graph projections without full media bodies', async () => {
    useCanvasStore.getState().addNode(CANVAS_NODE_TYPES.upload, { x: 0, y: 0 }, {
      displayName: 'Reference',
      imageUrl: `data:image/png;base64,${'a'.repeat(2_000)}`,
      prompt: 'A'.repeat(2_000),
      apiKey: 'must-not-leak',
      request: {
        headers: {
          Authorization: 'Bearer must-not-leak',
          'X-API-Key': 'must-not-leak',
        },
      },
      localPath: '/Users/example/private/reference.png',
      uncommonPath: '/Volumes/private/reference.png',
      relativeFilePath: 'private/reference.png',
      bytes: new Uint8Array([1, 2, 3, 4]),
    });
    const result = await canvasCommandRegistry.execute({
      type: 'canvas.query',
      version: CANVAS_COMMAND_VERSION,
      input: { scope: 'graph', limit: 10 },
    });
    expect(result.ok).toBe(true);
    const serialized = JSON.stringify(result.ok ? result.output.value : null);
    expect(serialized).toContain('[media:');
    expect(serialized).toContain('A'.repeat(1_500));
    expect(serialized).toContain('[asset-reference:local]');
    expect(serialized).toContain('[asset-reference]');
    expect(serialized).toContain('[binary:4]');
    expect(serialized).not.toContain('a'.repeat(1_000));
    expect(serialized).not.toContain('must-not-leak');
    expect(serialized).not.toContain('/Volumes/private');
    expect(serialized).not.toContain('private/reference.png');
  });

  it('indexes nested storyboard, audio, and Director Studio assets through one catalog', async () => {
    useCanvasStore.getState().addNode(CANVAS_NODE_TYPES.storyboardSplit, { x: 0, y: 0 }, {
      frames: [{
        id: 'frame-1',
        imageUrl: 'https://example.com/frame.png',
        previewImageUrl: null,
        aspectRatio: '16:9',
        note: 'Opening frame',
        order: 0,
      }],
    });
    useCanvasStore.getState().addNode(CANVAS_NODE_TYPES.audio, { x: 200, y: 0 }, {
      audioUrl: 'https://example.com/voice.mp3',
    });
    useCanvasStore.getState().addNode(CANVAS_NODE_TYPES.blueprint, { x: 400, y: 0 }, {
      snapshotUrl: 'data:image/png;base64,director-snapshot',
      referenceImages: [{ id: 'hero', url: 'https://example.com/hero.png', label: 'Hero' }],
      items: [{
        id: 'actor',
        label: 'Actor',
        x: 0,
        y: 0,
        color: '#fff',
        refImageUrl: 'https://example.com/actor.png',
        refImageName: 'Actor identity',
      }],
      directorStudioProjects: [{
        id: 'project-1',
        name: 'Shot A',
        createdAt: 1,
        updatedAt: 1,
        coverUrl: 'https://example.com/cover.png',
        snapshot: {
          mode: 'flat',
          items: [{
            id: 'saved-actor',
            label: 'Saved actor',
            x: 0,
            y: 0,
            color: '#fff',
            refImageUrl: 'https://example.com/saved-actor.png',
            refImageName: 'Saved actor identity',
          }],
          referenceImages: [],
          aspectRatio: '16:9',
          snapshotUrl: 'https://example.com/project-shot.png',
        },
      }],
    });

    const result = await canvasCommandRegistry.execute({
      type: 'asset.list',
      version: CANVAS_COMMAND_VERSION,
      input: { limit: 100 },
    });
    expect(result.ok).toBe(true);
    const assets = result.ok ? result.output.value as Array<Record<string, unknown>> : [];
    expect(assets.map((asset) => asset.kind)).toEqual(expect.arrayContaining(['image', 'audio']));
    expect(assets.map((asset) => asset.title)).toEqual(expect.arrayContaining([
      'Opening frame',
      'Hero',
      'Actor identity',
      'Saved actor identity',
      'Shot A · 封面',
      'Shot A · 快照',
    ]));
    expect(JSON.stringify(assets)).not.toContain('https://example.com');
    expect(JSON.stringify(assets)).not.toContain('director-snapshot');
  });

  it('filters assets by query, node, selection, direct relationship, and region', async () => {
    const seedId = useCanvasStore.getState().addNode(CANVAS_NODE_TYPES.upload, { x: 0, y: 0 }, {
      displayName: 'Seed reference',
      imageUrl: 'https://example.com/seed.png',
    });
    const neighborId = useCanvasStore.getState().addNode(CANVAS_NODE_TYPES.upload, { x: 300, y: 0 }, {
      displayName: 'Direct neighbor',
      imageUrl: 'https://example.com/neighbor.png',
    });
    const transitiveId = useCanvasStore.getState().addNode(CANVAS_NODE_TYPES.upload, { x: 600, y: 0 }, {
      displayName: 'Transitive reference',
      imageUrl: 'https://example.com/transitive.png',
    });
    useCanvasStore.setState((state) => ({
      nodes: state.nodes.map((node) => ({ ...node, selected: node.id === seedId })),
      edges: [
        { id: 'seed-neighbor', source: seedId, target: neighborId },
        { id: 'neighbor-transitive', source: neighborId, target: transitiveId },
      ],
    }));

    const list = async (input: Extract<CanvasCommand, { type: 'asset.list' }>['input']) => {
      const result = await canvasCommandRegistry.execute({
        type: 'asset.list',
        version: CANVAS_COMMAND_VERSION,
        input,
      });
      expect(result.ok).toBe(true);
      return result.ok ? result.output.references.assetIds ?? [] : [];
    };

    await expect(list({ query: 'DIRECT NEIGHBOR' })).resolves.toEqual([`${neighborId}:image`]);
    await expect(list({ nodeIds: [transitiveId] })).resolves.toEqual([`${transitiveId}:image`]);
    await expect(list({ selectedOnly: true })).resolves.toEqual([`${seedId}:image`]);
    await expect(list({ relatedToNodeIds: [seedId] })).resolves.toEqual([
      `${seedId}:image`,
      `${neighborId}:image`,
    ]);
    await expect(list({ region: { x: 250, y: -10, width: 100, height: 20 } })).resolves.toEqual([
      `${neighborId}:image`,
    ]);

    const invalidRegion = await canvasCommandRegistry.execute({
      type: 'asset.list',
      version: CANVAS_COMMAND_VERSION,
      input: { region: { x: 0, y: 0, width: 0, height: 10 } },
    });
    expect(invalidRegion).toMatchObject({
      ok: false,
      error: { code: 'invalid_command', message: expect.stringContaining('positive width') },
    });
  });

  it('reports generation dispatch as accepted without presenting a stale job id as a new receipt', async () => {
    useCanvasStore.getState().addNode(CANVAS_NODE_TYPES.imageEdit, { x: 0, y: 0 }, {
      generationJobId: 'job-42',
      isGenerating: true,
    });
    const nodeId = useCanvasStore.getState().nodes[0].id;
    const triggered: string[] = [];
    const unsubscribe = canvasEventBus.subscribe('generation-node/trigger', ({ nodeId: triggeredId }) => {
      triggered.push(triggeredId);
    });

    const result = await canvasCommandRegistry.execute({
      type: 'generation.submit',
      version: CANVAS_COMMAND_VERSION,
      input: { nodeIds: [nodeId] },
    }, 'ui');
    unsubscribe();

    expect(result).toMatchObject({
      ok: true,
      output: {
        references: { nodeIds: [nodeId] },
        value: { acceptedNodeIds: [nodeId], status: 'accepted' },
      },
    });
    expect(result.ok ? result.output.references.jobIds : undefined).toBeUndefined();
    expect(triggered).toEqual([nodeId]);

    const status = await canvasCommandRegistry.execute({
      type: 'generation.status',
      version: CANVAS_COMMAND_VERSION,
      input: { jobId: 'job-42' },
    });
    expect(status).toMatchObject({
      ok: true,
      output: {
        references: { nodeId, jobId: 'job-42' },
        value: { status: 'running' },
      },
    });
  });

  it('creates an image generation node with the selected model, ratio, and resolution in one approved command', async () => {
    const result = await canvasCommandRegistry.execute({
      type: 'node.create',
      version: CANVAS_COMMAND_VERSION,
      input: {
        nodeType: CANVAS_NODE_TYPES.imageEdit,
        nodeId: 'agent-image-target',
        position: { x: 40, y: 80 },
        configuration: {
          prompt: 'cinematic portrait',
          modelId: 'agnes:image:gemini-2.1-flash-image-preview',
          aspectRatio: '16:9',
          resolution: '2K',
        },
      },
    }, 'agent');

    expect(result).toMatchObject({
      ok: true,
      output: { references: { nodeId: 'agent-image-target' } },
    });
    expect(useCanvasStore.getState().nodes.find((node) => node.id === 'agent-image-target')?.data)
      .toMatchObject({
        prompt: 'cinematic portrait',
        model: 'agnes:image:gemini-2.1-flash-image-preview',
        requestAspectRatio: '16:9',
        size: '2K',
        modelConfig: {
          entryId: 'agnes:image:gemini-2.1-flash-image-preview',
          ratio: '16:9',
          extraParams: { resolutionType: '2K' },
        },
      });
  });

  it('resolves generation status and result location through linked result nodes', async () => {
    useCanvasStore.getState().addNode(CANVAS_NODE_TYPES.imageEdit, { x: 0, y: 0 });
    const sourceNodeId = useCanvasStore.getState().nodes[0].id;
    useCanvasStore.getState().addDerivedExportNode(
      sourceNodeId,
      'https://example.com/generated.png',
      '16:9',
      undefined,
    );
    const resultNodeId = useCanvasStore.getState().nodes.find((node) => (
      node.type === CANVAS_NODE_TYPES.exportImage
    ))?.id as string;
    useCanvasStore.getState().updateNodeData(resultNodeId, { generationJobId: 'linked-job' });
    useCanvasStore.getState().addEdge(sourceNodeId, resultNodeId);

    const status = await canvasCommandRegistry.execute({
      type: 'generation.status',
      version: CANVAS_COMMAND_VERSION,
      input: { nodeId: sourceNodeId },
    });
    expect(status).toMatchObject({
      ok: true,
      output: {
        references: {
          nodeId: sourceNodeId,
          nodeIds: expect.arrayContaining([sourceNodeId, resultNodeId]),
          jobId: 'linked-job',
        },
        value: {
          status: 'succeeded',
          resultNodeId,
          resultNodeIds: [resultNodeId],
        },
      },
    });

    useCanvasStore.getState().updateNodeData(sourceNodeId, {
      generationJobId: 'source-job',
      isGenerating: true,
    });
    const runningStatus = await canvasCommandRegistry.execute({
      type: 'generation.status',
      version: CANVAS_COMMAND_VERSION,
      input: { nodeId: sourceNodeId, jobId: 'source-job' },
    });
    expect(runningStatus).toMatchObject({
      ok: true,
      output: {
        references: {
          nodeId: sourceNodeId,
          nodeIds: expect.arrayContaining([sourceNodeId, resultNodeId]),
          jobId: 'source-job',
          jobIds: expect.arrayContaining(['source-job', 'linked-job']),
        },
        value: {
          status: 'running',
          resultNodeId,
        },
      },
    });

    const locate = await canvasCommandRegistry.execute({
      type: 'generation.locateResult',
      version: CANVAS_COMMAND_VERSION,
      input: { jobId: 'source-job' },
    });
    expect(locate).toMatchObject({
      ok: true,
      output: { references: { nodeId: resultNodeId, jobId: 'source-job' } },
    });
  });
});
