// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { buildChannelModelGenerationCatalog, useChannelModelGenerationCatalog } from './modelGenerationCatalog';
import { useChannelStore, type ChannelRecord } from '../store/channelStore';

function record(auth: 'none' | 'bearer' = 'none'): ChannelRecord {
  return { origin: 'native', migrationIssues: [], createdAt: 1, updatedAt: 1, profile: { version: 2, id: 'models', name: 'My model channel', baseUrl: 'https://models.example', auth: { type: auth }, operations: {}, models: [
    { id: 'real-user-model', operations: [], params: [], modes: [{ id: 'image', label: 'Image to model', operation: 'model.generate', slots: [{ key: 'input', label: 'Image', kind: 'image', min: 1, max: 3 }], endpoint: {
      method: 'POST', path: '/model', body: 'json', template: { images: '{{slot.input}}' }, response: { mode: 'sync', outputs: [{ path: 'model', as: 'url', kind: 'model' }, { path: 'preview', as: 'url', kind: 'image' }] },
    } }] },
    { id: 'image-only', operations: ['image.generate'], params: [] },
    { id: 'no-image-input', operations: [], params: [], modes: [{ id: 'text', label: 'Text only', operation: 'model.generate', endpoint: {
      method: 'POST', path: '/model', body: 'json', response: { mode: 'sync', outputs: [{ path: 'model', as: 'url', kind: 'model' }] },
    } }] },
  ] } };
}
afterEach(() => { cleanup(); useChannelStore.setState({ channels: [] }); });
describe('declared model generation catalog', () => {
  it('lists only model-output declarations and reports input/credential readiness', () => {
    expect(buildChannelModelGenerationCatalog([record()])).toMatchObject([
      { modelId: 'real-user-model', usable: true, channelModelRef: { profileId: 'models', modelId: 'real-user-model' }, modes: [{ mode: { id: 'image' } }] },
      { modelId: 'no-image-input', usable: false, notReadyReason: '模型未声明参考图槽位' },
    ]);
    expect(buildChannelModelGenerationCatalog([record('bearer')])[0]).toMatchObject({ usable: false, notReadyReason: '渠道未配置 API Key' });
    expect(buildChannelModelGenerationCatalog([{ ...record(), origin: 'legacy' }])).toEqual([]);
  });
  it('reactively reflects configured model changes without adding vendor models', async () => {
    useChannelStore.setState({ channels: [record()] }); const hook = renderHook(() => useChannelModelGenerationCatalog());
    expect(hook.result.current).toHaveLength(2);
    await act(async () => { useChannelStore.setState({ channels: [] }); }); expect(hook.result.current).toEqual([]);
    await act(async () => { useChannelStore.setState({ channels: [record('bearer')] }); }); expect(hook.result.current[0].usable).toBe(false);
  });
});
