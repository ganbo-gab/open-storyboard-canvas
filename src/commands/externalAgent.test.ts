import { beforeEach, describe, expect, it, vi } from 'vitest';

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => true),
  listen: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke, isTauri: tauri.isTauri }));
vi.mock('@tauri-apps/api/event', () => ({ listen: tauri.listen }));

import {
  createExternalAgentConnection,
  diagnoseExternalAgentRuntimes,
  inspectExternalAgentConnection,
  listenExternalAgentEvents,
  replayExternalAgentPendingToolCalls,
  revokeExternalAgentConnection,
  startExternalAgentSession,
} from './externalAgent';

describe('external Agent Tauri commands', () => {
  beforeEach(() => {
    tauri.invoke.mockReset();
    tauri.listen.mockReset();
    tauri.isTauri.mockReturnValue(true);
  });

  it('uses the exact diagnostic command without arguments', async () => {
    tauri.invoke.mockResolvedValue([]);
    await expect(diagnoseExternalAgentRuntimes()).resolves.toEqual([]);
    expect(tauri.invoke).toHaveBeenCalledWith('diagnose_external_agent_runtimes', undefined);
  });

  it('forwards an allowlisted tool manifest as a structured start request', async () => {
    tauri.invoke.mockResolvedValue({ sessionId: 'session-1', runtime: 'codex' });
    const request = {
      runtime: 'codex' as const,
      tools: [{
        name: 'canvas_command',
        description: 'Canvas only',
        inputSchema: { type: 'object' },
        requiresApproval: true,
      }],
    };
    await startExternalAgentSession(request);
    expect(tauri.invoke).toHaveBeenCalledWith('start_external_agent_session', { request });
  });

  it('reports unknown event versions instead of silently accepting them', async () => {
    let listener: ((event: { payload: any }) => void) | undefined;
    tauri.listen.mockImplementation(async (_name, callback) => {
      listener = callback;
      return vi.fn();
    });
    const protocolError = vi.fn();
    await listenExternalAgentEvents(vi.fn(), protocolError);
    listener?.({ payload: { schemaVersion: 2 } });
    expect(protocolError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/unsupported/i) }));
  });

  it('creates, inspects, and revokes a user-managed MCP connection without a runtime id', async () => {
    tauri.invoke.mockResolvedValue({ schemaVersion: 1, status: 'ready' });
    const request = {
      projectId: 'project-1',
      projectName: 'Opening sequence',
      tools: [{
        name: 'canvas_command',
        description: 'Canvas only',
        inputSchema: { type: 'object' },
        requiresApproval: true,
      }],
    };
    await createExternalAgentConnection(request);
    await inspectExternalAgentConnection();
    await revokeExternalAgentConnection('connection-1');
    await replayExternalAgentPendingToolCalls();
    expect(tauri.invoke).toHaveBeenNthCalledWith(1, 'create_external_agent_connection', { request });
    expect(tauri.invoke).toHaveBeenNthCalledWith(2, 'inspect_external_agent_connection', undefined);
    expect(tauri.invoke).toHaveBeenNthCalledWith(3, 'revoke_external_agent_connection', {
      connectionId: 'connection-1',
    });
    expect(tauri.invoke).toHaveBeenNthCalledWith(4, 'replay_external_agent_pending_tool_calls', undefined);
  });
});
