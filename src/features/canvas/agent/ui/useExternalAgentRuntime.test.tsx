// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCanvasStore } from '@/stores/canvasStore';
import { useProjectStore } from '@/stores/projectStore';
import { canvasAgentApprovalStore, createApprovalId } from '@/features/canvas/agent/application/agentApproval';
import { canvasAgentBudgetLedger } from '@/features/canvas/agent/application/agentBudget';
import * as bridge from '@/features/canvas/agent/application/externalAgentCanvasBridge';
import * as mediaAdapter from '@/features/canvas/agent/application/externalAgentMediaAdapter';
import type { AgentTurnMediaInput, ExternalAgentEventV1, ExternalAgentRuntimeId, ExternalAgentToolRequest } from '@/features/canvas/agent/domain/agentModel';
import { useCanvasAgentPanelStore, type AgentFeedItem } from '@/features/canvas/agent/ui/agentPanelStore';
import { useExternalAgentRuntime } from '@/features/canvas/agent/ui/useExternalAgentRuntime';
import type * as ExternalAgentCommands from '@/commands/externalAgent';
import * as assetStorage from '@/features/assets/application/assetMediaStorage';
import { buildCanvasAssetCatalog } from '@/features/canvas/application/canvasAssetCatalog';
import type * as ExternalAgentAdapter from '@/features/canvas/agent/application/externalAgentEventAdapter';

const native = vi.hoisted(() => ({
  listener: null as ((event: ExternalAgentEventV1) => void) | null,
  diagnose: vi.fn(), start: vi.fn(), send: vi.fn(), cancel: vi.fn(), resolve: vi.fn(),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/commands/externalAgent', async (importOriginal) => ({
  ...await importOriginal<typeof ExternalAgentCommands>(),
  diagnoseExternalAgentRuntimes: native.diagnose,
  startExternalAgentSession: native.start,
  sendExternalAgentTurn: native.send,
  cancelExternalAgentSession: native.cancel,
  resolveExternalAgentToolCall: native.resolve,
}));
vi.mock('@/features/canvas/agent/application/externalAgentEventAdapter', async (importOriginal) => ({
  ...await importOriginal<typeof ExternalAgentAdapter>(),
  listenNormalizedExternalAgentEvents: async (listener: (event: ExternalAgentEventV1) => void) => {
    native.listener = listener;
    return () => { if (native.listener === listener) native.listener = null; };
  },
}));

const projectId = 'external-hook-project';
const sessionId = 'external-hook-session';
const turnId = 'external-hook-turn';
const request: ExternalAgentToolRequest = {
  version: 1, runtime: 'codex', sessionId, turnId, callId: 'create', toolName: 'canvas_command',
  arguments: { type: 'node.create', input: { nodeType: 'imageNode', position: { x: 20, y: 30 }, configuration: { prompt: 'Approved image' } } },
};
const approvalId = createApprovalId(turnId, request.toolName, request.callId);
let api: ReturnType<typeof useExternalAgentRuntime> | null = null;
let root: Root | null = null;
let container: HTMLDivElement;
const releases: (() => void)[] = [];
let observedRunning = false;
const resetAttachments = vi.fn();
const finishStreaming = vi.fn();
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
function gate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => { release = resolve; });
  releases.push(release);
  return { promise, release };
}
function currentApi() { if (!api) throw new Error('Hook is not mounted'); return api; }
interface HarnessProps {
  runtime?: ExternalAgentRuntimeId;
  ownerProjectId?: string;
  enabled?: boolean;
  attachments?: AgentTurnMediaInput[];
}
function Harness({ runtime = 'codex', ownerProjectId = projectId, enabled = true, attachments = [] }: HarnessProps) {
  const [running, setRunning] = useState(false);
  const feed = useCanvasAgentPanelStore((state) => state.feed);
  const selectedSession = useCanvasAgentPanelStore((state) => state.externalSessions[ownerProjectId]?.[runtime] ?? null);
  observedRunning = running;
  api = useExternalAgentRuntime({
    enabled, projectId: ownerProjectId, selectedRuntimeId: runtime, selectedSession, attachments,
    projectContext: { brief: '', pinnedNodeIds: [], updatedAt: 0 },
    isRunning: running, pendingCount: feed.filter((item) => item.kind === 'approval' && item.status === 'pending').length,
    setRunning, resetAttachments,
    pushFeed: useCanvasAgentPanelStore.getState().addFeedItem,
    updateFeedItem: useCanvasAgentPanelStore.getState().updateFeedItem,
    updateStreamingMessage: () => {}, updateStreamingReasoning: () => {}, updateStreamingPlan: () => {},
    resetStreaming: () => {}, finishStreaming, handleToolEvent: () => {},
  });
  return <ul>{feed.map((item) => <li key={item.id} data-kind={item.kind}>{item.kind === 'approval' ? item.status : item.kind}</li>)}</ul>;
}
async function emit(event: ExternalAgentEventV1) {
  await act(async () => { if (!native.listener) throw new Error('No runtime listener'); native.listener(event); });
}
function approval(callId = request.callId): Extract<AgentFeedItem, { kind: 'approval' }> {
  const item = useCanvasAgentPanelStore.getState().feed.find((entry) => entry.kind === 'approval' && entry.approvalId === callId);
  if (item?.kind !== 'approval') throw new Error('No approval card');
  return item;
}
async function beginRequest() {
  await act(async () => { await currentApi().executeTurn('Create one image node', 'codex', { explicitSkillIds: [], media: [] }); });
  await emit({ version: 1, kind: 'tool_requested', runtime: 'codex', sessionId, turnId, request });
}
/** Preparation is real asynchronous work; wait for the visible card instead of a fixed number of turns. */
async function beginVisibleRequest() {
  await beginRequest();
  await act(async () => { await vi.waitFor(() => approval()); });
}
async function renderHarness(props: HarnessProps) {
  await act(async () => { root?.render(<Harness {...props} />); });
}
async function beginConcurrentRequests() {
  await beginVisibleRequest();
  const second = { ...request, callId: 'create-second' };
  await emit({ version: 1, kind: 'tool_requested', runtime: 'codex', sessionId, turnId, request: second });
  await act(async () => { await vi.waitFor(() => approval(second.callId)); });
  return second;
}
async function invalidateHarness(ending: 'unmount' | 'runtime change' | 'project change' | 'disable') {
  if (ending === 'unmount') await act(async () => { root?.unmount(); root = null; });
  else if (ending === 'runtime change') await renderHarness({ runtime: 'claude' });
  else if (ending === 'project change') {
    useProjectStore.setState({ currentProjectId: 'other-project' });
    await renderHarness({ ownerProjectId: 'other-project' });
  } else await renderHarness({ enabled: false });
}

beforeEach(async () => {
  vi.clearAllMocks();
  native.listener = null;
  observedRunning = false;
  native.diagnose.mockResolvedValue(['codex', 'claude'].map(runtime => ({ runtime, status: 'ready', version: 'fixture', executableName: 'local-fixture' })));
  native.start.mockResolvedValue({ sessionId, runtime: 'codex', providerSessionId: null });
  native.send.mockImplementation(async (input: ExternalAgentCommands.ExternalAgentTurnRequest) => ({
    sessionId: input.sessionId, turnId, accepted: true,
  }));
  native.cancel.mockResolvedValue(undefined); native.resolve.mockResolvedValue(undefined);
  canvasAgentApprovalStore.deleteRun(turnId);
  canvasAgentBudgetLedger.reset(projectId); canvasAgentBudgetLedger.setLimit(projectId, null);
  useProjectStore.setState({ currentProjectId: projectId });
  vi.spyOn(useProjectStore.getState(), 'saveCurrentProject').mockImplementation(() => undefined);
  vi.spyOn(useProjectStore.getState(), 'waitForProjectPersistence').mockResolvedValue(undefined);
  useCanvasStore.setState({ nodes: [], edges: [], selectedNodeId: null, revision: 0, history: { past: [], future: [] } });
  useCanvasAgentPanelStore.setState({ feed: [], externalSessions: {} });
  container = document.createElement('div'); document.body.append(container);
  root = createRoot(container);
  await act(async () => { root?.render(<Harness />); });
  expect(currentApi().diagnostics.codex?.availability).toBe('ready');
});
afterEach(async () => {
  await act(async () => { root?.unmount(); root = null; for (const release of releases.splice(0)) release(); });
  container.remove(); api = null; vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe('external runtime approval lifecycle', () => {
  it('fails closed on an unavailable explicitly selected skill, even if a provider requests a canvas edit', async () => {
    await act(async () => { await currentApi().executeTurn('Create one image node', 'codex', { explicitSkillIds: ['deleted-user-skill'], media: [] }); });
    await emit({ version: 1, kind: 'tool_requested', runtime: 'codex', sessionId, turnId, request });
    await act(async () => { await vi.waitFor(() => expect(native.resolve).toHaveBeenCalled()); });
    expect(native.resolve).toHaveBeenCalledWith(expect.objectContaining({ resolution: expect.objectContaining({ outcome: 'error' }) }));
    expect(useCanvasAgentPanelStore.getState().feed.some(item => item.kind === 'approval')).toBe(false);
    expect(canvasAgentApprovalStore.get(approvalId)).toBeUndefined();
    expect(useCanvasStore.getState()).toMatchObject({ nodes: [], revision: 0, history: { past: [] } });
    expect(canvasAgentBudgetLedger.get(projectId).reservations).toEqual({});
  });

  for (const ending of ['cancelled', 'completed', 'unmount'] as const) {
    it(`never publishes late preparation after ${ending}, and revokes its durable authority`, async () => {
      const paused = gate();
      const prepared = gate();
      const prepare = bridge.prepareExternalAgentToolRequest;
      vi.spyOn(bridge, 'prepareExternalAgentToolRequest').mockImplementation(async (input) => {
        const view = await prepare(input); prepared.release(); await paused.promise; return view;
      });
      await beginRequest();
      await act(async () => { await prepared.promise; });
      expect(canvasAgentApprovalStore.get(approvalId)?.status).toBe('awaiting-approval');
      expect(container.querySelector('[data-kind="approval"]')).toBeNull();
      if (ending === 'unmount') await act(async () => { root?.unmount(); root = null; });
      else await emit({ version: 1, kind: ending, runtime: 'codex', sessionId, turnId });
      await act(async () => { paused.release(); });
      expect(canvasAgentApprovalStore.get(approvalId)?.status).toBe('cancelled');
      expect(useCanvasAgentPanelStore.getState().feed.filter((item) => item.kind === 'approval')).toEqual([]);
      const late = await bridge.resolveExternalAgentToolApproval({ projectId, request, approve: true });
      expect(late.status).toBe('error');
      expect(useCanvasStore.getState()).toMatchObject({ nodes: [], revision: 0, history: { past: [] } });
      expect(canvasAgentBudgetLedger.get(projectId).reservations).toEqual({});
    });
  }

  it('expires a visible pending card on completion; a stale approve cannot edit the canvas', async () => {
    await beginVisibleRequest();
    const pending = approval();
    expect(pending.status).toBe('pending');
    await emit({ version: 1, kind: 'completed', runtime: 'codex', sessionId, turnId });
    expect(approval().status).toBe('expired');
    await act(async () => { await currentApi().resolveApproval(pending, true); });
    expect(approval().status).toBe('expired');
    expect(canvasAgentApprovalStore.get(approvalId)?.status).toBe('cancelled');
    expect(useCanvasStore.getState()).toMatchObject({ nodes: [], revision: 0 });
  });

  it('preserves the real terminal result when stop overlaps an already-applied operation', async () => {
    await beginVisibleRequest();
    const delivery = gate(); native.resolve.mockImplementation(() => delivery.promise);
    let resolving: Promise<boolean> | undefined;
    await act(async () => {
      resolving = currentApi().resolveApproval(approval(), true);
      // Stop only after the graph operation actually committed; persistence/receipt work is asynchronous.
      await vi.waitFor(() => expect(canvasAgentApprovalStore.get(approvalId)?.status).toBe('succeeded'));
    });
    expect(useCanvasStore.getState().nodes.map((node) => node.data.prompt)).toEqual(['Approved image']);
    expect(approval().status).toBe('approving');
    expect(canvasAgentApprovalStore.get(approvalId)?.status).toBe('succeeded');
    const revision = useCanvasStore.getState().revision;
    await emit({ version: 1, kind: 'cancelled', runtime: 'codex', sessionId, turnId });
    expect(approval().status).toBe('approving');
    await act(async () => { delivery.release(); await resolving; });
    expect(approval().status).toBe('approved');
    expect(canvasAgentApprovalStore.get(approvalId)?.status).toBe('succeeded');
    expect(useCanvasStore.getState().revision).toBe(revision);
    expect(useCanvasStore.getState().history.past).toHaveLength(1);
    expect(canvasAgentBudgetLedger.get(projectId).reservations).toEqual({});
  });
});

describe('concurrent external approvals', () => {
  for (const firstResult of ['approved', 'failed'] as const) {
    it(`keeps the other pending approval actionable after an individual ${firstResult} result`, async () => {
      const second = await beginConcurrentRequests();
      if (firstResult === 'failed') useCanvasStore.setState({ revision: 1 });
      await act(async () => { await currentApi().resolveApproval(approval(), true); });
      expect(approval().status).toBe(firstResult);
      expect(approval(second.callId).status).toBe('pending');
      expect(observedRunning).toBe(false);
      await act(async () => { await currentApi().resolveApproval(approval(second.callId), false); });
      expect(approval(second.callId).status).toBe('rejected');
      expect(native.resolve).toHaveBeenCalledTimes(2);
      expect(canvasAgentApprovalStore.get(createApprovalId(turnId, second.toolName, second.callId))?.status).toBe('rejected');
      expect(useCanvasStore.getState().nodes).toHaveLength(firstResult === 'approved' ? 1 : 0);
      expect(canvasAgentBudgetLedger.get(projectId).reservations).toEqual({});
    });
  }

  it('claims each callback once and does not revive running after a provider terminal event', async () => {
    const second = await beginConcurrentRequests();
    const firstCard = approval();
    const secondCard = approval(second.callId);
    const firstDelivery = gate();
    const secondDelivery = gate();
    native.resolve.mockImplementation((input: Parameters<typeof ExternalAgentCommands.resolveExternalAgentToolCall>[0]) => (
      input.callId === request.callId ? firstDelivery.promise : secondDelivery.promise
    ));
    const resolve = vi.spyOn(bridge, 'resolveExternalAgentToolApproval');
    let first: Promise<boolean> | undefined;
    let duplicate: Promise<boolean> | undefined;
    let remaining: Promise<boolean> | undefined;
    await act(async () => {
      first = currentApi().resolveApproval(firstCard, true);
      duplicate = currentApi().resolveApproval(firstCard, true);
      remaining = currentApi().resolveApproval(secondCard, false);
      await vi.waitFor(() => expect(native.resolve).toHaveBeenCalledTimes(2));
    });
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(approval().status).toBe('approving');
    expect(approval(second.callId).status).toBe('rejecting');
    await emit({ version: 1, kind: 'completed', runtime: 'codex', sessionId, turnId });
    await act(async () => { secondDelivery.release(); await remaining; });
    expect(observedRunning).toBe(false);
    await act(async () => { firstDelivery.release(); await Promise.all([first, duplicate]); });
    expect(observedRunning).toBe(false);
    expect(approval().status).toBe('approved');
    expect(approval(second.callId).status).toBe('rejected');
    expect(native.resolve).toHaveBeenCalledTimes(2);
    expect(useCanvasStore.getState()).toMatchObject({ revision: 1 });
    expect(useCanvasStore.getState().nodes).toHaveLength(1);
    expect(useCanvasStore.getState().history.past).toHaveLength(1);
    expect(canvasAgentApprovalStore.get(approvalId)?.status).toBe('succeeded');
  });

  it('preserves a claimed approval when provider completion precedes its execution', async () => {
    await beginVisibleRequest();
    const execution = gate();
    const resolve = bridge.resolveExternalAgentToolApproval;
    vi.spyOn(bridge, 'resolveExternalAgentToolApproval').mockImplementation(async (input) => {
      await execution.promise;
      return resolve(input);
    });
    let resolving: Promise<boolean> | undefined;
    await act(async () => { resolving = currentApi().resolveApproval(approval(), true); });
    await emit({ version: 1, kind: 'completed', runtime: 'codex', sessionId, turnId });
    expect(canvasAgentApprovalStore.get(approvalId)?.status).toBe('awaiting-approval');
    await act(async () => { execution.release(); await resolving; });
    expect(approval().status).toBe('approved');
    expect(canvasAgentApprovalStore.get(approvalId)?.status).toBe('succeeded');
    expect(useCanvasStore.getState().nodes).toHaveLength(1);
    expect(observedRunning).toBe(false);
  });
});

describe('external local media execution cancellation', () => {
  it('aborts a claimed media edit on Stop before native cancellation acknowledges and releases the late bitmap', async () => {
    useCanvasStore.setState({ nodes: [{ id: 'source', type: 'uploadNode', position: { x: 0, y: 0 },
      data: { imageUrl: 'data:image/png;base64,AQID', aspectRatio: '2:1' } }] });
    const mediaRequest: ExternalAgentToolRequest = { ...request,
      arguments: { type: 'node.media.edit', input: { nodeId: 'source', operation: { kind: 'image.transform', rotate: 90 } } } };
    const started = gate();
    const decoding = gate();
    const cancellation = gate();
    const close = vi.fn();
    vi.stubGlobal('createImageBitmap', async () => {
      started.release();
      await decoding.promise;
      return { width: 2, height: 1, close };
    });
    vi.stubGlobal('OffscreenCanvas', class {
      constructor(public width: number, public height: number) {}
      getContext() { return { translate() {}, scale() {}, rotate() {}, drawImage() {} }; }
      async convertToBlob() { return new Blob(['encoded'], { type: 'image/png' }); }
    });
    const persistAsset = vi.spyOn(assetStorage, 'persistAssetMedia').mockResolvedValue(`asset-media:${'a'.repeat(64)}.png`);
    const save = vi.mocked(useProjectStore.getState().saveCurrentProject);
    native.cancel.mockReturnValue(cancellation.promise);
    await act(async () => { await currentApi().executeTurn('Edit the canvas image', 'codex', { explicitSkillIds: [], media: [] }); });
    await emit({ version: 1, kind: 'tool_requested', runtime: 'codex', sessionId, turnId, request: mediaRequest });
    await act(async () => { await vi.waitFor(() => approval()); });
    const before = useCanvasStore.getState();
    const assets = buildCanvasAssetCatalog(before.nodes);
    let resolving: Promise<boolean> | undefined;
    let stopping: Promise<void> | undefined;
    let settled = false;
    await act(async () => {
      resolving = currentApi().resolveApproval(approval(), true);
      void resolving.then(() => { settled = true; });
      await started.promise;
    });
    try {
      await act(async () => {
        stopping = currentApi().cancelTurn();
        await vi.waitFor(() => expect(settled).toBe(true), { timeout: 300, interval: 5 });
      });
      expect(native.cancel).toHaveBeenCalledWith(sessionId);
      expect(approval().status).toBe('failed');
      expect(canvasAgentApprovalStore.get(approvalId)?.status).toBe('failed');
      expect(canvasAgentBudgetLedger.get(projectId).reservations).toEqual({});
    } finally {
      await act(async () => { decoding.release(); cancellation.release(); await resolving; await stopping; });
    }
    expect(close).toHaveBeenCalledOnce();
    expect(buildCanvasAssetCatalog(useCanvasStore.getState().nodes)).toEqual(assets);
    expect(useCanvasStore.getState().nodes).toBe(before.nodes);
    expect(useCanvasStore.getState().edges).toBe(before.edges);
    expect(useCanvasStore.getState().history).toBe(before.history);
    expect(useCanvasStore.getState().revision).toBe(before.revision);
    expect(persistAsset).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });
});

describe('external turn startup ownership', () => {
  for (const ending of ['unmount', 'runtime change', 'project change', 'disable'] as const) {
    it(`cancels a late-created session after ${ending} without sending or publishing`, async () => {
      const startup = gate();
      native.start.mockImplementation(async () => {
        await startup.promise;
        return { sessionId, runtime: 'codex', providerSessionId: null };
      });
      let turn: Promise<string[] | null> | undefined;
      await act(async () => { turn = currentApi().executeTurn('Create one image node', 'codex', { explicitSkillIds: [], media: [] }); });
      expect(native.start).toHaveBeenCalledTimes(1);
      await invalidateHarness(ending);
      const feed = useCanvasAgentPanelStore.getState().feed;
      const sessions = useCanvasAgentPanelStore.getState().externalSessions;
      const finished = finishStreaming.mock.calls.length;
      await act(async () => { startup.release(); await turn; });
      expect(native.cancel).toHaveBeenCalledWith(sessionId);
      expect(native.send).not.toHaveBeenCalled();
      expect(useCanvasAgentPanelStore.getState().feed).toBe(feed);
      expect(useCanvasAgentPanelStore.getState().externalSessions).toBe(sessions);
      expect(resetAttachments).not.toHaveBeenCalled();
      expect(finishStreaming).toHaveBeenCalledTimes(finished);
    });

    it(`abandons late attachment preparation after ${ending} before creating a session`, async () => {
      const preparation = gate();
      vi.spyOn(mediaAdapter, 'buildExternalAgentAttachments').mockImplementation(async () => {
        await preparation.promise;
        return [];
      });
      let turn: Promise<string[] | null> | undefined;
      await act(async () => {
        turn = currentApi().executeTurn('Create one image node', 'codex', {
          explicitSkillIds: [],
          media: [{ assetId: 'upload', title: 'Reference', origin: 'upload', source: 'data:image/png;base64,AA==' }],
        });
      });
      expect(mediaAdapter.buildExternalAgentAttachments).toHaveBeenCalledTimes(1);
      await invalidateHarness(ending);
      const feed = useCanvasAgentPanelStore.getState().feed;
      await act(async () => { preparation.release(); await turn; });
      expect(native.start).not.toHaveBeenCalled();
      expect(native.send).not.toHaveBeenCalled();
      expect(useCanvasAgentPanelStore.getState().feed).toBe(feed);
      expect(resetAttachments).not.toHaveBeenCalled();
    });
  }

  it('ignores an old startup rejection while a newer runtime turn owns the panel', async () => {
    const startup = gate();
    native.start.mockImplementationOnce(async () => { await startup.promise; throw new Error('Old startup failed'); });
    let oldTurn: Promise<string[] | null> | undefined;
    await act(async () => { oldTurn = currentApi().executeTurn('Create one image node', 'codex', { explicitSkillIds: [], media: [] }); });
    await renderHarness({ runtime: 'claude' });
    native.start.mockResolvedValue({ sessionId: 'new-session', runtime: 'claude', providerSessionId: null });
    await act(async () => { await currentApi().executeTurn('Create one image node', 'claude', { explicitSkillIds: [], media: [] }); });
    expect(native.send).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'new-session' }));
    const feed = useCanvasAgentPanelStore.getState().feed;
    const finished = finishStreaming.mock.calls.length;
    await act(async () => { startup.release(); await oldTurn; });
    expect(observedRunning).toBe(true);
    expect(useCanvasAgentPanelStore.getState().feed).toBe(feed);
    expect(useCanvasAgentPanelStore.getState().externalSessions[projectId]?.claude?.sessionId).toBe('new-session');
    expect(finishStreaming).toHaveBeenCalledTimes(finished);
  });

  for (const result of ['accepted', 'rejected'] as const) {
    it(`ignores a late ${result} send result after runtime ownership changes`, async () => {
      const delivery = gate();
      native.send.mockImplementationOnce(async () => {
        await delivery.promise;
        if (result === 'rejected') throw new Error('Old delivery failed');
        return { sessionId, turnId, accepted: true };
      });
      let oldTurn: Promise<string[] | null> | undefined;
      await act(async () => { oldTurn = currentApi().executeTurn('Create one image node', 'codex', { explicitSkillIds: [], media: [] }); });
      await renderHarness({ runtime: 'claude' });
      native.start.mockResolvedValue({ sessionId: 'new-session', runtime: 'claude', providerSessionId: null });
      await act(async () => { await currentApi().executeTurn('Create one image node', 'claude', { explicitSkillIds: [], media: [] }); });
      const feed = useCanvasAgentPanelStore.getState().feed;
      const resets = resetAttachments.mock.calls.length;
      const finished = finishStreaming.mock.calls.length;
      await act(async () => { delivery.release(); await oldTurn; });
      expect(observedRunning).toBe(true);
      expect(useCanvasAgentPanelStore.getState().feed).toBe(feed);
      expect(resetAttachments).toHaveBeenCalledTimes(resets);
      expect(finishStreaming).toHaveBeenCalledTimes(finished);
    });
  }
});

describe('external conversation skill routing', () => {
  it('retains canvas tools and the live session for short accepted continuations', async () => {
    let initialSelection: string[] | null = null;
    for (const [index, message] of ['帮我生成图片吧', '继续', 'continue', '16:9，2K'].entries()) {
      await act(async () => {
        const selected = await currentApi().executeTurn(message, 'codex', { explicitSkillIds: [], media: [] });
        if (index === 0) { initialSelection = selected; expect(selected?.length).toBeGreaterThan(0); }
        else expect(selected).toEqual(initialSelection);
      });
      expect(native.send).toHaveBeenCalledTimes(index + 1);
      await emit({ version: 1, kind: 'completed', runtime: 'codex', sessionId, turnId });
    }
    expect(native.start).toHaveBeenCalledTimes(1);
    expect(native.start).toHaveBeenCalledWith(expect.objectContaining({ tools: expect.arrayContaining([expect.objectContaining({ name: 'node.create' })]) }));
    expect(native.cancel).not.toHaveBeenCalled();
  });

  it('ignores a terminal event from an older turn on the reused live session', async () => {
    native.send.mockResolvedValueOnce({ sessionId, turnId: 'older-turn', accepted: true });
    await act(async () => { await currentApi().executeTurn('帮我生成图片吧', 'codex', { explicitSkillIds: [], media: [] }); });
    await emit({ version: 1, kind: 'completed', runtime: 'codex', sessionId, turnId: 'older-turn' });
    native.send.mockResolvedValueOnce({ sessionId, turnId: 'newer-turn', accepted: true });
    await act(async () => { await currentApi().executeTurn('继续', 'codex', { explicitSkillIds: [], media: [] }); });
    const feed = useCanvasAgentPanelStore.getState().feed;
    const finished = finishStreaming.mock.calls.length;
    await emit({ version: 1, kind: 'completed', runtime: 'codex', sessionId, turnId: 'older-turn' });
    expect(observedRunning).toBe(true);
    expect(useCanvasAgentPanelStore.getState().feed).toBe(feed);
    expect(finishStreaming).toHaveBeenCalledTimes(finished);
    expect(native.start).toHaveBeenCalledTimes(1);
  });

  it('does not promote a failed user send into continuation tool authority', async () => {
    native.send.mockRejectedValueOnce(new Error('Turn was not accepted'));
    await act(async () => { await currentApi().executeTurn('帮我生成图片吧', 'codex', { explicitSkillIds: [], media: [] }); });
    native.start.mockResolvedValue({ sessionId: 'next-session', runtime: 'codex', providerSessionId: null });
    await act(async () => { await currentApi().executeTurn('继续', 'codex', { explicitSkillIds: [], media: [] }); });
    expect(native.start).toHaveBeenLastCalledWith(expect.objectContaining({ tools: [] }));
  });

  it('does not use provider prose as continuation tool authority', async () => {
    await act(async () => { await currentApi().executeTurn('你好', 'codex', { explicitSkillIds: [], media: [] }); });
    await emit({ version: 1, kind: 'completed', runtime: 'codex', sessionId, turnId, finalText: '生成图片，创建画布节点' });
    await act(async () => { await currentApi().executeTurn('continue', 'codex', { explicitSkillIds: [], media: [] }); });
    expect(native.start).toHaveBeenCalledTimes(1);
    expect(native.start).toHaveBeenCalledWith(expect.objectContaining({ tools: [] }));
  });

  for (const unrelatedTask of ['诊断报错', '你好']) {
    it(`continues only the latest accepted task after switching from an image task to ${unrelatedTask}`, async () => {
      await act(async () => { await currentApi().executeTurn('帮我生成图片吧', 'codex', { explicitSkillIds: [], media: [] }); });
      await emit({ version: 1, kind: 'completed', runtime: 'codex', sessionId, turnId });
      let taskSelection: string[] | null = null;
      await act(async () => { taskSelection = await currentApi().executeTurn(unrelatedTask, 'codex', { explicitSkillIds: [], media: [] }); });
      expect(native.start).toHaveBeenCalledTimes(2);
      expect(native.start).toHaveBeenLastCalledWith(expect.objectContaining({
        tools: unrelatedTask === '诊断报错' ? [expect.objectContaining({ name: 'diagnostics' })] : [],
      }));
      await emit({ version: 1, kind: 'completed', runtime: 'codex', sessionId, turnId });
      await act(async () => {
        const selection = await currentApi().executeTurn('继续', 'codex', { explicitSkillIds: [], media: [] });
        expect(selection).toEqual(taskSelection);
      });
      expect(native.start).toHaveBeenCalledTimes(2);
      expect(native.send).toHaveBeenCalledTimes(3);
      expect(useCanvasStore.getState()).toMatchObject({ nodes: [], revision: 0 });
    });
  }

  for (const failure of ['rejected send', 'unaccepted receipt'] as const) {
    it(`preserves the accepted task context after an unrelated task receives a ${failure}`, async () => {
      let acceptedSelection: string[] | null = null;
      await act(async () => { acceptedSelection = await currentApi().executeTurn('帮我生成图片吧', 'codex', { explicitSkillIds: [], media: [] }); });
      await emit({ version: 1, kind: 'completed', runtime: 'codex', sessionId, turnId });
      if (failure === 'rejected send') native.send.mockRejectedValueOnce(new Error('Task was not accepted'));
      else native.send.mockResolvedValueOnce({ sessionId, turnId, accepted: false });
      await act(async () => { await currentApi().executeTurn('诊断报错', 'codex', { explicitSkillIds: [], media: [] }); });
      if (failure === 'unaccepted receipt') await emit({ version: 1, kind: 'completed', runtime: 'codex', sessionId, turnId });
      await act(async () => {
        const selection = await currentApi().executeTurn('继续', 'codex', { explicitSkillIds: [], media: [] });
        expect(selection).toEqual(acceptedSelection);
      });
      expect(native.start).toHaveBeenLastCalledWith(expect.objectContaining({
        tools: expect.arrayContaining([expect.objectContaining({ name: 'node.create' })]),
      }));
      expect(native.start).toHaveBeenLastCalledWith(expect.objectContaining({
        tools: expect.not.arrayContaining([expect.objectContaining({ name: 'diagnostics' })]),
      }));
    });
  }

  for (const next of ['unrelated', 'explicit-denied', 'discard', 'project', 'runtime'] as const) {
    it(`does not inherit tool authority for ${next} requests`, async () => {
      await act(async () => { await currentApi().executeTurn('帮我生成图片吧', 'codex', { explicitSkillIds: [], media: [] }); });
      await emit({ version: 1, kind: 'completed', runtime: 'codex', sessionId, turnId });
      if (next === 'discard') await act(async () => { currentApi().discardCurrentSession(); });
      if (next === 'project') await renderHarness({ ownerProjectId: 'other-project' });
      if (next === 'runtime') await renderHarness({ runtime: 'claude' });
      native.start.mockResolvedValue({ sessionId: 'next-session', runtime: next === 'runtime' ? 'claude' : 'codex', providerSessionId: null });
      await act(async () => {
        await currentApi().executeTurn(next === 'unrelated' ? '你好' : '继续', next === 'runtime' ? 'claude' : 'codex', {
          explicitSkillIds: next === 'explicit-denied' ? ['deleted-user-skill'] : [],
          media: [],
        });
      });
      expect(native.start).toHaveBeenLastCalledWith(expect.objectContaining({ tools: [] }));
    });
  }
});
