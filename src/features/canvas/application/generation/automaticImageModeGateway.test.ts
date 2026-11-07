import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createJSONStorage } from 'zustand/middleware';
import type * as ImageCommands from '@/commands/image';
import type { ChannelProfileV2 } from '@/features/channels/domain/profile';
const mocks = vi.hoisted(() => ({ http: vi.fn(), create: vi.fn(), update: vi.fn(), image: vi.fn(), load: vi.fn() }));
vi.mock('@tauri-apps/api/core', async original => ({ ...await original<typeof import('@tauri-apps/api/core')>(), isTauri: () => true }));
vi.mock('@/commands/ai', async original => ({ ...await original<typeof import('@/commands/ai')>(), customHttpRequest: mocks.http,
  createGenerationJob: mocks.create, updateGenerationJob: mocks.update }));
vi.mock('@/commands/image', async original => ({ ...await original<typeof ImageCommands>(), prepareNodeImageSourceWithHeaders: mocks.image, loadImage: mocks.load }));
import { useChannelStore, channelProviderId } from '@/features/channels/store/channelStore';
import { useCustomProvidersStore } from '@/stores/customProvidersStore';
import { waitForChannelJob } from '@/features/channels/runtime/channelExecution';
import { buildGenerateImageDebugPreview, tauriAiGateway } from '../../infrastructure/tauriAiGateway';
import { mapImageChannelGenerationParameters } from './channelParameters';
import type { GenerateImagePayload } from '../ports';

const profile: ChannelProfileV2 = { version: 2, id: 'gateway-auto-image-fixture', name: 'Automatic image gateway fixture', baseUrl: 'https://fixture.invalid', auth: { type: 'none' },
  operations: {
    'image.generate': { method: 'POST', path: '/images', body: 'json', template: { prompt: '{{prompt}}', n: '{{param.n}}', textQuality: '{{param.textQuality}}' }, response: { mode: 'sync', outputs: [{ path: 'data[*].url', as: 'url', kind: 'image' }] } },
    'image.edit': { method: 'POST', path: '/edits', body: 'json', imageEncoding: 'data-url', template: { prompt: '{{prompt}}', images: '{{slot.images}}', n: '{{param.n}}', editQuality: '{{param.editQuality}}' }, response: { mode: 'sync', outputs: [{ path: 'data[*].url', as: 'url', kind: 'image' }] } },
  }, models: [{ id: 'image', operations: ['image.generate', 'image.edit'], params: [], modes: [
    { id: 'text', label: 'Text', operation: 'image.generate', params: [{ key: 'n', label: 'Count', type: 'number', min: 1, max: 4, default: 1 }, { key: 'textQuality', label: 'Text quality', type: 'text', default: 'text-default' }] },
    { id: 'edit', label: 'Edit', operation: 'image.edit', slots: [{ key: 'images', label: 'Images', kind: 'image', min: 1, max: 2 }], params: [{ key: 'n', label: 'Count', type: 'number', min: 1, max: 4, default: 2 }, { key: 'editQuality', label: 'Edit quality', type: 'text', default: 'edit-default' }] },
  ] }] };
const payload: GenerateImagePayload = { model: `custom:${channelProviderId(profile.id, 'image')}:image`, prompt: 'Original prompt', size: '', aspectRatio: '' };
function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: key => { values.delete(key); },
    clear: () => values.clear(), key: index => [...values.keys()][index] ?? null, get length() { return values.size; } };
}
beforeEach(() => {
  vi.clearAllMocks();
  const storage = memoryStorage();
  vi.stubGlobal('localStorage', storage);
  useChannelStore.persist.setOptions({ storage: createJSONStorage(() => storage) });
  useCustomProvidersStore.persist.setOptions({ storage: createJSONStorage(() => storage) });
  useChannelStore.setState({ channels: [{ profile: structuredClone(profile), origin: 'native', migrationIssues: [], createdAt: 1, updatedAt: 1 }] });
  useCustomProvidersStore.setState({ providers: [] });
  mocks.create.mockResolvedValue(undefined); mocks.update.mockResolvedValue(undefined);
  mocks.http.mockResolvedValue({ status: 200, text: JSON.stringify({ data: [{ url: 'https://fixture.invalid/generated.png' }] }) });
  mocks.image.mockResolvedValue({ imagePath: '/fixture/generated.png' });
  mocks.load.mockResolvedValue('data:image/png;base64,FIXTURE');
});
afterEach(() => { useChannelStore.setState({ channels: [] }); useCustomProvidersStore.setState({ providers: [] }); vi.unstubAllGlobals(); });

describe('canvas image gateway automatic mode mapping', () => {
  it('resolves edit before projecting parameters and uses the same slot-mapped body in preview and native submission', async () => {
    const source: GenerateImagePayload = { ...payload, referenceImages: ['/original.png'], extraParams: { editQuality: 'edit-choice', textQuality: 'must-not-leak', unknown: 'must-not-leak' } };
    const before = structuredClone(source);
    expect(mapImageChannelGenerationParameters(source)).toMatchObject({ channelModeId: 'edit', extraParams: { n: 2, editQuality: 'edit-choice' } });
    const preview = await buildGenerateImageDebugPreview(source);
    expect(preview.gatewayRequest.channelModeId).toBe('edit');
    expect(preview.providerRequest).toMatchObject({ url: 'https://fixture.invalid/edits', body: { n: 2, editQuality: 'edit-choice', images: ['<image 1: png>'] } });
    expect(preview.providerRequest?.body).not.toHaveProperty('textQuality');
    expect(preview.providerRequest?.body).not.toHaveProperty('unknown');
    expect(mocks.http).not.toHaveBeenCalled();
    const id = await tauriAiGateway.submitGenerateImageJob(source);
    expect(await waitForChannelJob(id)).toMatchObject({ status: 'succeeded', result: '/fixture/generated.png' });
    expect(mocks.http).toHaveBeenCalledOnce();
    expect(mocks.http.mock.calls[0][0]).toMatchObject({ method: 'POST', url: 'https://fixture.invalid/edits', body: { prompt: 'Original prompt', images: ['data:image/png;base64,FIXTURE'], n: 2, editQuality: 'edit-choice' } });
    const snapshot = mocks.create.mock.calls[0][0].pollDescriptor;
    expect(snapshot.input).toMatchObject({ modeId: 'edit', operation: 'image.edit', count: 2, params: { n: 2, editQuality: 'edit-choice' } });
    expect(source).toEqual(before);
  });

  it('uses the text mode defaults without references and never carries edit-only params', async () => {
    const source = { ...payload, extraParams: { editQuality: 'must-not-leak' } };
    const preview = await buildGenerateImageDebugPreview(source);
    expect(preview.gatewayRequest.channelModeId).toBe('text');
    expect(preview.providerRequest).toMatchObject({ url: 'https://fixture.invalid/images', body: { n: 1, textQuality: 'text-default' } });
    const id = await tauriAiGateway.submitGenerateImageJob(source); await waitForChannelJob(id);
    expect(mocks.http.mock.calls[0][0].body).toEqual({ prompt: 'Original prompt', n: 1, textQuality: 'text-default' });
  });

  it('keeps explicit empty slots authoritative and ignores generic reference fallback without auto-switching to edit', async () => {
    const source = { ...payload, referenceImages: ['/generic.png'], referenceSlots: {} };
    const preview = await buildGenerateImageDebugPreview(source);
    expect(preview.gatewayRequest.channelModeId).toBe('text');
    const id = await tauriAiGateway.submitGenerateImageJob(source); await waitForChannelJob(id);
    expect(mocks.http.mock.calls[0][0].url).toBe('https://fixture.invalid/images');
    expect(mocks.http.mock.calls[0][0].body).not.toHaveProperty('images');
    expect(mocks.load).not.toHaveBeenCalled();
  });

  it('honors manual modes and rejects their invalid inputs before durable creation or native transport', async () => {
    const source = { ...payload, channelModeId: 'text', referenceImages: ['/one.png'] };
    await expect(buildGenerateImageDebugPreview(source)).rejects.toThrow('手动分配');
    await expect(tauriAiGateway.submitGenerateImageJob(source)).rejects.toThrow('手动分配');
    await expect(tauriAiGateway.submitGenerateImageJob({ ...payload, channelModeId: 'missing' })).rejects.toThrow('未声明模式');
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.http).not.toHaveBeenCalled();
  });

  it('uses the new automatic edit default when an old same-key text parameter is incompatible', async () => {
    const configured = structuredClone(profile);
    configured.models[0].modes![0].params!.push({ key: 'size', label: 'Size', type: 'enum', default: '1024x1024', options: [{ label: 'Text size', value: '1024x1024' }] });
    configured.models[0].modes![1].params!.push({ key: 'size', label: 'Size', type: 'enum', default: '1536x1024', options: [{ label: 'Edit size', value: '1536x1024' }] });
    configured.operations['image.edit']!.template = { images: '{{slot.images}}', size: '{{param.size}}' };
    useChannelStore.setState({ channels: [{ profile: configured, origin: 'native', migrationIssues: [], createdAt: 1, updatedAt: 1 }] });
    const source: GenerateImagePayload = { ...payload, referenceImages: ['/original.png'], extraParams: { size: '1024x1024' } };
    expect(mapImageChannelGenerationParameters(source)).toMatchObject({ channelModeId: 'edit', extraParams: { size: '1536x1024' } });
    const preview = await buildGenerateImageDebugPreview(source);
    expect(preview.providerRequest?.body).toMatchObject({ size: '1536x1024' });
    const id = await tauriAiGateway.submitGenerateImageJob(source); await waitForChannelJob(id);
    expect(mocks.http.mock.calls[0][0].body).toMatchObject({ size: '1536x1024', images: ['data:image/png;base64,FIXTURE'] });
    expect(source.extraParams?.size).toBe('1024x1024');
  });

  it('keeps invalid same-key parameters strict for a manually selected image mode', async () => {
    const configured = structuredClone(profile);
    configured.models[0].modes![1].params!.push({ key: 'size', label: 'Size', type: 'enum', default: '1536x1024', options: [{ label: 'Edit size', value: '1536x1024' }] });
    useChannelStore.setState({ channels: [{ profile: configured, origin: 'native', migrationIssues: [], createdAt: 1, updatedAt: 1 }] });
    const source: GenerateImagePayload = { ...payload, channelModeId: 'edit', referenceImages: ['/original.png'], extraParams: { size: '1024x1024' } };
    await expect(buildGenerateImageDebugPreview(source)).rejects.toThrow('不符合声明');
    await expect(tauriAiGateway.submitGenerateImageJob(source)).rejects.toThrow('不符合声明');
    expect(source.extraParams?.size).toBe('1024x1024');
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.http).not.toHaveBeenCalled();
  });

  it.each([0, 1])('counts only declared image slots when optional audio slots contain media (images=%s)', async imageCount => {
    const configured = structuredClone(profile);
    for (const mode of configured.models[0].modes ?? []) mode.slots = [...(mode.slots ?? []), { key: 'audio', label: 'Optional audio', kind: 'audio', max: 2 }];
    useChannelStore.setState({ channels: [{ profile: configured, origin: 'native', migrationIssues: [], createdAt: 1, updatedAt: 1 }] });
    const source: GenerateImagePayload = { ...payload, referenceSlots: { audio: ['/sound-one.mp3', '/sound-two.mp3'], ...(imageCount ? { images: ['/one.png'] } : {}) } };
    const expected = imageCount ? 'edit' : 'text';
    expect(mapImageChannelGenerationParameters(source).channelModeId).toBe(expected);
    const preview = await buildGenerateImageDebugPreview(source);
    expect(preview.gatewayRequest.channelModeId).toBe(expected);
    expect(preview.providerRequest?.body).toMatchObject({ n: imageCount ? 2 : 1 });
    const id = await tauriAiGateway.submitGenerateImageJob(source); await waitForChannelJob(id);
    expect(mocks.http.mock.calls[0][0].url).toBe(`https://fixture.invalid/${imageCount ? 'edits' : 'images'}`);
  });
});
