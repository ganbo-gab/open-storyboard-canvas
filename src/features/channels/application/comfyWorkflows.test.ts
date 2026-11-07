import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createJSONStorage } from 'zustand/middleware';
import { useCustomProvidersStore, type CustomProviderConfig } from '@/stores/customProvidersStore';
import { useMemorySecretVault } from '@/features/secrets/testSupport';
import { parseComfyUIConfig } from '@/features/canvas/infrastructure/comfyuiGateway';
import { readComfyUIWorkflows, resolveComfyUIWorkflow } from './comfyWorkflows';

useMemorySecretVault();
const values = new Map<string, string>();
const storage: Storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: (key) => { values.delete(key); },
  clear: () => values.clear(), key: (index) => [...values.keys()][index] ?? null, get length() { return values.size; } };
const config = (text = 'original') => ({ workflow: { '6': { class_type: 'CLIPTextEncode', inputs: { text } }, '9': { class_type: 'SaveImage', inputs: { images: ['6', 0] } } },
  bindings: { prompt: { nodeId: '6', input: 'text' } }, outputNodeIds: ['9'], pollIntervalMs: 500, pollTimeoutMs: 5000 });
function legacy(): CustomProviderConfig {
  return { id: 'workflow-connection', label: 'Connection', apiStyle: 'comfyui', baseUrl: 'http://127.0.0.1:8188', apiKey: '', models: ['saved-old-model'], supportsWebSearch: false,
    extraParams: { auth: { mode: 'none' }, comfyui: config() } };
}
beforeEach(async () => {
  vi.stubGlobal('localStorage', storage); values.clear();
  useCustomProvidersStore.persist.setOptions({ storage: createJSONStorage(() => storage) });
  await useCustomProvidersStore.getState().replaceAll([]);
});
afterEach(async () => { await useCustomProvidersStore.getState().replaceAll([]); vi.unstubAllGlobals(); });

describe('ComfyUI workflow collection persistence', () => {
  it('hydrates an old single workflow without changing its saved model identity', async () => {
    values.set('custom-providers-storage', JSON.stringify({ state: { providers: [legacy()] }, version: 0 }));
    await useCustomProvidersStore.persist.rehydrate();
    const provider = useCustomProvidersStore.getState().providers.find((entry) => entry.id === legacy().id)!;
    expect(provider.models).toEqual(['saved-old-model']);
    expect(provider.extraParams).not.toHaveProperty('comfyui');
    expect(readComfyUIWorkflows(provider)).toEqual({ version: 1, selectedWorkflowId: 'saved-old-model', workflows: [
      { id: 'saved-old-model', name: 'saved-old-model', mediaType: 'image', config: config() },
    ] });
    expect(parseComfyUIConfig(provider, 'saved-old-model').workflow['6'].inputs).toEqual({ text: 'original' });
  });

  it.each([
    { auth: { mode: 'none' } },
    { workflow: { nodes: [], links: [] } },
    { workflow: {} },
  ])('preserves incomplete legacy settings for repair without creating an executable workflow', async (raw) => {
    const original = { ...legacy(), extraParams: { auth: { mode: 'none' }, comfyui: raw } };
    values.set('custom-providers-storage', JSON.stringify({ state: { providers: [original] }, version: 0 }));
    await useCustomProvidersStore.persist.rehydrate();
    const provider = useCustomProvidersStore.getState().providers.find((entry) => entry.id === original.id)!;
    expect(provider.extraParams).toEqual(original.extraParams);
    expect(provider.comfyWorkflows).toBeUndefined();
    expect(() => parseComfyUIConfig(provider)).toThrow();
    await useCustomProvidersStore.getState().addProvider({ ...legacy(), id: 'another-valid-connection' });
    expect(useCustomProvidersStore.getState().providers.find((entry) => entry.id === original.id)?.extraParams).toEqual(original.extraParams);
    const persisted = JSON.parse(values.get('custom-providers-storage')!) as { state: { providers: CustomProviderConfig[] } };
    expect(persisted.state.providers.find((entry) => entry.id === original.id)?.extraParams).toEqual(original.extraParams);
    useCustomProvidersStore.getState().removeProvider(original.id);
    expect(useCustomProvidersStore.getState().providers.some((entry) => entry.id === original.id)).toBe(false);
  });

  it('rejects invalid typed collections before publishing a provider', async () => {
    await useCustomProvidersStore.getState().addProvider(legacy());
    const original = structuredClone(useCustomProvidersStore.getState().providers);
    await expect(useCustomProvidersStore.getState().addProvider({ ...legacy(), id: 'invalid-typed', comfyWorkflows: {
      version: 1, selectedWorkflowId: 'missing', workflows: [],
    } })).rejects.toThrow();
    expect(useCustomProvidersStore.getState().providers).toEqual(original);
  });

  it('preserves independent configs, stable IDs, explicit selection and deletion across reload', async () => {
    const store = useCustomProvidersStore.getState(); await store.addProvider(legacy());
    const secondConfig = config('second');
    const secondId = await store.addComfyWorkflow(legacy().id, { name: 'Second', mediaType: 'video', config: secondConfig });
    secondConfig.workflow['6'].inputs.text = 'mutated caller';
    await store.selectComfyWorkflow(legacy().id, secondId);
    await store.updateComfyWorkflow(legacy().id, 'saved-old-model', { name: 'Renamed', config: config('edited first') });
    let provider = useCustomProvidersStore.getState().providers.find((entry) => entry.id === legacy().id)!;
    expect(resolveComfyUIWorkflow(provider)).toMatchObject({ id: secondId, name: 'Second', config: config('second') });
    expect(parseComfyUIConfig(provider, 'saved-old-model').workflow['6'].inputs).toEqual({ text: 'edited first' });
    expect(parseComfyUIConfig(provider, secondId).mediaType).toBe('video');
    const persisted = values.get('custom-providers-storage')!;
    await store.replaceAll([]); values.set('custom-providers-storage', persisted); await useCustomProvidersStore.persist.rehydrate();
    provider = useCustomProvidersStore.getState().providers.find((entry) => entry.id === legacy().id)!;
    expect(resolveComfyUIWorkflow(provider).id).toBe(secondId);
    await store.removeComfyWorkflow(legacy().id, secondId);
    provider = useCustomProvidersStore.getState().providers.find((entry) => entry.id === legacy().id)!;
    expect(readComfyUIWorkflows(provider).selectedWorkflowId).toBe('saved-old-model');
    expect(provider.models).toEqual(['saved-old-model']);
    expect(() => resolveComfyUIWorkflow(provider, secondId)).toThrow();
    await store.removeComfyWorkflow(legacy().id, 'saved-old-model');
    provider = useCustomProvidersStore.getState().providers.find((entry) => entry.id === legacy().id)!;
    expect(readComfyUIWorkflows(provider)).toEqual({ version: 1, selectedWorkflowId: null, workflows: [] });
  });

  it('serializes concurrent workflow edits and rejects ambiguous or stale selections', async () => {
    const store = useCustomProvidersStore.getState(); await store.addProvider(legacy());
    await Promise.all(['one', 'two'].map((id) => store.addComfyWorkflow(legacy().id, { id, name: id, mediaType: 'image', config: config(id) })));
    const provider = useCustomProvidersStore.getState().providers.find((entry) => entry.id === legacy().id)!;
    expect(provider.models).toEqual(['saved-old-model', 'one', 'two']);
    await expect(store.addComfyWorkflow(legacy().id, { id: 'one', name: 'Duplicate', mediaType: 'image', config: config() })).rejects.toThrow();
    await expect(store.selectComfyWorkflow(legacy().id, 'deleted')).rejects.toThrow();
    expect(() => resolveComfyUIWorkflow(provider, 'deleted')).toThrow();
  });
});
