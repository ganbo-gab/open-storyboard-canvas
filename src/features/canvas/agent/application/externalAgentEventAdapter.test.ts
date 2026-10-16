import { describe, expect, it } from 'vitest';
import { CANVAS_REGISTERED_COMMAND_TYPES } from '@/features/canvas/application/canvasCommandRegistry';
import { useCanvasStore } from '@/stores/canvasStore';
import { useProjectStore } from '@/stores/projectStore';
import { canvasAgentApprovalStore, createApprovalId } from './agentApproval';
import { prepareExternalAgentToolRequest } from './externalAgentCanvasBridge';
import {
  normalizeExternalAgentEvent,
  projectExternalAgentRuntimeDiagnostic,
} from './externalAgentEventAdapter';

describe('external Agent event adapter', () => {
  it('maps native diagnostic status without exposing executable paths', () => {
    expect(projectExternalAgentRuntimeDiagnostic({
      runtime: 'claude',
      installed: true,
      compatible: true,
      authenticated: false,
      version: '1.2.3',
      executableName: 'claude',
      status: 'authRequired',
      message: 'login first',
    })).toEqual(expect.objectContaining({
      runtime: 'claude',
      availability: 'login-required',
      executableLabel: 'claude',
      detail: 'login first',
    }));
  });

  it.each(['shell', 'node.unknown', 'node.create.extra', 'toString', 'canvas_command'])('fails closed on unknown or legacy external tool %s', (name) => {
    expect(() => normalizeExternalAgentEvent({
      schemaVersion: 1,
      sessionId: 'session-1',
      runtime: 'codex',
      turnId: 'turn-1',
      kind: 'toolRequested',
      message: null,
      data: null,
      toolCall: { callId: 'call-1', name, input: {}, requiresApproval: true },
    })).toThrow(/unknown tool/i);
  });

  it.each(CANVAS_REGISTERED_COMMAND_TYPES)('normalizes registered command %s into the existing approval request', (name) => {
    const input = { nodeIds: ['node-1'], prompt: 'Keep the original command input.' };
    expect(normalizeExternalAgentEvent({
      schemaVersion: 1,
      sessionId: 'session-1',
      runtime: 'codex',
      turnId: 'turn-1',
      kind: 'toolRequested',
      message: null,
      data: null,
      toolCall: { callId: 'call-1', name, input, requiresApproval: true },
    })).toEqual({
      version: 1,
      kind: 'tool_requested',
      runtime: 'codex',
      sessionId: 'session-1',
      turnId: 'turn-1',
      request: {
        version: 1,
        runtime: 'codex',
        sessionId: 'session-1',
        turnId: 'turn-1',
        callId: 'call-1',
        toolName: 'canvas_command',
        arguments: { type: name, version: 1, input },
      },
    });
  });

  it.each([true, false])('keeps normalized edits pending application approval even when native requiresApproval is %s', async (requiresApproval) => {
    const canvasBefore = useCanvasStore.getState();
    const projectBefore = useProjectStore.getState();
    const turnId = 'adapter-approval-turn';
    try {
      useProjectStore.setState({ currentProjectId: 'adapter-project' });
      useCanvasStore.setState({
        nodes: [{
          id: 'node-1',
          type: 'tagNode',
          position: { x: 0, y: 0 },
          data: { displayName: 'Reference', label: 'Reference', enabled: true, color: 'neutral' },
        }],
        edges: [],
        revision: 0,
        selectedNodeId: null,
        history: { past: [], future: [] },
      });
      const beforeApproval = useCanvasStore.getState();
      const event = normalizeExternalAgentEvent({
        schemaVersion: 1,
        sessionId: 'session-1',
        runtime: 'claude',
        turnId,
        kind: 'toolRequested',
        message: null,
        data: null,
        toolCall: { callId: 'call-1', name: 'node.delete', input: { nodeIds: ['node-1'] }, requiresApproval },
      });
      if (event.kind !== 'tool_requested') throw new Error('Expected an approval request.');

      const view = await prepareExternalAgentToolRequest({ projectId: 'adapter-project', request: event.request });

      expect(view).toMatchObject({ id: 'call-1', toolName: 'canvas_command' });
      expect(canvasAgentApprovalStore.get(createApprovalId(turnId, 'canvas_command', 'call-1')))
        .toMatchObject({ projectId: 'adapter-project', status: 'awaiting-approval' });
      expect(useCanvasStore.getState()).toMatchObject({
        nodes: beforeApproval.nodes,
        edges: beforeApproval.edges,
        revision: beforeApproval.revision,
        history: beforeApproval.history,
      });
    } finally {
      canvasAgentApprovalStore.deleteRun(turnId);
      useCanvasStore.setState(canvasBefore);
      useProjectStore.setState(projectBefore);
    }
  });

  it.each(['diagnostics', 'config_patch', 'asset_read'] as const)('keeps auxiliary tool %s arguments unwrapped', (name) => {
    const input = { operation: 'health' };
    expect(normalizeExternalAgentEvent({
      schemaVersion: 1,
      sessionId: 'session-1',
      runtime: 'claude',
      turnId: 'turn-1',
      kind: 'toolRequested',
      message: null,
      data: null,
      toolCall: { callId: 'call-1', name, input, requiresApproval: true },
    })).toMatchObject({ kind: 'tool_requested', request: { toolName: name, arguments: input } });
  });

  it('redacts dynamic command input inside the normalized approval envelope', () => {
    const event = normalizeExternalAgentEvent({
      schemaVersion: 1,
      sessionId: 'session-1',
      runtime: 'codex',
      turnId: 'turn-1',
      kind: 'toolRequested',
      message: null,
      data: null,
      toolCall: {
        callId: 'call-1',
        name: 'node.setModelConfig',
        input: { nodeId: 'node-1', modelId: 'model-1', extraParams: { authorization: 'Bearer should-not-leak' } },
        requiresApproval: true,
      },
    });
    expect(event).toMatchObject({
      kind: 'tool_requested',
      request: { toolName: 'canvas_command', arguments: { type: 'node.setModelConfig', version: 1, input: { nodeId: 'node-1', modelId: 'model-1' } } },
    });
    expect(JSON.stringify(event)).not.toContain('should-not-leak');
  });

  it('redacts dynamic payloads before exposing them to the panel', () => {
    const event = normalizeExternalAgentEvent({
      schemaVersion: 1,
      sessionId: 'session-1',
      runtime: 'claude',
      turnId: 'turn-1',
      kind: 'toolRequested',
      message: null,
      data: null,
      toolCall: {
        callId: 'call-1',
        name: 'diagnostics',
        input: { authorization: 'Bearer should-not-leak', path: '/Users/alice/file.png' },
        requiresApproval: true,
      },
    });
    expect(JSON.stringify(event)).not.toContain('should-not-leak');
    expect(JSON.stringify(event)).not.toContain('/Users/alice');
  });

  it('keeps streamed plan text and accepts session-level cancellation', () => {
    expect(normalizeExternalAgentEvent({
      schemaVersion: 1,
      sessionId: 'session-1',
      runtime: 'codex',
      turnId: 'turn-1',
      kind: 'plan',
      message: 'Inspect the selected nodes first.',
      data: null,
      toolCall: null,
    })).toEqual(expect.objectContaining({
      kind: 'plan',
      delta: 'Inspect the selected nodes first.',
      turnId: 'turn-1',
    }));

    expect(normalizeExternalAgentEvent({
      schemaVersion: 1,
      sessionId: 'session-1',
      runtime: 'codex',
      turnId: null,
      kind: 'canceled',
      message: null,
      data: null,
      toolCall: null,
    })).toEqual({
      version: 1,
      kind: 'cancelled',
      runtime: 'codex',
      sessionId: 'session-1',
      turnId: undefined,
    });
  });

  it('fails closed on unsupported event versions', () => {
    expect(() => normalizeExternalAgentEvent({
      schemaVersion: 2 as 1,
      sessionId: 'session-1',
      runtime: 'codex',
      turnId: null,
      kind: 'sessionStarted',
      message: null,
      data: null,
      toolCall: null,
    })).toThrow(/unsupported external Agent event version/i);
  });
});
