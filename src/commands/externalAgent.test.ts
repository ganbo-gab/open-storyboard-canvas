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
  inspectExternalAgentInstallStatus,
  installExternalAgent,
  uninstallExternalAgent,
  previewExternalAgentInstall,
  listenExternalAgentEvents,
  replayExternalAgentPendingToolCalls,
  revokeExternalAgentConnection,
  startExternalAgentSession,
  type ExternalAgentStartRequest,
  type CreateExternalAgentConnectionRequest,
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
    const request: ExternalAgentStartRequest = {
      runtime: 'codex' as const,
      tools: [{
        name: 'node.create',
        description: 'Create a canvas node',
        inputSchema: { type: 'object', required: ['nodeType', 'position'], additionalProperties: false },
        requiresApproval: true,
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      }],
    };
    await startExternalAgentSession(request);
    expect(tauri.invoke).toHaveBeenCalledWith('start_external_agent_session', { request });
  });

  it('allows metadata without annotations without changing the approval requirement', async () => {
    tauri.invoke.mockResolvedValue({ sessionId: 'session-1', runtime: 'claude' });
    const request: ExternalAgentStartRequest = {
      runtime: 'claude',
      tools: [{ name: 'diagnostics', description: 'Inspect diagnostics', inputSchema: { type: 'object' }, requiresApproval: true }],
    };
    await startExternalAgentSession(request);
    expect(tauri.invoke).toHaveBeenCalledWith('start_external_agent_session', { request });
    expect(request.tools[0]).not.toHaveProperty('annotations');
    expect(request.tools[0].requiresApproval).toBe(true);
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
    const request: CreateExternalAgentConnectionRequest = {
      projectId: 'project-1',
      projectName: 'Opening sequence',
      tools: [{
        name: 'canvas.query',
        description: 'Inspect the canvas',
        inputSchema: { type: 'object', required: ['scope'], additionalProperties: false },
        requiresApproval: true,
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
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

  it.each(['codex', 'claude'] as const)('previews, installs, inspects and uninstalls %s with the exact cli argument', async (cli) => {
    const status = { cli, path: '/home/user/config', descriptorPath: '/app-data/mcp/osc.json', installed: true, state: 'installed', message: null };
    const preview = { status, changed: true, diff: '--- config\n+++ config\n@@ -0,0 +1 @@\n+storyboard_canvas\n' };
    tauri.invoke.mockResolvedValueOnce(preview);
    await expect(previewExternalAgentInstall(cli)).resolves.toEqual(preview);
    const installed = { status, changed: true, backupPath: '/home/user/config.osc-backup-1', restoredOriginal: false };
    tauri.invoke.mockResolvedValueOnce(installed);
    await expect(installExternalAgent(cli)).resolves.toEqual(installed);
    tauri.invoke.mockResolvedValueOnce(status);
    await expect(inspectExternalAgentInstallStatus(cli)).resolves.toEqual(status);
    const removed = { status: { ...status, installed: false, state: 'notInstalled' }, changed: true, backupPath: '/home/user/config.osc-backup-2', restoredOriginal: true };
    tauri.invoke.mockResolvedValueOnce(removed);
    await expect(uninstallExternalAgent(cli)).resolves.toEqual(removed);
    expect(tauri.invoke.mock.calls).toEqual([
      ['external_agent_install_preview', { cli }],
      ['external_agent_install', { cli }],
      ['external_agent_install_status', { cli }],
      ['external_agent_uninstall', { cli }],
    ]);
  });

  it('preserves structured installation failure categories and desktop-only behavior', async () => {
    tauri.invoke.mockRejectedValue({ code: 'invalid_request', message: 'Conflicting entry', retryable: false });
    await expect(installExternalAgent('codex')).rejects.toMatchObject({ code: 'invalid_request', message: 'Conflicting entry', retryable: false });
    tauri.invoke.mockClear();
    tauri.isTauri.mockReturnValue(false);
    await expect(previewExternalAgentInstall('claude')).rejects.toMatchObject({ code: 'runtime_unavailable', retryable: false });
    expect(tauri.invoke).not.toHaveBeenCalled();
  });
});
