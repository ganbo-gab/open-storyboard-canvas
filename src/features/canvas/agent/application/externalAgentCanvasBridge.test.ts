import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCanvasStore } from '@/stores/canvasStore';
import { useProjectStore } from '@/stores/projectStore';
import { canvasAgentApprovalStore, createApprovalId } from './agentApproval';
import {
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

  it('creates the same persisted approval card used by the built-in Agent', async () => {
    const view = await prepareExternalAgentToolRequest({ projectId: 'project-1', request: request() });
    expect(view).toMatchObject({ id: 'call-1', toolName: 'canvas_command' });
    expect(canvasAgentApprovalStore.get(createApprovalId('turn-1', 'canvas_command', 'call-1')))
      .toMatchObject({ projectId: 'project-1', status: 'awaiting-approval' });
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
