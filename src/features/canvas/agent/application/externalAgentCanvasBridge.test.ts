import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCanvasStore } from '@/stores/canvasStore';
import { useProjectStore } from '@/stores/projectStore';
import { canvasAgentApprovalStore, createApprovalId } from './agentApproval';
import { canvasAgentBudgetLedger } from './agentBudget';
import { buildExternalCanvasMcpManifest, assertExternalCanvasToolAllowed } from './externalAgentToolManifest';
import type { ExternalAgentToolRequestInput } from './externalAgentToolRequest';
import type { CanvasCommandExecutionResult } from '@/features/canvas/domain/canvasCommands';
import {
  cancelExternalAgentToolRequest,
  prepareExternalAgentToolRequest,
  resolveExternalAgentToolApproval,
} from './externalAgentCanvasBridge';
import type { ExternalAgentToolRequest } from '../domain/agentModel';

const commandMocks = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock('@/commands/externalAgent', () => ({ resolveExternalAgentToolCall: commandMocks.resolve }));

function request(): ExternalAgentToolRequest {
  return {
    version: 1,
    runtime: 'codex',
    sessionId: 'session-1',
    turnId: 'turn-1',
    callId: 'call-1',
    toolName: 'canvas_command',
    arguments: { type: 'node.delete', input: { nodeIds: ['node-1'] } },
  };
}

function assetReadRequest(): ExternalAgentToolRequest {
  return {
    ...request(),
    callId: 'asset-call-1',
    toolName: 'asset_read',
    arguments: { assetId: 'node-1:image' },
  };
}

function deterministicToolRequest(): ExternalAgentToolRequest {
  return {
    ...request(),
    callId: 'deterministic-tool-call',
    arguments: { type: 'node.tool.run', input: { nodeId: 'node-1', toolType: 'crop' } },
  };
}

function recoveryRequest(): ExternalAgentToolRequest {
  return {
    ...request(),
    callId: 'recover-call-1',
    arguments: { type: 'generation.recover', input: { jobId: 'job-1', nodeIds: ['node-1'] } },
  };
}

describe('external Agent Canvas approval bridge', () => {
  beforeEach(() => {
    commandMocks.resolve.mockReset().mockResolvedValue(undefined);
    canvasAgentApprovalStore.deleteRun('turn-1');
    canvasAgentBudgetLedger.reset('project-1');
    canvasAgentBudgetLedger.setLimit('project-1', null);
    useProjectStore.setState({ currentProjectId: 'project-1' });
    useCanvasStore.setState((state) => ({
      ...state,
      nodes: [{
        id: 'node-1',
        type: 'tagNode',
        position: { x: 0, y: 0 },
        data: { displayName: 'Reference' },
      } as any],
      edges: [],
      selectedNodeId: null,
      revision: 0,
      history: { past: [], future: [] },
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects tools outside the selected whitelist before creating an approval, including normalized MCP commands', async () => {
    await expect(prepareExternalAgentToolRequest({ projectId: 'project-1', request: request(), allowedToolNames: ['diagnostics'] })).rejects.toThrow();
    expect(canvasAgentApprovalStore.listByRun('turn-1')).toEqual([]);
    const command: ExternalAgentToolRequestInput = { ...request(), toolName: 'node.delete', arguments: { nodeIds: ['node-1'] } };
    await expect(prepareExternalAgentToolRequest({ projectId: 'project-1', request: command, allowedToolNames: [] })).rejects.toThrow();
    expect(canvasAgentApprovalStore.listByRun('turn-1')).toEqual([]);
    expect(useCanvasStore.getState().nodes.map((node) => node.id)).toEqual(['node-1']);
  });

  it('executes registered MCP create/connect tools only after approval at the preview revision', async () => {
    const manifest = buildExternalCanvasMcpManifest(['canvas']);
    vi.spyOn(useProjectStore.getState(), 'saveCurrentProject').mockImplementation(() => undefined);
    vi.spyOn(useProjectStore.getState(), 'waitForProjectPersistence').mockResolvedValue(undefined);
    const ids: string[] = [];
    for (const callId of ['create-source', 'create-target']) {
      const tool = assertExternalCanvasToolAllowed(manifest, 'node.create');
      const toolRequest: ExternalAgentToolRequestInput = {
        ...request(), callId, toolName: tool.name,
        arguments: { nodeType: 'imageNode', position: { x: ids.length * 600, y: 0 }, configuration: { prompt: callId } },
      };
      const revision = useCanvasStore.getState().revision;
      await prepareExternalAgentToolRequest({ projectId: 'project-1', request: toolRequest });
      expect(useCanvasStore.getState().revision).toBe(revision);
      expect(canvasAgentApprovalStore.get(createApprovalId('turn-1', 'canvas_command', callId)))
        .toMatchObject({ status: 'awaiting-approval', baseRevision: revision });
      const result = await resolveExternalAgentToolApproval({ projectId: 'project-1', request: toolRequest, approve: true });
      const output = result.output as CanvasCommandExecutionResult;
      expect(result.status).toBe('approved');
      expect(output).toMatchObject({ ok: true, revisionBefore: revision, revisionAfter: revision + 1 });
      if (!output.ok || !output.output.references.nodeId) throw new Error('Creation did not return a registered node reference.');
      ids.push(output.output.references.nodeId);
    }
    const connect: ExternalAgentToolRequestInput = {
      ...request(), callId: 'connect-created', toolName: assertExternalCanvasToolAllowed(manifest, 'edge.connect').name,
      arguments: { sourceNodeId: ids[0], targetNodeId: ids[1] },
    };
    await prepareExternalAgentToolRequest({ projectId: 'project-1', request: connect });
    expect(useCanvasStore.getState().edges).toEqual([]);
    const result = await resolveExternalAgentToolApproval({ projectId: 'project-1', request: connect, approve: true });
    expect(result).toMatchObject({ status: 'approved', output: { ok: true, revisionBefore: 2, revisionAfter: 3 } });
    expect(useCanvasStore.getState().edges).toEqual([expect.objectContaining({ source: ids[0], target: ids[1] })]);
    expect(commandMocks.resolve).toHaveBeenCalledTimes(3);
    expect(useCanvasStore.getState().history.past).toHaveLength(1);
  });

  it('invalidates a stale revision without executing the registered command', async () => {
    const toolRequest = request();
    await prepareExternalAgentToolRequest({ projectId: 'project-1', request: toolRequest });
    useCanvasStore.setState({ revision: 1 });
    const result = await resolveExternalAgentToolApproval({ projectId: 'project-1', request: toolRequest, approve: true });
    expect(result.status).toBe('error');
    expect(canvasAgentApprovalStore.get(createApprovalId('turn-1', 'canvas_command', 'call-1'))?.status).toBe('conflicted');
    expect(useCanvasStore.getState()).toMatchObject({ revision: 1, nodes: [expect.objectContaining({ id: 'node-1' })], history: { past: [], future: [] } });
  });

  it('invalidates arguments changed after the preview without executing them', async () => {
    const toolRequest = request();
    await prepareExternalAgentToolRequest({ projectId: 'project-1', request: toolRequest });
    const changed = { ...toolRequest, arguments: { type: 'node.delete', input: { nodeIds: [] } } };
    expect(await resolveExternalAgentToolApproval({ projectId: 'project-1', request: changed, approve: true }))
      .toMatchObject({ status: 'error', error: expect.stringContaining('arguments changed') });
    expect(canvasAgentApprovalStore.get(createApprovalId('turn-1', 'canvas_command', 'call-1'))?.status).toBe('conflicted');
    expect(useCanvasStore.getState().revision).toBe(0);
  });

  it('revokes stopped approvals and cannot recreate a pending card for them', async () => {
    const toolRequest = request();
    await prepareExternalAgentToolRequest({ projectId: 'project-1', request: toolRequest });
    cancelExternalAgentToolRequest({ projectId: 'project-1', request: toolRequest });
    expect(canvasAgentApprovalStore.get(createApprovalId('turn-1', 'canvas_command', 'call-1'))?.status).toBe('cancelled');
    const resumedPreview = await prepareExternalAgentToolRequest({ projectId: 'project-1', request: toolRequest }).catch(() => null);
    expect(resumedPreview).toBeNull();
    expect(canvasAgentApprovalStore.get(createApprovalId('turn-1', 'canvas_command', 'call-1'))?.status).toBe('cancelled');
    expect(await resolveExternalAgentToolApproval({ projectId: 'project-1', request: toolRequest, approve: true })).toMatchObject({ status: 'error' });
    expect(useCanvasStore.getState().revision).toBe(0);
    expect(canvasAgentBudgetLedger.get('project-1').reservations).toEqual({});
  });

  it('revokes approval preparations that finish after the turn was stopped', async () => {
    const toolRequest = request();
    const preparation = prepareExternalAgentToolRequest({ projectId: 'project-1', request: toolRequest });
    cancelExternalAgentToolRequest({ projectId: 'project-1', request: toolRequest });
    expect(await preparation.catch(() => null)).toBeNull();
    expect(canvasAgentApprovalStore.get(createApprovalId('turn-1', 'canvas_command', 'call-1'))?.status).toBe('cancelled');
    expect(useCanvasStore.getState().revision).toBe(0);
  });

  it('does not interrupt an already executing write when pending cards expire', async () => {
    const toolRequest = request();
    vi.spyOn(useProjectStore.getState(), 'saveCurrentProject').mockImplementation(() => undefined);
    vi.spyOn(useProjectStore.getState(), 'waitForProjectPersistence').mockImplementation(async () => {
      cancelExternalAgentToolRequest({ projectId: 'project-1', request: toolRequest });
    });
    await prepareExternalAgentToolRequest({ projectId: 'project-1', request: toolRequest });
    expect(await resolveExternalAgentToolApproval({ projectId: 'project-1', request: toolRequest, approve: true })).toMatchObject({ status: 'approved' });
    expect(canvasAgentApprovalStore.get(createApprovalId('turn-1', 'canvas_command', 'call-1'))?.status).toBe('succeeded');
    expect(useCanvasStore.getState().nodes).toEqual([]);
  });

  it('settles the budget before native delivery and replays receipts without another edit or charge', async () => {
    const toolRequest = request();
    vi.spyOn(useProjectStore.getState(), 'saveCurrentProject').mockImplementation(() => undefined);
    vi.spyOn(useProjectStore.getState(), 'waitForProjectPersistence').mockResolvedValue(undefined);
    await prepareExternalAgentToolRequest({ projectId: 'project-1', request: toolRequest });
    const approvalId = createApprovalId('turn-1', 'canvas_command', 'call-1');
    const approval = canvasAgentApprovalStore.get(approvalId);
    if (!approval) throw new Error('Missing prepared approval.');
    canvasAgentApprovalStore.update(approvalId, { impact: { ...approval.impact, estimatedCost: { value: 5, confidence: 'known' } } });
    commandMocks.resolve.mockRejectedValueOnce(new Error('native session closed'));
    await expect(resolveExternalAgentToolApproval({ projectId: 'project-1', request: toolRequest, approve: true })).rejects.toThrow(/native session closed/);
    const revision = useCanvasStore.getState().revision;
    expect(canvasAgentBudgetLedger.get('project-1')).toMatchObject({ spent: 5, reservations: {} });
    expect(await resolveExternalAgentToolApproval({ projectId: 'project-1', request: toolRequest, approve: true })).toMatchObject({ status: 'approved' });
    const duplicatePreview = await prepareExternalAgentToolRequest({ projectId: 'project-1', request: toolRequest }).catch(() => null);
    expect(duplicatePreview).toBeNull();
    expect(canvasAgentApprovalStore.listByRun('turn-1')).toEqual([expect.objectContaining({ id: approvalId, status: 'succeeded' })]);
    expect(useCanvasStore.getState()).toMatchObject({ nodes: [], revision });
    expect(canvasAgentBudgetLedger.get('project-1')).toMatchObject({ spent: 5, reservations: {} });
  });

  it('leaves a terminal ledger entry when budget rejection closes a tool call', async () => {
    const toolRequest = request();
    await prepareExternalAgentToolRequest({ projectId: 'project-1', request: toolRequest });
    const approvalId = createApprovalId('turn-1', 'canvas_command', 'call-1');
    const approval = canvasAgentApprovalStore.get(approvalId);
    if (!approval) throw new Error('Missing prepared approval.');
    canvasAgentApprovalStore.update(approvalId, { impact: { ...approval.impact, estimatedCost: { value: 5, confidence: 'known' } } });
    canvasAgentBudgetLedger.setLimit('project-1', 0);
    expect(await resolveExternalAgentToolApproval({ projectId: 'project-1', request: toolRequest, approve: true }))
      .toMatchObject({ status: 'error', error: expect.stringContaining('budget') });
    expect(canvasAgentApprovalStore.get(approvalId)?.status).toBe('failed');
    expect(canvasAgentBudgetLedger.get('project-1').reservations).toEqual({});
    expect(useCanvasStore.getState().revision).toBe(0);
  });

  it('creates the same persisted approval card used by the built-in Agent', async () => {
    const view = await prepareExternalAgentToolRequest({ projectId: 'project-1', request: request() });
    expect(view).toMatchObject({ id: 'call-1', toolName: 'canvas_command' });
    expect(canvasAgentApprovalStore.get(createApprovalId('turn-1', 'canvas_command', 'call-1')))
      .toMatchObject({ projectId: 'project-1', status: 'awaiting-approval' });
  });

  it('approves and executes a managed MCP node.create request with its independent tool name', async () => {
    const managedRequest = {
      ...request(),
      toolName: 'node.create' as ExternalAgentToolRequest['toolName'],
      arguments: { nodeType: 'tagNode', nodeId: 'managed-created', position: { x: 160, y: 80 } },
    };
    const persist = vi.spyOn(useProjectStore.getState(), 'saveCurrentProject').mockImplementation(() => undefined);
    const wait = vi.spyOn(useProjectStore.getState(), 'waitForProjectPersistence').mockResolvedValue(undefined);
    try {
      const view = await prepareExternalAgentToolRequest({ projectId: 'project-1', request: managedRequest });
      expect(view.toolName).toBe('canvas_command');
      expect(useCanvasStore.getState().nodes).toHaveLength(1);
      const result = await resolveExternalAgentToolApproval({ projectId: 'project-1', request: managedRequest, approve: true });
      expect(result.status).toBe('approved');
      expect(useCanvasStore.getState().nodes).toHaveLength(2);
      expect(useCanvasStore.getState().nodes.some((node) => node.id === 'managed-created')).toBe(true);
      expect(commandMocks.resolve).toHaveBeenCalledWith(expect.objectContaining({
        callId: 'call-1', resolution: expect.objectContaining({ outcome: 'approved' }),
      }));
    } finally {
      persist.mockRestore();
      wait.mockRestore();
    }
  });

  it('classifies deterministic tool workflows as persisted canvas writes', async () => {
    const toolRequest = deterministicToolRequest();
    await prepareExternalAgentToolRequest({ projectId: 'project-1', request: toolRequest });
    expect(canvasAgentApprovalStore.get(createApprovalId('turn-1', 'canvas_command', toolRequest.callId)))
      .toMatchObject({ impact: { effect: 'canvas-write', externalSideEffect: false } });
  });

  it('describes result recovery as a canvas write without a new paid submission', async () => {
    const toolRequest = recoveryRequest();
    const view = await prepareExternalAgentToolRequest({ projectId: 'project-1', request: toolRequest });
    expect(view).toMatchObject({ impact: { effect: 'canvas-write', externalSideEffect: false } });
    expect(view.summary).toContain('不会提交生成 POST');
    expect(view.summary).toContain('不会产生新的生成费用');
  });

  it('returns a typed denial without changing canvas revision or history', async () => {
    const toolRequest = request();
    await prepareExternalAgentToolRequest({ projectId: 'project-1', request: toolRequest });
    const before = useCanvasStore.getState();
    const result = await resolveExternalAgentToolApproval({
      projectId: 'project-1',
      request: toolRequest,
      approve: false,
    });
    const after = useCanvasStore.getState();

    expect(result.status).toBe('denied');
    expect(after.revision).toBe(before.revision);
    expect(after.history).toEqual(before.history);
    expect(after.nodes).toEqual(before.nodes);
    expect(commandMocks.resolve).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      callId: 'call-1',
      resolution: expect.objectContaining({ outcome: 'denied', errorCode: 'user_denied' }),
    }));
    expect(canvasAgentApprovalStore.get(createApprovalId('turn-1', 'canvas_command', 'call-1'))?.status).toBe('rejected');
    const deniedPreview = await prepareExternalAgentToolRequest({ projectId: 'project-1', request: toolRequest }).catch(() => null);
    expect(deniedPreview).toBeNull();
    expect(canvasAgentApprovalStore.get(createApprovalId('turn-1', 'canvas_command', 'call-1'))?.status).toBe('rejected');
    expect(useCanvasStore.getState()).toMatchObject({ nodes: before.nodes, revision: before.revision, history: before.history });
  });

  it('returns a terminal error after application failure without changing canvas state', async () => {
    const toolRequest = assetReadRequest();
    await prepareExternalAgentToolRequest({ projectId: 'project-1', request: toolRequest });
    const before = useCanvasStore.getState();
    const revisionBefore = before.revision;
    const historyBefore = structuredClone(before.history);
    const nodesBefore = structuredClone(before.nodes);

    const result = await resolveExternalAgentToolApproval({
      projectId: 'project-1',
      request: toolRequest,
      approve: true,
    });

    expect(result).toMatchObject({
      status: 'error',
      error: expect.stringMatching(/temporary resource/i),
    });
    expect(commandMocks.resolve).toHaveBeenLastCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      callId: 'asset-call-1',
      resolution: expect.objectContaining({ outcome: 'error', errorCode: 'canvas_tool_failed' }),
    }));
    const after = useCanvasStore.getState();
    expect(after.revision).toBe(revisionBefore);
    expect(after.history).toEqual(historyBefore);
    expect(after.nodes).toEqual(nodesBefore);

    commandMocks.resolve.mockRejectedValueOnce(new Error('native tool call already resolved'));
    await expect(resolveExternalAgentToolApproval({
      projectId: 'project-1',
      request: toolRequest,
      approve: true,
    })).rejects.toThrow(/already resolved/i);
    expect(useCanvasStore.getState()).toMatchObject({
      revision: revisionBefore,
      history: historyBefore,
      nodes: nodesBefore,
    });
  });

  it('throws when the terminal resolution cannot be delivered to the native session', async () => {
    const toolRequest = request();
    await prepareExternalAgentToolRequest({ projectId: 'project-1', request: toolRequest });
    commandMocks.resolve.mockRejectedValueOnce(new Error('native session closed'));

    await expect(resolveExternalAgentToolApproval({
      projectId: 'project-1',
      request: toolRequest,
      approve: false,
    })).rejects.toThrow(/native session closed/i);
    expect(useCanvasStore.getState()).toMatchObject({ revision: 0, history: { past: [], future: [] } });
  });
});
