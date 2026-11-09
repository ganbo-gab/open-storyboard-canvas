import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { createJSONStorage } from 'zustand/middleware';
import type * as Variants from './imageVariants';
import type { ChannelProfileV2 } from '@/features/channels/domain/profile';
import { channelProviderId, useChannelStore } from '@/features/channels/store/channelStore';
import { useCustomProvidersStore } from '@/stores/customProvidersStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useCanvasStore } from '@/stores/canvasStore';
import { CANVAS_NODE_TYPES } from '../../domain/canvasNodes';
import { previewNodeGenerationRequest } from './index';
import { assembleStoryboardRequest, assemblePanelRequest } from './imageVariantRequests';
import { resolveActiveModelForPanel } from '../resolveActiveModelForPanel';

vi.mock('./imageVariants', async original => ({ ...await original<typeof Variants>(), generateGridImageDataUrl: () => 'data:image/png;base64,GRID' }));

const profile: ChannelProfileV2 = { version: 2, id: 'variant-configuration-fixture', name: 'Fixture', baseUrl: 'https://fixture.invalid', auth: { type: 'none' },
  operations: { 'image.edit': { method: 'POST', path: '/edit', body: 'json', template: { model: '{{model}}', prompt: '{{prompt}}', size: '{{param.size}}', quality: '{{param.quality}}' },
    response: { mode: 'sync', outputs: [{ path: 'data[*].url', as: 'url', kind: 'image' }] } } },
  models: [{ id: 'declared-image', operations: ['image.edit'], refs: { image: 2 }, params: [
    { key: 'size', label: 'Size', type: 'enum', default: '1024x576', options: [{ label: '16:9', value: '1024x576' }, { label: '9:16', value: '576x1024' }] },
    { key: 'quality', label: 'Quality', type: 'enum', default: 'high', options: [{ label: 'High', value: 'high' }] },
    { key: 'ratio', label: 'Ratio', type: 'enum', default: 'auto', options: ['auto', '1:1', '16:9', '9:16'].map(value => ({ label: value, value })) },
  ] }] };
const entryId = `custom:${channelProviderId(profile.id, 'image')}:declared-image`;
beforeEach(() => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  useChannelStore.persist.setOptions({ storage: createJSONStorage(() => storage) });
  useCustomProvidersStore.persist.setOptions({ storage: createJSONStorage(() => storage) });
  useChannelStore.setState({ channels: [{ profile: structuredClone(profile), origin: 'native', migrationIssues: [], createdAt: 1, updatedAt: 1 }] });
  useCustomProvidersStore.setState({ providers: [] });
  useSettingsStore.setState({ appendParameterConstraintsToPrompt: true, lastModelConfigByPanel: {}, apiKeys: {} });
  useCanvasStore.getState().setCanvasData([], []);
});
afterEach(() => { useCanvasStore.getState().setCanvasData([], []); useChannelStore.setState({ channels: [] }); });

it.each([false, true])('uses declared storyboard defaults without old-model parameters (modes=%s)', async modes => {
  if (modes) {
    const configured = structuredClone(profile);
    configured.models[0].modes = [{ id: 'edit', label: 'Edit', operation: 'image.edit', slots: [{ key: 'images', label: 'Images', kind: 'image', min: 1, max: 2 }] }];
    useChannelStore.setState({ channels: [{ profile: configured, origin: 'native', migrationIssues: [], createdAt: 1, updatedAt: 1 }] });
  }
  const id = useCanvasStore.getState().addNode(CANVAS_NODE_TYPES.storyboardGen, { x: 0, y: 0 }, {
    gridRows: 2, gridCols: 2, model: 'kie/old', size: '4K', extraParams: { oldVendorFlag: true, size: '576x1024' },
    modelConfig: { entryId, ratio: 'auto', extraParams: {} },
  });
  const preview = await previewNodeGenerationRequest(id);
  expect(preview).toMatchObject({ providerRequest: { body: { model: 'declared-image', size: '1024x576', quality: 'high', prompt: expect.stringContaining('16:9') } } });
  expect(JSON.stringify(preview)).not.toMatch(/kie\/old|4K|oldVendorFlag|576x1024/);
  const local = await assembleStoryboardRequest(id, { tool: { id: 'gridPreview' } });
  expect(local).toMatchObject({ gridPreview: 'data:image/png;base64,GRID', resultPatch: { aspectRatio: '1:1' } });
});

it('keeps unavailable saved panel selections and requires a new explicit choice', async () => {
  const selected = { entryId: 'custom:removed:image', ratio: 'auto', extraParams: { size: '4K' } };
  useSettingsStore.setState({ lastModelConfigByPanel: { lighting: selected } });
  expect(resolveActiveModelForPanel('lighting')).toMatchObject({ entryId: selected.entryId, usable: false, resolvedByFallback: false });
  const id = useCanvasStore.getState().addNode(CANVAS_NODE_TYPES.upload, { x: 0, y: 0 }, { imageUrl: 'asset-media:source-image' });
  await expect(assemblePanelRequest(id, { tool: { id: 'lighting', prompt: 'Soft lighting' } })).rejects.toThrow();
  expect(useSettingsStore.getState().lastModelConfigByPanel?.lighting).toEqual(selected);
});

it('uses the selected panel channel defaults without inventing a 2K transport parameter', async () => {
  useSettingsStore.setState({ lastModelConfigByPanel: { lighting: { entryId, ratio: 'auto', extraParams: {} } } });
  const id = useCanvasStore.getState().addNode(CANVAS_NODE_TYPES.upload, { x: 0, y: 0 }, { imageUrl: 'asset-media:source-image', aspectRatio: '1:1' });
  const plan = await assemblePanelRequest(id, { tool: { id: 'lighting', prompt: 'Soft lighting' } });
  expect(plan).toMatchObject({ gatewayPayload: { model: entryId, extraParams: { size: '1024x576', quality: 'high' }, prompt: expect.stringContaining('16:9') } });
  expect(JSON.stringify(plan)).not.toContain('2K');
});
