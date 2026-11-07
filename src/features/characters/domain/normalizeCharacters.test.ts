import { describe, expect, it } from 'vitest';
import { normalizeCharacterLibrary } from './normalizeCharacters';

describe('character persisted-data normalization', () => {
  it('migrates keyed legacy ids, ordered string refs, main-only images and ISO dates', () => {
    const result = normalizeCharacterLibrary({ characters: { hero: {
      name: ' Hero ', imageAssetIds: ['side', 'back'], mainImageAssetId: 'front', tags: [' lead ', 'lead'],
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z',
      voice: { kind: 'provider', providerId: ' configured ', voiceId: ' actor ' },
    } } });
    expect(result.characters).toEqual([{ id: 'hero', name: 'Hero', images: [{ assetId: 'front' }, { assetId: 'side' }, { assetId: 'back' }],
      mainImage: { assetId: 'front' }, tags: ['lead'], createdAt: Date.parse('2026-01-01T00:00:00.000Z'), updatedAt: Date.parse('2026-01-01T00:00:00.000Z'),
      voice: { kind: 'provider', providerId: 'configured', voiceId: 'actor' } }]);
    expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'mainImage', action: 'repaired' }), expect.objectContaining({ field: 'updatedAt', action: 'repaired' })]));
  });
  it('drops malformed rows and duplicate ids individually while retaining valid siblings and diagnostic reasons', () => {
    const result = normalizeCharacterLibrary([
      null, { id: 'blank', name: ' ' }, { id: 'bad-date', name: 'Bad', createdAt: Number.NaN },
      { id: 'hero', name: 'Hero', images: [{ assetId: 'good' }], tags: [] },
      { id: 'hero', name: 'Duplicate' }, { id: 'array', name: 'Bad', images: {} },
    ]);
    expect(result.characters).toHaveLength(1);
    expect(result.characters[0]).toMatchObject({ id: 'hero', mainImage: { assetId: 'good' }, createdAt: 0, updatedAt: 0 });
    expect(result.issues).toHaveLength(5);
    expect(result.issues.every((issue) => issue.reason && issue.action === 'dropped')).toBe(true);
  });
  it('never persists a URL as an asset id and drops invalid optional data with reasons', () => {
    const result = normalizeCharacterLibrary([{ id: 'c', name: 'C', images: ['blob:old', 'data:image/png,x', 'https://example.test/a.png', { assetId: 'ok' }, 'ok'],
      mainImage: 'file:///tmp/a.png', tags: ['valid', null, ''], voice: { kind: 'sample', sampleAssetId: 'blob:voice' }, source: { kind: 'unknown', id: 'x' }, description: 12 }]);
    expect(result.characters[0]).toEqual({ id: 'c', name: 'C', images: [{ assetId: 'ok' }], mainImage: { assetId: 'ok' }, tags: ['valid'], createdAt: 0, updatedAt: 0 });
    expect(result.issues.map((issue) => issue.field)).toEqual(expect.arrayContaining(['images', 'mainImage', 'tags', 'voice', 'source', 'description']));
  });
  it.each([undefined, null, false, 13, 'broken', {}, { characters: null }])('does not crash on malformed root %j', (input) => {
    expect(normalizeCharacterLibrary(input)).toMatchObject({ characters: [], issues: [expect.objectContaining({ index: null, action: 'dropped' })] });
  });
  it('preserves empty image libraries and converges to an idempotent canonical form', () => {
    const result = normalizeCharacterLibrary([{ id: 'empty', name: 'Empty', images: [], mainImage: null, voice: { kind: 'none' } }]);
    expect(result.characters[0].mainImage).toBeNull();
    expect(normalizeCharacterLibrary({ characters: result.characters })).toEqual({ characters: result.characters, issues: [] });
  });
});
