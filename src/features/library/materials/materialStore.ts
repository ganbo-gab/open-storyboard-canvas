import { create } from 'zustand';
import { z } from 'zod';
import { createWorkspaceDocument } from '@/features/workbench/application/workspaceDocument';
import type { LocalDocument, LocalStorageStatus } from '@/features/workbench/application/workbenchPersistence';
import { builtInMaterials } from './builtInMaterials';
import { MaterialError, normalizeMaterialOrder, validateMaterialInput, type MaterialEntry, type MaterialInput, type MaterialPatch } from './materials';
import { materialPromptPort, type MaterialPromptPort } from './materialPromptPort';

const entrySchema = z.object({ id: z.string().min(1), kind: z.enum(['style', 'effect', 'cameraMotion', 'preset']), name: z.string().trim().min(1), prompt: z.string().trim().min(1), previewAsset: z.string().optional(), tags: z.array(z.string()), enabled: z.boolean(), order: z.number().finite(), builtIn: z.boolean(), source: z.union([z.object({ type: z.enum(['builtIn', 'custom']) }), z.object({ type: z.enum(['promptPreset', 'promptFavorite', 'promptTemplate']), id: z.string().min(1) })]) });
const metadataSchema = z.object({ name: z.string().trim().min(1).optional(), enabled: z.boolean().optional(), order: z.number().finite().optional(), tags: z.array(z.string()).optional(), previewAsset: z.string().optional() });
const dataSchema = z.object({ ownEntries: z.array(entrySchema), metadata: z.record(z.string(), metadataSchema) });
export type MaterialLibraryData = z.infer<typeof dataSchema>;
const initialData = (): MaterialLibraryData => ({ ownEntries: builtInMaterials(), metadata: {} });
export function normalizeMaterialLibraryData(value: unknown): MaterialLibraryData {
  const parsed = dataSchema.parse(value);
  const seen = new Set<string>();
  parsed.ownEntries = normalizeMaterialOrder(parsed.ownEntries.filter(entry => {
    if (seen.has(entry.id) || !['custom', 'builtIn'].includes(entry.source.type) || entry.kind === 'preset') return false;
    seen.add(entry.id); return true;
  }));
  return parsed;
}
export interface MaterialLibraryState extends MaterialLibraryData {
  entries: MaterialEntry[];
  initialized: boolean;
  storageStatus: LocalStorageStatus;
  initialize(): Promise<void>;
  create(input: MaterialInput): MaterialEntry;
  update(id: string, patch: MaterialPatch): void;
  remove(id: string): void;
  setEnabled(id: string, enabled: boolean): void;
  reorder(ids: string[]): void;
  resetBuiltIn(id?: string): void;
  exportJSON(): string;
  importJSON(json: string): void;
  dispose(): void;
}
/** Projected presets/favorites/function templates never persist duplicate prompt bodies. */
export function createMaterialLibraryStore(document: LocalDocument<MaterialLibraryData>, prompts: MaterialPromptPort = materialPromptPort) {
  let stop = () => {};
  const store = create<MaterialLibraryState>((set, get) => {
    const project = (data: MaterialLibraryData) => normalizeMaterialOrder([
      ...data.ownEntries,
      ...prompts.entries().map((entry, index) => ({ ...entry, order: data.ownEntries.length + index })),
    ].map(entry => ({ ...entry, ...data.metadata[entry.id] })));
    const persist = () => {
      const { ownEntries, metadata } = get();
      if (!get().initialized) throw new MaterialError('invalid-entry', 'Initialize the material library before editing');
      document.save({ ownEntries, metadata });
      set({ entries: project({ ownEntries, metadata }), storageStatus: document.status() });
      const flush = document.flush?.();
      if (flush) void flush.then(
        () => set({ storageStatus: document.status() }),
        () => set({ storageStatus: document.status() }),
      );
    };
    const find = (id: string) => {
      if (!get().initialized) throw new MaterialError('invalid-entry', 'Initialize the material library before editing');
      const entry = get().entries.find(item => item.id === id);
      if (!entry) throw new MaterialError('not-found', `Unknown material ${id}`);
      return entry;
    };
    const patchMetadata = (id: string, patch: z.infer<typeof metadataSchema>) => set(state => ({ metadata: { ...state.metadata, [id]: { ...state.metadata[id], ...patch } } }));
    return {
      ...initialData(), entries: project(initialData()), initialized: false, storageStatus: document.status(),
      async initialize() {
        if (get().initialized) return;
        await document.initialize?.();
        const data = document.load();
        set({ ...data, entries: project(data), initialized: true, storageStatus: document.status() });
      },
      create(input) {
        if (!get().initialized) throw new MaterialError('invalid-entry', 'Initialize the material library before editing');
        const normalized = validateMaterialInput(input);
        const id = crypto.randomUUID();
        const entry: MaterialEntry = { ...normalized, id: input.kind === 'preset' ? `preset:${id}` : `material:${id}`, tags: normalized.tags ?? [], enabled: normalized.enabled ?? true, order: get().entries.length, builtIn: false, source: input.kind === 'preset' ? { type: 'promptPreset', id } : { type: 'custom' } };
        const metadata = { ...get().metadata };
        get().entries.forEach(item => { metadata[item.id] = { ...metadata[item.id], order: item.order }; });
        if (entry.source.type === 'custom') set(state => ({ ownEntries: [...state.ownEntries, entry] }));
        else prompts.upsert(entry);
        metadata[entry.id] = { ...metadata[entry.id], order: entry.order, enabled: entry.enabled, tags: entry.tags, previewAsset: entry.previewAsset };
        set({ metadata });
        persist(); return find(entry.id);
      },
      update(id, patch) {
        const entry = find(id);
        const normalized = validateMaterialInput({ ...entry, ...patch });
        const next = { ...entry, ...normalized };
        if (entry.source.type === 'custom' || entry.source.type === 'builtIn') set(state => ({ ownEntries: state.ownEntries.map(item => item.id === id ? next : item) }));
        else prompts.upsert(next);
        patchMetadata(id, { enabled: next.enabled, tags: next.tags, previewAsset: next.previewAsset, order: next.order, ...(entry.source.type === 'promptTemplate' ? { name: next.name } : {}) });
        persist();
      },
      remove(id) {
        const entry = find(id);
        if (entry.source.type === 'custom' || entry.source.type === 'builtIn') set(state => ({ ownEntries: state.ownEntries.filter(item => item.id !== id) }));
        else if (entry.source.type === 'promptTemplate') patchMetadata(id, { enabled: false });
        else prompts.remove(entry);
        persist();
      },
      setEnabled(id, enabled) { get().update(id, { enabled }); },
      reorder(ids) {
        if (!get().initialized) throw new MaterialError('invalid-entry', 'Initialize the material library before editing');
        const entries = get().entries;
        if (ids.length !== entries.length || new Set(ids).size !== entries.length || ids.some(id => !entries.some(entry => entry.id === id))) throw new MaterialError('invalid-order', 'Order must contain every material exactly once');
        const metadata = { ...get().metadata };
        ids.forEach((id, order) => { metadata[id] = { ...metadata[id], order }; });
        set({ metadata }); persist();
      },
      resetBuiltIn(id) {
        if (!get().initialized) throw new MaterialError('invalid-entry', 'Initialize the material library before editing');
        const seeds = builtInMaterials();
        const targets = id ? [seeds.find(entry => entry.id === id) ?? find(id)] : [...seeds, ...get().entries.filter(entry => entry.source.type === 'promptTemplate')];
        for (const entry of targets) {
          if (!entry.builtIn) continue;
          if (entry.source.type === 'promptTemplate') prompts.reset(entry);
          else {
            const seed = seeds.find(item => item.id === entry.id);
            if (seed) set(state => ({ ownEntries: [...state.ownEntries.filter(item => item.id !== seed.id), seed] }));
          }
          set(state => { const metadata = { ...state.metadata }; delete metadata[entry.id]; return { metadata }; });
        }
        persist();
      },
      exportJSON: () => JSON.stringify({ version: 1, entries: get().entries }, null, 2),
      importJSON(json) {
        if (!get().initialized) throw new MaterialError('invalid-entry', 'Initialize the material library before editing');
        let entries: MaterialEntry[];
        try { entries = z.object({ version: z.literal(1), entries: z.array(entrySchema) }).parse(JSON.parse(json)).entries; }
        catch { throw new MaterialError('invalid-import', 'Invalid material library JSON'); }
        if (new Set(entries.map(entry => entry.id)).size !== entries.length) throw new MaterialError('invalid-import', 'Duplicate material ids');
        // Foreign canonical-source ids are imported as local presets, never as dangling favorites/templates.
        for (const entry of entries) {
          const existing = get().entries.find(item => item.id === entry.id);
          let importedId = entry.id;
          if (existing) get().update(existing.id, entry);
          else if (entry.kind === 'preset' && entry.source.type === 'promptPreset') {
            prompts.upsert(entry);
          } else if (entry.kind === 'preset') importedId = get().create(entry).id;
          else set(state => ({ ownEntries: [...state.ownEntries, { ...entry, builtIn: false, source: { type: 'custom' } }] }));
          patchMetadata(importedId, { order: entry.order, enabled: entry.enabled, tags: entry.tags, previewAsset: entry.previewAsset });
          persist();
        }
      },
      dispose: () => stop(),
    };
  });
  stop = prompts.subscribe(() => { const state = store.getState(); const entries = normalizeMaterialOrder([...state.ownEntries, ...prompts.entries().map((entry, index) => ({ ...entry, order: state.ownEntries.length + index }))].map(entry => ({ ...entry, ...state.metadata[entry.id] }))); store.setState({ entries }); });
  return store;
}
const document = createWorkspaceDocument<MaterialLibraryData>('storyboard-copilot:materials:v1', initialData, normalizeMaterialLibraryData);
export const useMaterialLibraryStore = createMaterialLibraryStore(document);
export const selectEnabledMaterials = (state: MaterialLibraryState) => state.entries.filter(entry => entry.enabled);
