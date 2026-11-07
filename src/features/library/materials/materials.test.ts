// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalDocument } from '@/features/workbench/application/workbenchPersistence';
import { useSettingsStore } from '@/stores/settingsStore';
import { builtInMaterials } from './builtInMaterials';
import { applyMaterialToPrompt, MaterialError, migratePromptPresets } from './materials';
import { createMaterialLibraryStore, normalizeMaterialLibraryData, type MaterialLibraryData } from './materialStore';

const originalSettings = useSettingsStore.getState();
const disposers: (() => void)[] = [];
afterEach(() => { disposers.splice(0).forEach(dispose => dispose()); useSettingsStore.setState(originalSettings, true); });
function fixture() {
  const values = new Map<string, string>();
  const document = createLocalDocument<MaterialLibraryData>('materials-test', () => ({ ownEntries: builtInMaterials(), metadata: {} }), normalizeMaterialLibraryData,
    { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } });
  const store = createMaterialLibraryStore(document); disposers.push(store.getState().dispose);
  return { store, document };
}
describe('material management', () => {
  it('maintains CRUD, exact order, enable flags and clean prompt composition', async () => {
    const { store } = fixture(); await store.getState().initialize();
    const entry = store.getState().create({ kind: 'style', name: '  暖光 ', prompt: ' 自然暖色光 ', tags: ['光', '光', ' '] });
    expect(entry).toMatchObject({ name: '暖光', prompt: '自然暖色光', tags: ['光'], enabled: true });
    expect(store.getState().entries.at(-1)?.id).toBe(entry.id);
    const ids = store.getState().entries.map(item => item.id).reverse(); store.getState().reorder(ids);
    store.getState().setEnabled(entry.id, false);
    expect(store.getState().entries.map(item => item.id)).toEqual(ids);
    expect(store.getState().entries.map(item => item.order)).toEqual(ids.map((_, index) => index));
    const disabled = store.getState().entries.find(item => item.id === entry.id)!;
    expect(applyMaterialToPrompt('  主体\r\n动作 ', disabled)).toBe('主体\n动作');
    store.getState().update(entry.id, { enabled: true, prompt: '柔和暖光' });
    const enabled = store.getState().entries.find(item => item.id === entry.id)!;
    expect(applyMaterialToPrompt('主体', enabled)).toBe('主体\n\n柔和暖光');
    expect(applyMaterialToPrompt(applyMaterialToPrompt('主体', enabled), enabled)).toBe('主体\n\n柔和暖光');
    const before = store.getState().entries;
    expect(() => store.getState().update(entry.id, { prompt: ' ' })).toThrow(MaterialError);
    expect(() => store.getState().reorder([entry.id, entry.id])).toThrow(MaterialError);
    expect(store.getState().entries).toBe(before);
    store.getState().remove(entry.id);
    expect(store.getState().entries.some(item => item.id === entry.id)).toBe(false);
    expect(store.getState().entries.map(item => item.order)).toEqual(store.getState().entries.map((_, index) => index));
  });
  it('resets edited and deleted built-ins to useful original text', async () => {
    const { store } = fixture(); await store.getState().initialize(); const first = builtInMaterials()[0];
    store.getState().update(first.id, { prompt: '自定义覆盖', enabled: false });
    store.getState().resetBuiltIn(first.id);
    expect(store.getState().entries.find(item => item.id === first.id)).toMatchObject({ prompt: first.prompt, enabled: true });
    store.getState().remove(first.id); store.getState().resetBuiltIn(first.id);
    expect(store.getState().entries.find(item => item.id === first.id)?.prompt).toBe(first.prompt);
    expect(builtInMaterials().filter(item => item.kind === 'cameraMotion')).toHaveLength(12);
  });
  it('migrates legacy presets without duplicating canonical content or breaking existing settings callers', async () => {
    const presets = [{ id: 'legacy', name: ' 镜头 ', prompt: ' 缓慢推近 ', createdAt: 1, updatedAt: 2 }];
    expect(migratePromptPresets([...presets, ...presets, { id: 'broken', prompt: '' }, null])).toMatchObject([{ id: 'preset:legacy', name: '镜头', prompt: '缓慢推近', source: { type: 'promptPreset', id: 'legacy' } }]);
    useSettingsStore.setState({ promptPresets: presets });
    const { store, document } = fixture(); await store.getState().initialize();
    store.getState().update('preset:legacy', { name: '推镜', prompt: '平稳推镜', enabled: false });
    expect(useSettingsStore.getState().promptPresets[0]).toMatchObject({ id: 'legacy', name: '推镜', prompt: '平稳推镜', createdAt: 1 });
    expect(document.load().ownEntries.every(item => item.kind !== 'preset')).toBe(true);
    expect(document.load().metadata['preset:legacy'].enabled).toBe(false);
    useSettingsStore.getState().updatePromptPreset('legacy', { prompt: '从旧设置修改' });
    expect(store.getState().entries.find(item => item.id === 'preset:legacy')).toMatchObject({ prompt: '从旧设置修改', enabled: false });
    store.getState().remove('preset:legacy');
    expect(useSettingsStore.getState().promptPresets).toEqual([]);
  });
  it('round-trips custom JSON and rejects malformed input before changes', async () => {
    const { store } = fixture(); await store.getState().initialize();
    const entry = store.getState().create({ kind: 'effect', name: '逆光', prompt: '金色逆光，保留高光细节', enabled: false });
    const json = store.getState().exportJSON(); store.getState().remove(entry.id); store.getState().importJSON(json);
    expect(store.getState().entries.find(item => item.id === entry.id)).toMatchObject({ name: '逆光', prompt: entry.prompt, enabled: false });
    const before = store.getState().entries;
    expect(() => store.getState().importJSON('{"version":2,"entries":[]}')).toThrow(MaterialError);
    expect(store.getState().entries).toBe(before);
  });
});
