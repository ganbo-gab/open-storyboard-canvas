import { createWorkspaceDocument } from '@/features/workbench/application/workspaceDocument';
import { persistAssetMedia } from '@/features/assets/application/assetMediaStorage';
import { resolveAsset, saveAsset } from '@/features/assets/application/assetCatalog';
import { isDurableCanvasImageSource } from '@/features/canvas/domain/canvasMediaSources';
import { normalizeCharacterLibrary } from '../domain/normalizeCharacters';
import type { CharacterLibraryData, CharacterNormalizationIssue } from '../domain/types';
import { CharacterLibrary, CharacterLibraryError } from './characterLibrary';

export const CHARACTER_LIBRARY_STORAGE_KEY = 'storyboard-copilot:character-library:v1';
export function createCharacterDocument(key = CHARACTER_LIBRARY_STORAGE_KEY) {
  let issues: CharacterNormalizationIssue[] = [];
  const document = createWorkspaceDocument<CharacterLibraryData>(key, () => ({ characters: [] }), (input) => {
    const normalized = normalizeCharacterLibrary(input);
    issues = normalized.issues;
    return { characters: normalized.characters };
  });
  return { document, normalizationIssues: () => issues };
}
const persistence = createCharacterDocument();
export const characterLibrary = new CharacterLibrary({ ...persistence, assets: {
  resolveAsset,
  async saveAsset(input) {
    // The existing save path owns media persistence. Download remote inputs first even for
    // uploaded/canvas origins, so a character never depends on an expiring provider URL.
    const source = await persistAssetMedia(input.source, true, input.kind === 'text' ? undefined : input.kind);
    if (input.kind === 'image' && !isDurableCanvasImageSource(source)) {
      throw new CharacterLibraryError('mediaNotDurable', 'Image import did not produce a durable media source');
    }
    return await saveAsset({ ...input, source });
  },
} });
