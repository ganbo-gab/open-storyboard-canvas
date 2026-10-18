import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatCatalogEntry } from '@/features/canvas/application/chatModelCatalog';
import type { CanvasAgentTurnResult } from '@/features/canvas/agent/application/canvasAgentController';
import { createScopedAgentSession, getScopedAgentSession } from './scopedAgentSession';

const controller = vi.hoisted(() => ({ run: vi.fn(), resolve: vi.fn(), cancel: vi.fn(), session: vi.fn(), messages: vi.fn(() => []), pending: vi.fn(() => []), list: vi.fn(() => []) }));
vi.mock('@/features/canvas/agent/application/canvasAgentController', () => ({
  runCanvasAgentTurn: controller.run, resolveCanvasAgentApproval: controller.resolve, cancelCanvasAgentRun: controller.cancel,
  getCanvasAgentSession: controller.session, getCanvasAgentSessionMessages: controller.messages,
  listPendingCanvasAgentApprovals: controller.pending, listCanvasAgentSessions: controller.list,
}));
const model: ChatCatalogEntry = { id: 'model', providerId: 'p', providerLabel: 'P', modelId: 'm', modelLabel: 'M', supportsMultimodal: true, supportsTools: true, supportsStreaming: true, supportsReasoningSummary: false, supportsToolSearch: false, agentProtocol: 'openai-chat-completions', usable: true };
const result: CanvasAgentTurnResult = { runId: 'run', sessionId: 'session', finalText: 'Done', approvals: [], status: 'completed', skillSelection: { skillIds: [], reason: '', estimatedTokens: 0, toolCount: 0, mode: 'minimal', deferredToolCount: 0 } };

beforeEach(() => { vi.clearAllMocks(); controller.run.mockResolvedValue(result); });

describe('generic scoped Agent session service', () => {
  it('retains cached home approvals after unsubscribe and keeps scope/project caches distinct', async () => {
    controller.run.mockResolvedValueOnce({ ...result, status: 'awaiting-approval', approvals: [{ id: 'cached-paid', toolName: 'home_generation_submit', arguments: {}, summary: 'Paid', expiresAt: Date.now() + 1000, impact: { effect: 'external-submit', title: 'paid', summary: 'Paid', affectedNodeCount: 1, affectedEdgeCount: 0, externalSideEffect: true } }] });
    const home = getScopedAgentSession({ scope: 'home', projectId: 'cache-home' });
    const unsubscribe = home.subscribe(vi.fn());
    await home.send({ message: 'generate', model });
    unsubscribe();
    const returned = getScopedAgentSession({ scope: 'home', projectId: 'cache-home' });
    expect(returned).toBe(home);
    expect(returned.getSnapshot().status).toBe('awaiting-approval');
    expect(returned.getSnapshot().approvals[0].id).toBe('cached-paid');
    expect(controller.cancel).not.toHaveBeenCalled();
    expect(getScopedAgentSession({ scope: 'canvas', projectId: 'cache-home' })).not.toBe(home);
    expect(getScopedAgentSession({ scope: 'stage', projectId: 'cache-home' })).not.toBe(home);
    expect(getScopedAgentSession({ scope: 'home', projectId: 'other' })).not.toBe(home);
    expect(createScopedAgentSession({ scope: 'home', projectId: 'cache-home' })).not.toBe(home);
    returned.stop();
    await expect(returned.resolveApproval({ approvalId: 'cached-paid', approve: true, model })).rejects.toThrow(/失效/);
    expect(controller.resolve).not.toHaveBeenCalled();
  });

  it('maintains separate session identity and supplies scope to the SDK controller', async () => {
    const home = createScopedAgentSession({ scope: 'home' });
    const stage = createScopedAgentSession({ scope: 'stage', projectId: 'p' });
    await home.send({ message: 'hello', model });
    expect(controller.run.mock.calls[0][0]).toMatchObject({ scope: 'home', projectId: 'home' });
    expect(home.getSnapshot().sessionId).toBe('session');
    expect(stage.getSnapshot().sessionId).toBeUndefined();
    controller.session.mockReturnValue({ projectId: 'p', scope: 'canvas' });
    expect(() => stage.loadSession('canvas-session')).toThrow(/作用域/);
  });

  it('synchronously gates repeated sends and publishes cancellation without continuing tool authority', async () => {
    let release: ((value: CanvasAgentTurnResult) => void) | undefined;
    controller.run.mockImplementationOnce(() => new Promise<CanvasAgentTurnResult>((resolve) => { release = resolve; }));
    const service = createScopedAgentSession({ scope: 'home' });
    const listener = vi.fn();
    service.subscribe(listener);
    const first = service.send({ message: 'first', model });
    await expect(service.send({ message: 'duplicate', model })).rejects.toThrow(/尚未完成/);
    const signal = controller.run.mock.calls[0][0].signal as AbortSignal;
    service.stop();
    expect(signal.aborted).toBe(true);
    expect(service.getSnapshot().status).toBe('cancelled');
    release?.(result);
    await first;
    expect(controller.cancel).toHaveBeenCalledWith('run');
    expect(service.getSnapshot().status).toBe('cancelled');
    expect(listener).toHaveBeenCalled();
  });

  it('keeps approvals isolated to the active session and cancels pending approvals on stop', async () => {
    controller.run.mockResolvedValueOnce({ ...result, status: 'awaiting-approval', approvals: [{ id: 'paid', toolName: 'home_generation_submit', arguments: {}, summary: 'Paid', expiresAt: Date.now() + 1000, impact: { effect: 'external-submit', title: 'paid', summary: 'Paid', affectedNodeCount: 1, affectedEdgeCount: 0, externalSideEffect: true } }] });
    const service = createScopedAgentSession({ scope: 'home' });
    await service.send({ message: 'generate', model, executionMode: 'auto' });
    expect(service.getSnapshot().status).toBe('awaiting-approval');
    await expect(service.resolveApproval({ approvalId: 'wrong', approve: true, model })).rejects.toThrow(/失效/);
    expect(controller.resolve).not.toHaveBeenCalled();
    service.stop();
    expect(controller.cancel).toHaveBeenCalledWith('run');
    expect(service.getSnapshot().approvals).toEqual([]);
  });
});
