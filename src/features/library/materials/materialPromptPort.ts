import { useSettingsStore } from '@/stores/settingsStore';
import { usePromptLibraryStore } from '@/stores/promptLibraryStore';
import { PROMPT_TEMPLATE_DEFINITIONS, isPromptTemplateId, resolvePromptTemplateText } from '@/features/canvas/application/promptTemplates';
import { MaterialError, migratePromptPresets, type MaterialEntry } from './materials';

/** Adapter, not a mirror: prompt content remains owned by its existing settings/library store. */
export interface MaterialPromptPort {
  entries(): MaterialEntry[];
  upsert(entry: MaterialEntry): void;
  remove(entry: MaterialEntry): void;
  reset(entry: MaterialEntry): void;
  subscribe(listener: () => void): () => void;
}
export const materialPromptPort: MaterialPromptPort = {
  entries() {
    const settings = useSettingsStore.getState();
    const presets = migratePromptPresets(settings.promptPresets);
    const favorites: MaterialEntry[] = Object.values(usePromptLibraryStore.getState().favoritePrompts).map((entry, order) => ({
      id: `favorite:${entry.id}`, kind: 'preset', name: entry.title, prompt: entry.prompt,
      previewAsset: entry.coverUrl || undefined, tags: [...entry.tags], enabled: true, order: presets.length + order,
      builtIn: false, source: { type: 'promptFavorite', id: entry.id },
    }));
    const templates: MaterialEntry[] = PROMPT_TEMPLATE_DEFINITIONS.map((definition, order) => ({
      id: `template:${definition.id}`, kind: 'preset', name: definition.id, prompt: resolvePromptTemplateText(definition.id, settings),
      tags: [definition.scope], enabled: true, order: presets.length + favorites.length + order,
      builtIn: true, source: { type: 'promptTemplate', id: definition.id },
    }));
    return [...presets, ...favorites, ...templates];
  },
  upsert(entry) {
    const source = entry.source;
    if (source.type === 'promptPreset') {
      useSettingsStore.setState(state => {
        const existing = state.promptPresets.find(preset => preset.id === source.id);
        if (!existing && state.promptPresets.length >= 200) throw new MaterialError('invalid-entry', 'Prompt preset limit reached (200)');
        const now = Date.now();
        const preset = { id: source.id, name: entry.name, prompt: entry.prompt, createdAt: existing?.createdAt ?? now, updatedAt: now };
        return { promptPresets: existing ? state.promptPresets.map(item => item.id === source.id ? preset : item) : [...state.promptPresets, preset] };
      });
    } else if (source.type === 'promptFavorite') {
      const store = usePromptLibraryStore.getState();
      const existing = store.favoritePrompts[source.id];
      if (existing) store.addFavorite({ ...existing, title: entry.name, prompt: entry.prompt, tags: entry.tags, coverUrl: entry.previewAsset ?? '', updatedAt: new Date().toISOString() });
    } else if (source.type === 'promptTemplate' && isPromptTemplateId(source.id)) {
      useSettingsStore.getState().setPromptTemplateOverride(source.id, entry.prompt);
    }
  },
  remove(entry) {
    const source = entry.source;
    if (source.type === 'promptPreset') useSettingsStore.getState().deletePromptPreset(source.id);
    if (source.type === 'promptFavorite') usePromptLibraryStore.getState().removeFavorite(source.id);
    // Functional templates cannot be removed from generation assemblers; the library can unlist them.
  },
  reset(entry) {
    if (entry.source.type === 'promptTemplate' && isPromptTemplateId(entry.source.id)) useSettingsStore.getState().resetPromptTemplate(entry.source.id);
  },
  subscribe(listener) {
    const stopSettings = useSettingsStore.subscribe(listener);
    const stopLibrary = usePromptLibraryStore.subscribe(listener);
    return () => { stopSettings(); stopLibrary(); };
  },
};
