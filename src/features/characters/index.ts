export type {
  CanvasCharacterImageNode, Character, CharacterAssetRef, CharacterLibraryData, CharacterLibrarySnapshot,
  CharacterNormalizationIssue, CharacterNormalizationResult, CharacterQuery, CharacterSource, CharacterVoice,
  CreateCharacterInput, UpdateCharacterInput,
} from './domain/types';
export { characterVoiceCapability } from './domain/types';
export { isCharacterAssetId, normalizeCharacterLibrary, normalizeCharacterVoice } from './domain/normalizeCharacters';
export { CharacterLibrary, CharacterLibraryError, filterCharacters } from './application/characterLibrary';
export type { CharacterAssetPort, CharacterFromImageInput, CharacterLibraryDependencies, CharacterLibraryErrorCode } from './application/characterLibrary';
export { characterLibrary, createCharacterDocument, CHARACTER_LIBRARY_STORAGE_KEY } from './application/characterLibraryService';
export { buildCharacterCanvasCommand, createCharacterCanvasCommand } from './application/characterCanvas';
export { getCharacterMentionOptions } from './application/characterMentions';
export type { CharacterMention, ExistingMention } from './application/characterMentions';
export { createCharacterLibraryStore, useCharacterLibraryStore } from './store/characterLibraryStore';
export type { CharacterLibraryState, CharacterStoreError } from './store/characterLibraryStore';
export { useCharacters, useSelectedCharacter, useCharacterMentions } from './store/useCharacters';
