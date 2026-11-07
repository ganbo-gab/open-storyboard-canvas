import 'fake-indexeddb/auto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createAssetCatalogDocument, deleteAssetReference, saveAsset } from '@/features/assets/application/assetCatalog';
import { getScopedAgentTools } from '@/features/agents/application/scopedAgentTools';
import { listProjectSummaries } from '@/commands/projectState';
import { AgentSessionRepository } from '../infrastructure/agentSessionRepository';
import { createCanvasAgent, createStoryboardAgentRuntime } from '../infrastructure/sdkRuntime';
import type { AgentModelReference, AgentModelTransport, AgentModelTurnRequest, AgentTurnMediaInput } from '../domain/agentModel';
import type { CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { buildAgentAttachmentContext, prepareRegisteredAgentMedia, restoreAgentSessionMedia } from './agentSessionMedia';
import { createAgentMediaReference, resolveAgentMediaReference, revokeAgentMediaRun, toOpaqueAgentMediaReference } from './agentMediaResolver';

vi.mock('@/commands/projectState', () => ({ getProjectRecord: vi.fn(), listProjectSummaries: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => false, invoke: vi.fn() }));

class MemoryStorage {
  values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

beforeAll(() => {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: new MemoryStorage() });
  vi.mocked(listProjectSummaries).mockResolvedValue([]);
});

const model: AgentModelReference = { catalogId: 'custom:p:m', providerId: 'p', modelId: 'm', label: 'M', usable: true,
  capabilities: { protocol: 'anthropic-messages', tools: true, stream: false, vision: true, reasoningSummary: false, toolSearch: false },
};

describe('registered Agent image attachments', () => {
  it('resolves the real uploaded asset, supplies its ID to the model, and reads the same asset through home/stage tools', async () => {
    const asset = await saveAsset({ id: 'registered-image', kind: 'image', name: 'Reference image', source: 'https://assets.example/real.png', origin: 'uploaded', metadata: {} });
    const prepared = await prepareRegisteredAgentMedia([{ assetId: asset.id, title: 'caller title', origin: 'upload', source: '/Users/forged/private.png' }], []);
    expect(prepared).toEqual([expect.objectContaining({ assetId: asset.id, title: asset.name, source: asset.source })]);
    const grant = createAgentMediaReference('model-attachment', asset.id, prepared[0].source, 60000, asset.id);
    const requests: AgentModelTurnRequest[] = [];
    const transport: AgentModelTransport = {
      async getResponse(request) {
        requests.push(request);
        return { responseId: 'response', text: 'Reference received', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
      },
      async *getStreamedResponse() { throw new Error('Fixture does not stream'); },
    };
    const runtime = createStoryboardAgentRuntime({ resolveModel: () => model, transport });
    const agent = createCanvasAgent({ runtime, scope: 'home', modelName: model.catalogId, supportsVision: true,
      skillContext: { text: 'Look at this image', attachmentKinds: ['image'] }, context: { projectId: 'home', runId: 'model-attachment' },
      attachmentContext: buildAgentAttachmentContext({ scope: 'home', projectId: 'home', current: prepared }),
    });
    await runtime.runner.run(agent, [{ role: 'user', content: [{ type: 'input_text', text: 'Look at this image' }, { type: 'input_image', image: grant }] }]);
    expect(requests[0].systemInstructions).toContain(`"assetId":"${asset.id}"`);
    expect(requests[0].systemInstructions).toContain('"readTool":"asset_view"');
    expect(requests[0].systemInstructions).not.toContain(asset.source);
    expect(requests[0].input).toContainEqual(expect.objectContaining({ type: 'message', role: 'user', content: expect.arrayContaining([{ type: 'image', imageUrl: asset.source }]) }));
    for (const scope of ['home', 'stage'] as const) {
      const tool = getScopedAgentTools(scope).find((entry) => entry.name === 'asset_view');
      const output = await tool?.execute({ assetId: asset.id }, { projectId: 'p', runId: `view-${scope}` });
      expect(output).toEqual(expect.arrayContaining([{ type: 'text', text: JSON.stringify({ assetId: asset.id, name: asset.name }) },
        { type: 'image', image: toOpaqueAgentMediaReference({ id: `view-${scope}:${asset.id}` }), detail: 'auto' }]));
      expect(resolveAgentMediaReference(`view-${scope}:${asset.id}`)).toBe(asset.source);
      revokeAgentMediaRun(`view-${scope}`);
    }
    revokeAgentMediaRun('model-attachment');
  });

  it('rejects unregistered IDs even when the composer still has a valid source', async () => {
    await expect(prepareRegisteredAgentMedia([{ assetId: 'made-up-id', title: 'Local thumbnail', origin: 'upload', source: 'https://assets.example/thumbnail.png' }], []))
      .rejects.toThrow(/不在资产库/);
  });

  it('restores persisted uploads after losing transient grants, and marks removed assets missing', async () => {
    const asset = await saveAsset({ id: 'durable-upload', kind: 'image', name: 'Durable reference', source: 'https://assets.example/durable.png', origin: 'uploaded', metadata: {} });
    const reopenedCatalog = createAssetCatalogDocument();
    await reopenedCatalog.initialize?.();
    expect(reopenedCatalog.load().saved[asset.id]).toMatchObject({ id: asset.id });
    const storage = new MemoryStorage();
    const repository = new AgentSessionRepository(storage, () => 100, () => 'restored-session');
    const session = repository.createSession({ projectId: 'home', scope: 'home', modelRef: model.catalogId });
    const referenceId = `prior-run:${asset.id}`;
    repository.recordMediaReferences(session.id, [{ referenceId, runId: 'prior-run', assetId: asset.id, title: asset.name, origin: 'upload', createdAt: 100 }]);
    await repository.createSdkSession(session.id).addItems([{ role: 'user', content: [{ type: 'input_text', text: 'Remember this picture' }, { type: 'input_image', image: { id: referenceId } }] }]);
    createAgentMediaReference('prior-run', asset.id, asset.source, 60000, asset.id);
    revokeAgentMediaRun('prior-run');
    const restored = new AgentSessionRepository(storage).getSession(session.id);
    if (!restored) throw new Error('Session not restored');
    expect(await restoreAgentSessionMedia(restored, [])).toEqual([expect.objectContaining({ referenceId, availability: 'available', previewSource: asset.source })]);
    expect(resolveAgentMediaReference(referenceId)).toBe(asset.source);
    const serialized = [...storage.values.values()].join('');
    expect(serialized).not.toContain(asset.source);
    expect(serialized).not.toContain('previewSource');
    await deleteAssetReference(asset.id);
    expect(await restoreAgentSessionMedia(restored, [])).toEqual([expect.objectContaining({ referenceId, availability: 'missing' })]);
    expect(resolveAgentMediaReference(referenceId)).toBeNull();
  });

  it('does not restore a different asset through a forged persisted reference ID', async () => {
    const asset = await saveAsset({ id: 'authorized-image', kind: 'image', name: 'Authorized image', source: 'https://assets.example/authorized.png', origin: 'uploaded', metadata: {} });
    const repository = new AgentSessionRepository(null, () => 100, () => 'forged-session');
    const session = repository.createSession({ projectId: 'home', scope: 'home', modelRef: model.catalogId });
    session.mediaReferences = [{ referenceId: 'forged-run:another-asset', runId: 'forged-run', assetId: asset.id, title: asset.name, origin: 'upload', createdAt: 100 }];
    expect(await restoreAgentSessionMedia(session, [])).toEqual([expect.objectContaining({ availability: 'missing' })]);
    expect(resolveAgentMediaReference('forged-run:another-asset')).toBeNull();
  });

  it('validates the canvas node binding and supplies the project-qualified asset ID in stage context', async () => {
    const nodes: CanvasNode[] = [{ id: 'n', type: 'uploadNode', position: { x: 0, y: 0 }, data: { imageUrl: 'https://assets.example/canvas.png', displayName: 'Canvas image', aspectRatio: '1:1' } }];
    const input: AgentTurnMediaInput = { assetId: 'n:image', nodeId: 'n', title: 'Image', origin: 'canvas-asset', source: 'https://assets.example/wrong.png' };
    const prepared = await prepareRegisteredAgentMedia([input], nodes);
    expect(prepared[0].source).toBe('https://assets.example/canvas.png');
    expect(buildAgentAttachmentContext({ scope: 'stage', projectId: 'p', current: prepared })).toContain('"readAssetId":"project:p:n:image"');
    await expect(prepareRegisteredAgentMedia([{ ...input, nodeId: 'other' }], nodes)).rejects.toThrow(/不在资产库或画布/);
  });
});
