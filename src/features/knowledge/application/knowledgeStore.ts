import { create, type StoreApi, type UseBoundStore } from 'zustand';
import { useSettingsStore } from '@/stores/settingsStore';
import { KnowledgeService, startKnowledgePolling, type KnowledgeServiceOptions } from './knowledgeService';
import { chooseKnowledgeVault, resolveLocalKnowledgeMedia, tauriKnowledgeIO } from '../infrastructure/tauriKnowledgeIO';
import { asKnowledgeError, assertVaultRoot, KnowledgeError, type IngestProgress, type KnowledgeIngestInput, type KnowledgeIngestResult, type KnowledgeSearchResult, type VaultEntry, type VaultNote } from '../domain/types';
import type { KnowledgeAttachment, KnowledgeAttachmentContent, KnowledgeAttachmentImport } from '../domain/attachments';
import type { KnowledgeBacklink } from '../domain/search';
import type { KnowledgeModelPort, OrganizeKind, OrganizeResult } from '../domain/organize';
import type { KnowledgeVaultIO } from './ports';

export interface KnowledgeState {
  status: 'unset' | 'loading' | 'ready' | 'error';
  vaultPath: string | null;
  tree: VaultEntry[];
  trashEntries: VaultEntry[];
  activeNote: VaultNote | null;
  searchQuery: string;
  searchResults: KnowledgeSearchResult[];
  tags: string[];
  backlinks: KnowledgeBacklink[];
  ingestProgress: IngestProgress | null;
  organizing: boolean;
  error: KnowledgeError | null;
  /** Omitted/undefined reopens saved authorization; a string authorizes selection/create; null durably unsets it. */
  initialize(root?: string | null): Promise<void>;
  chooseVault(): Promise<void>;
  refresh(force?: boolean): Promise<void>;
  openNote(path: string): Promise<void>;
  saveNote(content: string): Promise<void>;
  createNote(title: string, content?: string, folder?: string): Promise<string>;
  rename(from: string, to: string): Promise<void>;
  trash(path: string): Promise<string>;
  refreshTrash(): Promise<void>;
  restore(trashPath: string, destination?: string): Promise<void>;
  setSearchQuery(query: string): void;
  ingest(input: KnowledgeIngestInput): Promise<KnowledgeIngestResult>;
  listAttachments(folder?: string): Promise<KnowledgeAttachment[]>;
  importAttachment(input: KnowledgeAttachmentImport): Promise<KnowledgeAttachment>;
  readAttachment(path: string): Promise<KnowledgeAttachmentContent>;
  removeAttachment(path: string): Promise<string>;
  organize(kind: OrganizeKind, paths: string[], model?: KnowledgeModelPort): Promise<OrganizeResult>;
  clearError(): void;
  startPolling(intervalMs?: number): () => void;
  getService(): KnowledgeService;
}
export interface KnowledgeStoreDependencies {
  io: KnowledgeVaultIO;
  chooseVault(): Promise<string | null>;
  getVaultPath(): string | null;
  setVaultPath(path: string | null): void;
  serviceOptions?: KnowledgeServiceOptions;
}
export type KnowledgeStore = UseBoundStore<StoreApi<KnowledgeState>>;
export function createKnowledgeStore(deps: KnowledgeStoreDependencies): KnowledgeStore {
  let service: KnowledgeService | undefined;
  let generation = 0;
  let openingNote = 0;
  return create<KnowledgeState>((set, get) => {
    const requireService = (): KnowledgeService => {
      if (!service) throw new KnowledgeError('VAULT_UNSET', 'Choose a knowledge vault first');
      return service;
    };
    const sync = (tree: VaultEntry[], kb: KnowledgeService): void => {
      if (kb !== service) return;
      const activePath = get().activeNote?.path;
      set({ tree, tags: kb.tags(), backlinks: activePath ? kb.backlinks(activePath) : [], searchResults: kb.search(get().searchQuery), status: 'ready' });
    };
    const syncActive = async (tree: VaultEntry[], kb: KnowledgeService): Promise<void> => {
      if (service !== kb) return;
      const active = get().activeNote;
      if (active && !tree.some(entry => entry.path === active.path)) set({ activeNote: null, backlinks: [] });
      else if (active) { const note = await kb.read(active.path); if (service === kb && get().activeNote?.path === active.path) set({ activeNote: note }); }
    };
    const attempt = async <T>(operation: () => Promise<T>): Promise<T> => {
      const current = generation;
      set({ error: null });
      try { return await operation(); }
      catch (error) { const normalized = asKnowledgeError(error); if (current === generation) set({ error: normalized }); throw normalized; }
    };
    return {
      status: 'unset', vaultPath: null, tree: [], trashEntries: [], activeNote: null, searchQuery: '', searchResults: [], tags: [], backlinks: [], ingestProgress: null, organizing: false, error: null,
      getService: requireService,
      initialize: async explicitRoot => {
        const root = explicitRoot === undefined ? deps.getVaultPath() : explicitRoot;
        if (root !== null) assertVaultRoot(root);
        else deps.setVaultPath(null);
        const current = ++generation;
        openingNote++;
        service = undefined;
        set({ vaultPath: root, status: root ? 'loading' : 'unset', tree: [], trashEntries: [], activeNote: null, searchResults: [], backlinks: [], tags: [], ingestProgress: null, organizing: false, error: null });
        if (!root) return;
        try {
          let canonical = root;
          if (explicitRoot === undefined) await deps.io.openVault(root);
          else canonical = await deps.io.initVault(root);
          assertVaultRoot(canonical);
          const kb = new KnowledgeService(canonical, deps.io, deps.serviceOptions);
          const tree = await kb.refresh();
          if (current !== generation) return;
          if (explicitRoot !== undefined) deps.setVaultPath(canonical);
          service = kb; set({ vaultPath: canonical }); sync(tree, kb);
        } catch (error) {
          if (current !== generation) return;
          const normalized = asKnowledgeError(error); set({ status: 'error', error: normalized }); throw normalized;
        }
      },
      chooseVault: () => attempt(async () => { const root = await deps.chooseVault(); if (root) await get().initialize(root); }),
      refresh: force => attempt(async () => {
        const kb = requireService(); const tree = await kb.refresh(force); sync(tree, kb);
        await syncActive(tree, kb);
      }),
      openNote: path => attempt(async () => {
        const kb = requireService(); const current = generation; const opening = ++openingNote;
        const note = await kb.read(path);
        if (current === generation && opening === openingNote && kb === service) set({ activeNote: note, backlinks: kb.backlinks(path) });
      }),
      saveNote: content => attempt(async () => {
        const active = get().activeNote;
        if (!active) throw new KnowledgeError('INVALID_NOTE', 'Open a note first');
        const kb = requireService(); await kb.write(active.path, content);
        if (service === kb) { if (get().activeNote?.path === active.path) set({ activeNote: { ...active, content } }); sync(await kb.refresh(), kb); }
      }),
      createNote: (title, content = '', folder) => attempt(async () => {
        const kb = requireService(); const path = await kb.createNote(title, content, folder); sync(await kb.refresh(), kb);
        if (kb === service) await get().openNote(path);
        return path;
      }),
      rename: (from, to) => attempt(async () => {
        const kb = requireService(); const active = get().activeNote; await kb.rename(from, to); sync(await kb.refresh(), kb);
        if (kb === service && active && (active.path === from || active.path.startsWith(`${from}/`))) await get().openNote(to + active.path.slice(from.length));
      }),
      trash: path => attempt(async () => {
        const kb = requireService(); const trashPath = await kb.trash(path); sync(await kb.refresh(), kb);
        const active = get().activeNote;
        if (kb === service) {
          if (active && (active.path === path || active.path.startsWith(`${path}/`))) set({ activeNote: null, backlinks: [] });
          await get().refreshTrash();
        }
        return trashPath;
      }),
      refreshTrash: () => attempt(async () => { const kb = requireService(); const entries = await kb.listTrash(); if (kb === service) set({ trashEntries: entries }); }),
      restore: (trashPath, destination) => attempt(async () => {
        const kb = requireService(); await kb.restore(trashPath, destination); sync(await kb.refresh(), kb);
        if (kb === service) await get().refreshTrash();
      }),
      setSearchQuery: searchQuery => set({ searchQuery, searchResults: service?.search(searchQuery) ?? [] }),
      ingest: input => attempt(async () => {
        const kb = requireService();
        set({ ingestProgress: { stage: 'note', completed: 0, total: 1 } });
        try {
          const result = await kb.ingest(input, ingestProgress => { if (kb === service) set({ ingestProgress }); });
          sync(await kb.refresh(), kb);
          if (kb === service) await get().openNote(result.notePath);
          return result;
        } catch (error) { if (kb === service) set({ ingestProgress: null }); throw error; }
      }),
      listAttachments: folder => attempt(() => requireService().listAttachments(folder)),
      importAttachment: input => attempt(async () => {
        const kb = requireService(); const attachment = await kb.importAttachment(input); sync(await kb.refresh(), kb); return attachment;
      }),
      readAttachment: path => attempt(() => requireService().readAttachment(path)),
      removeAttachment: path => attempt(async () => {
        const kb = requireService(); const trashPath = await kb.removeAttachment(path); sync(await kb.refresh(), kb);
        if (kb === service) await get().refreshTrash();
        return trashPath;
      }),
      organize: (kind, paths, model) => attempt(async () => {
        const kb = requireService(); set({ organizing: true });
        try { const result = await kb.organize(kind, paths, model); sync(await kb.refresh(), kb); if (kb === service) await get().refresh(); return result; }
        finally { if (kb === service) set({ organizing: false }); }
      }),
      clearError: () => set({ error: null }),
      startPolling: interval => {
        const kb = requireService();
        return startKnowledgePolling(kb, tree => {
          sync(tree, kb);
          void syncActive(tree, kb).catch(error => { if (kb === service) set({ error: asKnowledgeError(error) }); });
        }, error => { if (kb === service) set({ error }); }, interval);
      },
    };
  });
}
export const useKnowledgeStore = createKnowledgeStore({
  io: tauriKnowledgeIO,
  chooseVault: chooseKnowledgeVault,
  getVaultPath: () => useSettingsStore.getState().knowledgeVaultPath,
  setVaultPath: path => useSettingsStore.getState().setKnowledgeVaultPath(path),
  serviceOptions: { resolveMedia: resolveLocalKnowledgeMedia },
});
