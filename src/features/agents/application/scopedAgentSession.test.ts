import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatCatalogEntry } from '@/features/canvas/application/chatModelCatalog';
import type { CanvasAgentTurnResult } from '@/features/canvas/agent/application/canvasAgentController';
import { createScopedAgentSession, getScopedAgentSession } from './scopedAgentSession';
import { redactAgentRunError } from '@/features/canvas/agent/application/agentFailurePolicy';

const controller = vi.hoisted(() => ({ run: vi.fn(), resolve: vi.fn(), cancel: vi.fn(), session: vi.fn(), messages: vi.fn(() => []), pending: vi.fn(() => []), list: vi.fn(() => []), refreshMedia: vi.fn(async () => []) }));
vi.mock('@/features/canvas/agent/application/canvasAgentController', () => ({
  runCanvasAgentTurn: controller.run, resolveCanvasAgentApproval: controller.resolve, cancelCanvasAgentRun: controller.cancel,
  getCanvasAgentSession: controller.session, getCanvasAgentSessionMessages: controller.messages,
  listPendingCanvasAgentApprovals: controller.pending, listCanvasAgentSessions: controller.list,
  refreshCanvasAgentSessionMedia: controller.refreshMedia,
}));
const model: ChatCatalogEntry = { id: 'model', providerId: 'p', providerLabel: 'P', modelId: 'm', modelLabel: 'M', supportsMultimodal: true, supportsTools: true, supportsStreaming: true, supportsReasoningSummary: false, supportsToolSearch: false, agentProtocol: 'openai-chat-completions', usable: true };
const result: CanvasAgentTurnResult = { runId: 'run', sessionId: 'session', finalText: 'Done', approvals: [], status: 'completed', skillSelection: { skillIds: [], reason: '', estimatedTokens: 0, toolCount: 0, mode: 'minimal', deferredToolCount: 0 } };

beforeEach(() => { vi.clearAllMocks(); controller.run.mockResolvedValue(result); });

describe('generic scoped Agent session service', () => {
  it('retains storage failure identity while keeping the display error a string, and clears it for a new turn', async () => {
    controller.run.mockRejectedValueOnce(redactAgentRunError({ name: 'QuotaExceededError', message: 'The quota has been exceeded.' }));
    const service = createScopedAgentSession({ scope: 'home' });
    await expect(service.send({ message: 'hello', model })).rejects.toThrow('The quota has been exceeded.');
    expect(service.getSnapshot()).toMatchObject({ error: 'The quota has been exceeded.', failure: { kind: 'local-storage' } });
    service.newSession();
    expect(service.getSnapshot().failure).toBeUndefined();
    await service.send({ message: 'Try after clearing storage.', model });
    expect(service.getSnapshot().failure).toBeUndefined();
    expect(service.getSnapshot().error).toBeUndefined();
  });
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

  it('keeps sent attachment thumbnails visible while the model is working without passing view fields to persistence', async () => {
    let finish: ((value: CanvasAgentTurnResult) => void) | undefined;
    controller.run.mockImplementationOnce(() => new Promise<CanvasAgentTurnResult>((resolve) => { finish = resolve; }));
    const service = createScopedAgentSession({ scope: 'home' });
    const media = { assetId: 'uploaded-image', title: 'Picture', origin: 'upload' as const, source: 'data:image/png;base64,AAAA' };
    const pending = service.send({ message: 'Describe this', model, media: [media] });
    expect(service.getSnapshot().messages.at(-1)?.mediaReferences).toEqual([expect.objectContaining({
      assetId: media.assetId, title: media.title, availability: 'available', previewSource: media.source,
    })]);
    expect(controller.run.mock.lastCall?.[0].media).toEqual([media]);
    expect(controller.run.mock.lastCall?.[0].media[0]).not.toHaveProperty('previewSource');
    finish?.(result);
    await pending;
  });

  it('refreshes durable attachment availability after reopening without overwriting a switched conversation', async () => {
    const service = createScopedAgentSession({ scope: 'home' });
    controller.session.mockReturnValue({ projectId: 'home', scope: 'home' });
    let finishRestore: (() => void) | undefined;
    controller.refreshMedia.mockImplementationOnce(() => new Promise<never[]>((resolve) => { finishRestore = () => resolve([]); }));
    const listener = vi.fn();
    service.subscribe(listener);
    service.loadSession('with-images');
    expect(controller.refreshMedia).toHaveBeenCalledWith('with-images');
    service.newSession();
    const notifications = listener.mock.calls.length;
    finishRestore?.();
    await Promise.resolve();
    expect(service.getSnapshot().sessionId).toBeUndefined();
    expect(listener).toHaveBeenCalledTimes(notifications);

    service.loadSession('with-images');
    const beforeRefresh = listener.mock.calls.length;
    await Promise.resolve();
    expect(listener).toHaveBeenCalledTimes(beforeRefresh + 1);
    expect(service.getSnapshot().sessionId).toBe('with-images');
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

  it('publishes the deadline explanation and clears approvals while the user is reviewing them', async () => {
    controller.run.mockResolvedValueOnce({ ...result, status: 'awaiting-approval', approvals: [{ id: 'review', toolName: 'canvas_open_plan', arguments: {}, summary: 'Review', expiresAt: Date.now() + 600000, impact: { effect: 'canvas-write', title: 'review', summary: 'Review', affectedNodeCount: 1, affectedEdgeCount: 0, externalSideEffect: false } }] });
    const service = createScopedAgentSession({ scope: 'home' });
    await service.send({ message: 'plan', model });
    const callback = controller.run.mock.calls[0][0].onTurnStopped as (error: Error) => void;
    callback(new Error('本回合已达到 10 分钟总时限，已安全停止。'));
    expect(service.getSnapshot()).toMatchObject({ status: 'error', approvals: [], error: expect.stringMatching(/10 分钟.*停止/) });
    await expect(service.resolveApproval({ approvalId: 'review', approve: true, model })).rejects.toThrow(/失效/);
  });
});
