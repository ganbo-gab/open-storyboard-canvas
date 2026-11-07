import { create } from 'zustand';
import type { LocalStorageStatus } from '@/features/workbench/application/workbenchPersistence';
import { CharacterLibrary, CharacterLibraryError, type CharacterFromImageInput, type CharacterLibraryErrorCode } from '../application/characterLibrary';
import { characterLibrary } from '../application/characterLibraryService';
import type { CanvasCharacterImageNode, Character, CharacterNormalizationIssue, CharacterQuery, CreateCharacterInput, UpdateCharacterInput } from '../domain/types';

export interface CharacterStoreError {
  code: CharacterLibraryErrorCode | 'unknown';
  message: string;
  messageKey: string;
}
export interface CharacterLibraryState {
  characters: Character[];
  selectedId: string | null;
  query: CharacterQuery;
  initialized: boolean;
  loading: boolean;
  pendingCount: number;
  error: CharacterStoreError | null;
  issues: CharacterNormalizationIssue[];
  storageStatus: LocalStorageStatus;
  initialize(): Promise<boolean>;
  refresh(): Promise<boolean>;
  select(id: string | null): void;
  setQuery(query: CharacterQuery): void;
  clearError(): void;
  createCharacter(input: CreateCharacterInput): Promise<Character | null>;
  createFromAsset(assetId: string, input?: CharacterFromImageInput): Promise<Character | null>;
  createFromCanvasImageNode(node: CanvasCharacterImageNode, input?: CharacterFromImageInput): Promise<Character | null>;
  updateCharacter(id: string, input: UpdateCharacterInput): Promise<Character | null>;
  deleteCharacter(id: string): Promise<boolean>;
  addImage(id: string, assetId: string): Promise<Character | null>;
  removeImage(id: string, assetId: string): Promise<Character | null>;
  reorderImages(id: string, assetIds: readonly string[]): Promise<Character | null>;
  setMainImage(id: string, assetId: string): Promise<Character | null>;
  setTags(id: string, tags: readonly string[]): Promise<Character | null>;
  addTag(id: string, tag: string): Promise<Character | null>;
  removeTag(id: string, tag: string): Promise<Character | null>;
}
export function createCharacterLibraryStore(service: CharacterLibrary = characterLibrary) {
  return create<CharacterLibraryState>((set, get) => {
    let initializing: Promise<boolean> | undefined;
    const refreshSnapshot = async () => {
      const snapshot = await service.snapshot();
      set((state) => ({ ...snapshot, initialized: true,
        selectedId: snapshot.characters.some((character) => character.id === state.selectedId) ? state.selectedId : null }));
    };
    const captureError = (error: unknown) => {
      const code = error instanceof CharacterLibraryError ? error.code : 'unknown';
      set({ error: { code, messageKey: `characters.errors.${code}`, message: error instanceof Error ? error.message : 'Character operation failed' } });
    };
    const run = async <T>(operation: () => Promise<T>): Promise<T | null> => {
      set((state) => ({ pendingCount: state.pendingCount + 1, error: null }));
      try {
        const result = await operation();
        await refreshSnapshot();
        return result;
      } catch (error) {
        // Storage failures may leave session-only state. Surface it with its explicit status,
        // but never report the mutation as durably successful.
        try { await refreshSnapshot(); } catch { /* Preserve the original failure. */ }
        captureError(error);
        return null;
      } finally { set((state) => ({ pendingCount: state.pendingCount - 1 })); }
    };
    const createAndSelect = async (operation: () => Promise<Character>) => {
      const character = await run(operation);
      if (character) set({ selectedId: character.id });
      return character;
    };
    return {
      characters: [], selectedId: null, query: {}, initialized: false, loading: false,
      pendingCount: 0, error: null, issues: [], storageStatus: { mode: 'persistent' },
      initialize() {
        if (get().initialized) return Promise.resolve(true);
        if (!initializing) initializing = get().refresh().finally(() => { initializing = undefined; });
        return initializing;
      },
      async refresh() {
        set({ loading: true, error: null });
        try { await refreshSnapshot(); return true; }
        catch (error) { captureError(error); return false; }
        finally { set({ loading: false }); }
      },
      select(id) { set((state) => ({ selectedId: id !== null && state.characters.some((character) => character.id === id) ? id : null })); },
      setQuery(query) { set({ query: { ...query, ...(query.tags ? { tags: [...query.tags] } : {}) } }); },
      clearError() { set({ error: null }); },
      createCharacter: (input) => createAndSelect(() => service.create(input)),
      createFromAsset: (assetId, input) => createAndSelect(() => service.createFromAsset(assetId, input)),
      createFromCanvasImageNode: (node, input) => createAndSelect(() => service.createFromCanvasImageNode(node, input)),
      updateCharacter: (id, input) => run(() => service.update(id, input)),
      async deleteCharacter(id) { return (await run(async () => { await service.delete(id); return true; })) === true; },
      addImage: (id, assetId) => run(() => service.addImage(id, assetId)),
      removeImage: (id, assetId) => run(() => service.removeImage(id, assetId)),
      reorderImages: (id, assetIds) => run(() => service.reorderImages(id, assetIds)),
      setMainImage: (id, assetId) => run(() => service.setMainImage(id, assetId)),
      setTags: (id, tags) => run(() => service.setTags(id, tags)),
      addTag: (id, tag) => run(() => service.addTag(id, tag)),
      removeTag: (id, tag) => run(() => service.removeTag(id, tag)),
    };
  });
}
export const useCharacterLibraryStore = createCharacterLibraryStore();
