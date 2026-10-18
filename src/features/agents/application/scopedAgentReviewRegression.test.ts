import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareAgentCanvasPlan, resolveAgentCanvasPlan } from './agentCanvasPlanRepository';
import { stageAgentTools } from './stageAgentTools';
import { stageCommands } from '@/features/stage/application/stageCommands';
import { resolveAsset } from '@/features/assets/application/assetCatalog';
import { canvasAgentApprovalStore, createAgentRequestFingerprint } from '@/features/canvas/agent/application/agentApproval';
import { prepareCanvasAgentToolApproval, restorePreparedCanvasAgentApprovals, listPendingCanvasAgentApprovals } from '@/features/canvas/agent/application/canvasAgentController';
import { AgentSessionRepository } from '@/features/canvas/agent/infrastructure/agentSessionRepository';

vi.mock('@/features/workbench/application/workspaceDocument', () => ({
  createWorkspaceDocument: (_key: string, initial: () => unknown) => {
    let state = initial();
    return { initialize: async () => {}, load: () => state, save: (next: unknown) => { state = next; }, flush: async () => {} };
  },
}));
vi.mock('@/features/assets/application/assetCatalog', () => ({ resolveAsset: vi.fn(), listAssets: vi.fn(), getAssetPortableSource: vi.fn() }));

beforeEach(() => { vi.restoreAllMocks(); vi.mocked(resolveAsset).mockReset(); });

describe('scoped Agent review regressions', () => {
  it('keeps full scripts/prompts behind a plan id despite redacted audit metadata', async () => {
    const context = { projectId: 'home', runId: 'long-plan' };
    const plan = { title: 'Long plan', script: '剧本'.repeat(5000), shots: [{ title: 'Shot', prompt: '场景'.repeat(4000), modelId: 'model', aspectRatio: '16:9', resolution: '2K' }] };
    const prepared = await prepareAgentCanvasPlan(plan, context);
    expect(prepared).not.toHaveProperty('plan');
    expect(prepared.scriptCharacters).toBe(plan.script.length);
    expect(await resolveAgentCanvasPlan(prepared.planId, context)).toEqual(plan);
    await expect(resolveAgentCanvasPlan(prepared.planId, { ...context, runId: 'another-run' })).rejects.toThrow(/不属于/);
  });

  it('qualifies canvas capture ids so asset_view can resolve them', async () => {
    vi.spyOn(stageCommands, 'capture').mockResolvedValue({ nodeId: 'stage', assetId: 'capture:image' });
    vi.mocked(resolveAsset).mockImplementation(async (id) => id === 'project:p:capture:image'
      ? { id, kind: 'image', source: 'asset-media:captured', name: 'Capture', origin: 'canvas', createdAt: 1, favorite: false, metadata: {} }
      : null);
    const tool = stageAgentTools.find((candidate) => candidate.name === 'stage_capture');
    const result = await tool?.execute({ nodeId: 'stage' }, { projectId: 'p', runId: 'r' });
    expect(result).toEqual({ nodeId: 'stage', assetId: 'project:p:capture:image' });
    expect(resolveAsset).toHaveBeenCalledWith('project:p:capture:image');
  });

  it('reuses original fingerprints after display redaction rather than preparing a second time', async () => {
    const args = { kind: 'image', model: 'model', prompt: '场景'.repeat(4000), config: { size: null, aspectRatio: '16:9', seconds: null } };
    const prepared = await prepareCanvasAgentToolApproval({ projectId: 'home', runId: 'original-binding', scope: 'home', callId: 'call', toolName: 'home_generation_submit', arguments: args });
    const fingerprint = await createAgentRequestFingerprint('home_generation_submit', args);
    expect(prepared.view.arguments).not.toEqual(args);
    const restored = restorePreparedCanvasAgentApprovals('original-binding', [prepared.view]);
    expect(restored[0].record.requestFingerprint).toBe(fingerprint);
    expect(canvasAgentApprovalStore.get(prepared.record.id)?.status).toBe('awaiting-approval');
  });

  it('defaults project-wide restoration to canvas but derives stage for a selected session', async () => {
    const prepared = await prepareCanvasAgentToolApproval({ projectId: 'review-p', runId: 'review-stage-run', scope: 'stage', callId: 'call', toolName: 'stage_query', arguments: { nodeId: null } });
    vi.spyOn(AgentSessionRepository.prototype, 'getRunState').mockImplementation((id) => id === prepared.record.runId ? {
      id, projectId: 'review-p', sessionId: 'stage-session', status: 'awaiting_approval', runtimeVersion: 1, agentDefinitionVersion: 1, commandSchemaVersion: 1, serializedState: '{}', createdAt: Date.now(), updatedAt: Date.now(),
    } : null);
    vi.spyOn(AgentSessionRepository.prototype, 'getSession').mockImplementation((id) => id === 'stage-session' ? {
      id, projectId: 'review-p', scope: 'stage', title: 'Stage', modelRef: 'm', createdAt: Date.now(), updatedAt: Date.now(), items: [], appliedTransactions: {},
    } : null);
    expect(listPendingCanvasAgentApprovals('review-p')).toEqual([]);
    expect(listPendingCanvasAgentApprovals('review-p', 'stage-session')).toHaveLength(1);
    expect(listPendingCanvasAgentApprovals('review-p', undefined, 'stage')).toHaveLength(1);
  });
});
