import type { LocalStorageStatus } from '@/features/workbench/application/workbenchPersistence';

/** References own no media bytes or display/blob URLs. */
export interface CharacterAssetRef { assetId: string }
export type CharacterVoice =
  | { kind: 'none' }
  | { kind: 'sample'; sampleAssetId: string }
  | { kind: 'provider'; providerId: string; voiceId: string };
export interface CharacterSource {
  kind: 'canvasNode' | 'asset' | 'upload';
  id: string;
}
export interface Character {
  id: string;
  name: string;
  mainImage: CharacterAssetRef | null;
  images: CharacterAssetRef[];
  tags: string[];
  description?: string;
  voice?: CharacterVoice;
  source?: CharacterSource;
  createdAt: number;
  updatedAt: number;
}
export interface CharacterLibraryData { characters: Character[] }
export interface CharacterNormalizationIssue {
  index: number | null;
  characterId?: string;
  field: string;
  reason: string;
  action: 'dropped' | 'repaired';
}
export interface CharacterNormalizationResult extends CharacterLibraryData {
  issues: CharacterNormalizationIssue[];
}
export interface CharacterQuery { search?: string; tags?: readonly string[] }
export interface CreateCharacterInput {
  name: string;
  images?: readonly CharacterAssetRef[];
  mainImage?: CharacterAssetRef | null;
  tags?: readonly string[];
  description?: string;
  voice?: CharacterVoice;
  source?: CharacterSource;
}
export interface UpdateCharacterInput {
  name?: string;
  description?: string | null;
  voice?: CharacterVoice | null;
}
export interface CanvasCharacterImageNode {
  id: string;
  imageUrl?: string | null;
  assetId?: string | null;
  prompt?: string;
}
export interface CharacterLibrarySnapshot extends CharacterLibraryData {
  issues: CharacterNormalizationIssue[];
  storageStatus: LocalStorageStatus;
}
export const characterVoiceCapability = {
  voiceCloneAvailable: false,
  reason: 'No voice-clone provider adapter is configured. Only sample and provider references can be saved.',
  reasonKey: 'characters.voiceCloneUnavailable',
} as const;
