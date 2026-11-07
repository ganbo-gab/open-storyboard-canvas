import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareAgentCanvasPlan, resolveAgentCanvasPlan } from './agentCanvasPlanRepository';
import { stageAgentTools } from './stageAgentTools';
import { stageCommands } from '@/features/stage/application/stageCommands';
import { resolveAsset } from '@/features/assets/application/assetCatalog';
import { canvasAgentApprovalStore, createAgentRequestFingerprint } from '@/features/canvas/agent/application/agentApproval';
import { prepareCanvasAgentToolApproval, restorePreparedCanvasAgentApprovals, listPendingCanvasAgentApprovals } from '@/features/canvas/agent/application/canvasAgentController';
import { AgentSessionRepository } from '@/features/canvas/agent/infrastructure/agentSessionRepository';
import { RunContext } from '@openai/agents';
import { getScopedAgentTools, inspectScopedAgentTool } from './scopedAgentTools';
import { createScopedSdkTools } from './scopedAgentSdkTools';
import { useChannelStore, getChannelCredentialRef, setChannelCredential } from '@/features/channels/store/channelStore';
import { parseProfileImport } from '@/features/channels/application/channelService';
import { openAIStandardProfile } from '@/features/channels/presets/openai';
import { useMemorySecretVault } from '@/features/secrets/testSupport';
import { KnowledgeService } from '@/features/knowledge/application/knowledgeService';
import { useKnowledgeStore } from '@/features/knowledge/application/knowledgeStore';
import type { KnowledgeVaultIO } from '@/features/knowledge/application/ports';
import { useSettingsStore } from '@/stores/settingsStore';

useMemorySecretVault();
const originalKnowledgeService = useKnowledgeStore.getState().getService;
const originalKnowledgeRefresh = useKnowledgeStore.getState().refresh;
const originalChooseVault = useKnowledgeStore.getState().chooseVault;
afterEach(() => { useKnowledgeStore.setState({ status: 'unset', getService: originalKnowledgeService, refresh: originalKnowledgeRefresh, chooseVault: originalChooseVault }); });

vi.mock('@/features/workbench/application/workspaceDocument', () => ({
  createWorkspaceDocument: (_key: string, initial: () => unknown) => {
    let state = initial();
    return { initialize: async () => {}, load: () => state, save: (next: unknown) => { state = next; }, status: () => ({ mode: 'persistent' as const }), flush: async () => {} };
  },
}));
vi.mock('@/features/assets/application/assetCatalog', () => ({ resolveAsset: vi.fn(), listAssets: vi.fn(), getAssetPortableSource: vi.fn() }));

beforeEach(() => { vi.clearAllMocks(); vi.mocked(resolveAsset).mockReset(); });

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

  it('creates and updates only the profile, rejects credential arguments, and retains existing keys separately', async () => {
    useChannelStore.setState({ channels: [], migratedLegacyIds: [] });
    const profile = { ...openAIStandardProfile, id: 'agent-profile', baseUrl: 'https://agent.example' };
    const create = getScopedAgentTools('home').find((tool) => tool.name === 'channel_create')!;
    const context = { projectId: 'home', runId: 'profile-only' };
    expect(() => inspectScopedAgentTool('home', 'channel_create', { profileJson: JSON.stringify(profile), credential: 'do-not-store' })).toThrow();
    const invalid = JSON.stringify({ ...profile, apiKey: 'do-not-store' });
    await expect(create.execute({ profileJson: invalid }, context)).resolves.toEqual(parseProfileImport(invalid));
    expect(useChannelStore.getState().channels).toEqual([]);
    const created = await create.execute({ profileJson: JSON.stringify(profile) }, context);
    expect(created).toMatchObject({ ok: true, channelId: profile.id, credentialInstruction: expect.stringContaining('Settings') });
    expect(getChannelCredentialRef(profile.id)).toBeNull();
    expect(useChannelStore.getState().channels[0].credentialRef).toBeUndefined();
    expect(useChannelStore.getState().channels[0].profile).toEqual(profile);
    await setChannelCredential(profile.id, 'separately-entered-key');
    const before = getChannelCredentialRef(profile.id);
    const update = getScopedAgentTools('home').find((tool) => tool.name === 'channel_update')!;
    await update.execute({ channelId: profile.id, profileJson: JSON.stringify({ ...profile, name: 'Updated' }) }, context);
    expect(getChannelCredentialRef(profile.id)).toEqual(before);
    expect(JSON.stringify(useChannelStore.getState().channels)).not.toContain('separately-entered-key');
  });

  it('uses the settings request renderer for a no-network validated channel preview', async () => {
    const profile = { ...openAIStandardProfile, id: 'agent-preview', baseUrl: 'https://agent.example' };
    const preview = getScopedAgentTools('home').find((tool) => tool.name === 'channel_preview')!;
    const before = useChannelStore.getState().channels;
    const output = await preview.execute({ profileJson: JSON.stringify(profile), operation: 'chat', prompt: 'A documented request' }, { projectId: 'home', runId: 'preview' });
    expect(output).toMatchObject({ ok: true, profileId: profile.id, profileJsonChunks: expect.any(Array), requestPreviewChunks: expect.any(Array) });
    if (!output || typeof output !== 'object' || !('requestPreviewChunks' in output) || !Array.isArray(output.requestPreviewChunks)) throw new Error('Expected request preview');
    expect(output.requestPreviewChunks.join('')).toContain('A documented request');
    expect(useChannelStore.getState().channels).toBe(before);
  });

  it('keeps paged note text useful and persistence-safe without canvas checkpoints', async () => {
    const content = '# Camera notes\\n' + 'A scene with a slow moving camera. '.repeat(400);
    const io: KnowledgeVaultIO = {
      initVault: async (root) => root, openVault: async (root) => root, listTree: async () => [],
      readNote: async () => content, readNotes: async () => [],
      writeNote: vi.fn(), writeAttachment: vi.fn(), rename: vi.fn(),
      readAttachment: async () => new Uint8Array(), removeAttachment: vi.fn(),
      trash: async (path) => path, listTrash: async () => [], restore: vi.fn(),
    };
    const service = new KnowledgeService('test-vault', io);
    useKnowledgeStore.setState({ status: 'ready', getService: () => service, refresh: vi.fn() });
    const checkpoint = vi.fn();
    const context = { projectId: 'p', runId: 'paged-kb', getActiveProjectId: () => 'p', persistCanvasCheckpoint: checkpoint };
    for (const [name, args] of [
      ['kb_read', { path: 'A.md', offset: 6000, limit: 2000 }],
      ['kb_write', { path: 'B.md', content: '# Saved note' }],
    ] as const) {
      const callId = `${name}-call`;
      const approval = await prepareCanvasAgentToolApproval({ projectId: 'p', runId: context.runId, scope: 'canvas', callId, toolName: name, arguments: args });
      canvasAgentApprovalStore.update(approval.record.id, { status: 'approved' });
      const tool = createScopedSdkTools('canvas', context, false).find((candidate) => candidate.name === name)!;
      const output: unknown = await tool.invoke(new RunContext(context), JSON.stringify(args), { toolCall: { type: 'function_call', callId, name, arguments: JSON.stringify(args) } });
      if (name === 'kb_read') {
        expect(JSON.stringify(output)).toContain(content.slice(6000, 8000));
        expect(JSON.stringify(output)).not.toContain('[redacted-long-value');
      }
      const repository = new AgentSessionRepository(null);
      const session = repository.createSession({ projectId: 'p', modelRef: 'model' });
      expect(() => repository.replaceItems(session.id, [{ role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(output) }] }])).not.toThrow();
      expect(() => repository.saveRunState({ id: name, sessionId: session.id, projectId: 'p', status: 'awaiting_approval', serializedState: JSON.stringify({ output }) })).not.toThrow();
    }
    expect(io.writeNote).toHaveBeenCalledWith('test-vault', 'B.md', '# Saved note', false);
    expect(checkpoint).not.toHaveBeenCalled();
  });

  it('omits credential-bearing note snippets rather than persisting unsafe tool text', async () => {
    vi.spyOn(KnowledgeService.prototype, 'read').mockResolvedValue({ path: 'A.md', content: 'token=private-note-secret' });
    const service = new KnowledgeService('test-vault', {
      initVault: async (root) => root, openVault: async (root) => root, listTree: async () => [], readNote: vi.fn(), readNotes: async () => [],
      writeNote: vi.fn(), writeAttachment: vi.fn(), rename: vi.fn(), trash: async (path) => path, listTrash: async () => [], restore: vi.fn(),
      readAttachment: async () => new Uint8Array(), removeAttachment: vi.fn(),
    });
    useKnowledgeStore.setState({ status: 'ready', getService: () => service });
    const tool = getScopedAgentTools('home').find((candidate) => candidate.name === 'kb_read')!;
    const output = await tool.execute({ path: 'A.md' }, { projectId: 'home', runId: 'unsafe-note' });
    const repository = new AgentSessionRepository(null);
    const session = repository.createSession({ projectId: 'home', modelRef: 'model', scope: 'home' });
    expect(JSON.stringify(output)).not.toContain('private-note-secret');
    expect(() => repository.replaceItems(session.id, [{ role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(output) }] }])).not.toThrow();
  });

  it('reports an unset vault in every scope without opening a picker', async () => {
    const previous = useSettingsStore.getState().knowledgeVaultPath;
    const chooseVault = vi.fn();
    useSettingsStore.setState({ knowledgeVaultPath: null });
    useKnowledgeStore.setState({ status: 'unset', getService: originalKnowledgeService, chooseVault });
    try {
      for (const scope of ['home', 'canvas', 'stage'] as const) {
        const tool = getScopedAgentTools(scope).find((candidate) => candidate.name === 'kb_search')!;
        await expect(tool.execute({}, { projectId: 'p', runId: `unset-${scope}` })).rejects.toMatchObject({ code: 'VAULT_UNSET' });
      }
      expect(chooseVault).not.toHaveBeenCalled();
    } finally {
      useSettingsStore.setState({ knowledgeVaultPath: previous });
    }
  });
});
