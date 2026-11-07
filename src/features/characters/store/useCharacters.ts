import { useEffect, useMemo } from 'react';
import { filterCharacters } from '../application/characterLibrary';
import { getCharacterMentionOptions, type ExistingMention } from '../application/characterMentions';
import type { Character, CharacterQuery } from '../domain/types';
import { useCharacterLibraryStore } from './characterLibraryStore';

const allCharactersQuery: CharacterQuery = {};
export function useCharacters(query?: CharacterQuery): Character[] {
  const characters = useCharacterLibraryStore((state) => state.characters);
  const storedQuery = useCharacterLibraryStore((state) => state.query);
  const initialize = useCharacterLibraryStore((state) => state.initialize);
  useEffect(() => { void initialize(); }, [initialize]);
  return useMemo(() => filterCharacters(characters, query ?? storedQuery), [characters, query, storedQuery]);
}
export function useSelectedCharacter(): Character | null {
  return useCharacterLibraryStore((state) => state.characters.find((character) => character.id === state.selectedId) ?? null);
}
export function useCharacterMentions<T extends ExistingMention>(references: readonly T[], query = '', assetTokens: Readonly<Record<string, string>> = {}) {
  const characters = useCharacters(allCharactersQuery);
  return useMemo(() => getCharacterMentionOptions(characters, references, query, assetTokens), [characters, references, query, assetTokens]);
}
