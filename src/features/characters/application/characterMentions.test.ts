import { describe, expect, it } from 'vitest';
import type { Character } from '../domain/types';
import { getCharacterMentionOptions } from './characterMentions';
import { insertReferenceToken, findReferenceTokens } from '@/features/canvas/application/referenceTokenEditing';

const characters: Character[] = [
  { id: 'alice', name: 'Alice', images: [{ assetId: 'front' }], mainImage: { assetId: 'front' }, tags: ['Lead'], createdAt: 1, updatedAt: 1 },
  { id: 'bob', name: 'Bob', images: [{ assetId: 'side' }], mainImage: { assetId: 'side' }, tags: ['Support'], createdAt: 1, updatedAt: 1 },
  { id: 'empty', name: 'Empty', images: [], mainImage: null, tags: [], createdAt: 1, updatedAt: 1 },
];
const references = [{ label: 'Landscape', token: '@图2' }, { label: 'Lead text', token: '@文本1' }];
describe('character mention provider', () => {
  it('places selectable characters first with display labels, thumbnail refs and existing image-token syntax', () => {
    const options = getCharacterMentionOptions(characters, references);
    expect(options).toEqual([
      { kind: 'character', characterId: 'alice', label: 'Alice', thumbnail: { assetId: 'front' }, assetId: 'front', token: '@图3' },
      { kind: 'character', characterId: 'bob', label: 'Bob', thumbnail: { assetId: 'side' }, assetId: 'side', token: '@图4' },
      ...references,
    ]);
    const inserted = insertReferenceToken('Portrait', 8, options[0].token);
    expect(findReferenceTokens(inserted.nextText)).toMatchObject([{ token: '@图3', prefix: '图' }]);
  });
  it('filters by query/name/tag without changing assigned insertion tokens and keeps characters before matching references', () => {
    expect(getCharacterMentionOptions(characters, references, '@SUPPORT')).toEqual([expect.objectContaining({ characterId: 'bob', token: '@图4' })]);
    expect(getCharacterMentionOptions(characters, references, 'lead')).toEqual([expect.objectContaining({ characterId: 'alice' }), references[1]]);
    expect(getCharacterMentionOptions(characters, references, 'missing')).toEqual([]);
  });
  it('reuses already attached asset tokens rather than colliding with existing references', () => {
    expect(getCharacterMentionOptions(characters, references, '', { front: '@图1' }).map((option) => option.token)).toEqual(['@图1', '@图3', '@图2', '@文本1']);
  });
});
