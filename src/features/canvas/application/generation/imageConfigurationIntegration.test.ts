import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { createJSONStorage } from 'zustand/middleware';
import type * as Services from '../canvasServices';
import type { ChannelProfileV2 } from '@/features/channels/domain/profile';
import { channelProviderId, useChannelStore } from '@/features/channels/store/channelStore';
import { useCustomProvidersStore } from '@/stores/customProvidersStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useCanvasStore } from '@/stores/canvasStore';
import { CANVAS_NODE_TYPES } from '../../domain/canvasNodes';
import { projectCanvasNodeForRead } from '../canvasReadProjection';
import { previewNodeGenerationRequest, submitNodeGeneration } from './index';
import { resolveActiveModelForPanel } from '../resolveActiveModelForPanel';

const submit = vi.hoisted(() => vi.fn());
vi.mock('../canvasServices', async original => {
  const services = await original<typeof Services>();
  return { ...services, canvasAiGateway: { ...services.canvasAiGateway, submitGenerateImageJob: submit } };
});
vi.mock('../errorDialog', () => ({ resolveErrorContent: (error: unknown) => ({ message: String(error) }), showErrorDialog: vi.fn() }));

const profile: ChannelProfileV2 = { version: 2, id: 'configuration-fixture', name: 'Fixture', baseUrl: 'https://fixture.invalid', auth: { type: 'none' },
  operations: { 'image.generate': { method: 'POST', path: '/images', body: 'json', template: { model: '{{model}}', prompt: '{{prompt}}', size: '{{param.size}}', quality: '{{param.quality}}' },
    response: { mode: 'sync', outputs: [{ path: 'data[*].url', as: 'url', kind: 'image' }] } } },
  models: [{ id: 'gpt-image-2.6', operations: ['image.generate'], params: [
    { key: 'size', label: 'Size', type: 'enum', default: '1024x576', options: [{ label: '16:9', value: '1024x576' }, { label: '9:16', value: '576x1024' }] },
    { key: 'quality', label: 'Quality', type: 'enum', default: 'high', options: [{ label: 'High', value: 'high' }] },
  ] }] };
const entryId = `custom:${channelProviderId(profile.id, 'image')}:gpt-image-2.6`;
beforeEach(() => {
  const memory = new Map<string, string>();
  const storage = { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => { memory.set(key, value); }, removeItem: (key: string) => { memory.delete(key); } };
  useChannelStore.persist.setOptions({ storage: createJSONStorage(() => storage) });
  useCustomProvidersStore.persist.setOptions({ storage: createJSONStorage(() => storage) });
  useChannelStore.setState({ channels: [{ profile: structuredClone(profile), origin: 'native', migrationIssues: [], createdAt: 1, updatedAt: 1 }] });
  useCustomProvidersStore.setState({ providers: [] });
  useSettingsStore.setState({ appendParameterConstraintsToPrompt: true, lastModelConfigByPanel: {}, apiKeys: {} });
  useCanvasStore.getState().setCanvasData([], []);
  submit.mockReset();
});
afterEach(() => { useCanvasStore.getState().setCanvasData([], []); useChannelStore.setState({ channels: [] }); });

it.each([false, true])('keeps submitted body, Agent read, pending result and diagnostic context aligned (modes=%s)', async modes => {
  if (modes) {
    const configured = structuredClone(profile); configured.models[0].modes = [{ id: 'text', label: 'Text', operation: 'image.generate' }];
    useChannelStore.setState({ channels: [{ profile: configured, origin: 'native', migrationIssues: [], createdAt: 1, updatedAt: 1 }] });
  }
  const id = useCanvasStore.getState().addNode(CANVAS_NODE_TYPES.imageEdit, { x: 0, y: 0 }, {
    prompt: '原神神里绫华', model: 'kie/nano-banana-2', size: '2K', aspectRatio: '1:1',
    extraParams: { oldVendorFlag: true, size: '4096x4096' },
    modelConfig: { entryId, ratio: 'auto', extraParams: { size: '1024x576', quality: 'high' } },
  });
  const preview = await previewNodeGenerationRequest(id);
  expect(preview).toMatchObject({ providerRequest: { url: 'https://fixture.invalid/images', body: { model: 'gpt-image-2.6', size: '1024x576', quality: 'high' } } });
  expect(JSON.stringify(preview)).not.toMatch(/kie\/|2K|oldVendorFlag|4096x4096/);
  const source = useCanvasStore.getState().nodes.find(node => node.id === id)!;
  expect(projectCanvasNodeForRead(source)).toMatchObject({ data: { model: entryId, size: '1024x576', requestAspectRatio: '16:9' } });
  const pending = Promise.withResolvers<string>(); submit.mockReturnValue(pending.promise);
  const generation = submitNodeGeneration(id);
  await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce());
  const result = useCanvasStore.getState().nodes.find(node => node.type === CANVAS_NODE_TYPES.exportImage)!;
  expect(result.data).toMatchObject({ isGenerating: true, model: entryId, aspectRatio: '16:9', resolution: '1024x576',
    generationDebugContext: { requestModel: entryId, requestSize: '1024x576', requestAspectRatio: '16:9' } });
  expect(submit.mock.calls[0][0].prompt).toContain('16:9');
  expect(submit.mock.calls[0][0].prompt).not.toContain('2K');
  pending.resolve('fixture-original-job'); expect(await generation).toMatchObject({ ok: true, jobIds: ['fixture-original-job'] });
});

it('does not invent a KIE model with no configured channel, or silently replace an unavailable selection', () => {
  expect(resolveActiveModelForPanel('aiImageNode', { entryId: 'custom:removed:image', ratio: 'auto' }))
    .toMatchObject({ entryId: 'custom:removed:image', usable: false, resolvedByFallback: false });
  expect(resolveActiveModelForPanel('aiImageNode', { entryId: 'invalid-entry', ratio: 'auto' }))
    .toMatchObject({ entryId: 'invalid-entry', usable: false });
  useSettingsStore.setState({ apiKeys: { kie: 'fixture-key-must-not-be-used' } });
  expect(resolveActiveModelForPanel('aiImageNode', { entryId: 'builtin:does-not-exist', ratio: 'auto' }))
    .toMatchObject({ entryId: 'builtin:does-not-exist', usable: false, modelForGateway: 'builtin:does-not-exist' });
  useChannelStore.setState({ channels: [] });
  expect(resolveActiveModelForPanel('aiImageNode')).toMatchObject({ modelForGateway: '', usable: false });
});

it('keeps undeclared geometry automatic instead of leaking old square/2K defaults', async () => {
  const configured = structuredClone(profile);
  configured.models[0].params = [];
  configured.operations['image.generate']!.template = { model: '{{model}}', prompt: '{{prompt}}' };
  useChannelStore.setState({ channels: [{ profile: configured, origin: 'native', migrationIssues: [], createdAt: 1, updatedAt: 1 }] });
  const id = useCanvasStore.getState().addNode(CANVAS_NODE_TYPES.imageEdit, { x: 0, y: 0 }, {
    prompt: 'No declared geometry', model: 'kie/nano-banana-2', size: '2K', aspectRatio: '1:1',
    modelConfig: { entryId, ratio: 'auto', extraParams: {} },
  });
  const preview = await previewNodeGenerationRequest(id);
  expect(JSON.stringify(preview)).not.toMatch(/kie\/|2K|1:1/);
  submit.mockResolvedValue('fixture-automatic');
  expect(await submitNodeGeneration(id)).toMatchObject({ ok: true });
  expect(useCanvasStore.getState().nodes.find(node => node.type === CANVAS_NODE_TYPES.exportImage)?.data)
    .toMatchObject({ aspectRatio: 'auto' });
});

it('uses the native batch count in optional prompt constraints as well as the submitted parameter', async () => {
  const configured = structuredClone(profile);
  configured.models[0].params.push({ key: 'n', label: 'Count', type: 'number', min: 1, max: 4, default: 1 });
  configured.operations['image.generate']!.template = { model: '{{model}}', prompt: '{{prompt}}', size: '{{param.size}}', n: '{{param.n}}' };
  useChannelStore.setState({ channels: [{ profile: configured, origin: 'native', migrationIssues: [], createdAt: 1, updatedAt: 1 }] });
  const id = useCanvasStore.getState().addNode(CANVAS_NODE_TYPES.imageEdit, { x: 0, y: 0 }, {
    prompt: 'Three images', modelConfig: { entryId, ratio: 'auto', extraParams: { size: '1024x576', n: 3 } },
  });
  const preview = await previewNodeGenerationRequest(id);
  expect(preview).toMatchObject({ providerRequest: { body: { n: 3, prompt: expect.stringContaining('生成张数 3') } } });
});
