import type { Character, CharacterAssetRef } from '../domain/types';

export interface CharacterMention {
  kind: 'character';
  characterId: string;
  label: string;
  thumbnail: CharacterAssetRef;
  assetId: string;
  /** Same numbered image-token syntax consumed by PromptEditor and graphReferenceResolver. */
  token: string;
}
export interface ExistingMention { label: string; token: string }

/**
 * Characters are displayed first, without changing existing reference tokens. Unbound images
 * reserve numbers after existing @图N tokens, before query filtering. The UI must attach the
 * asset to the consumer and insert the resulting actual reference token on selection; the
 * optional mapping reuses tokens for assets already attached to that consumer.
 */
export function getCharacterMentionOptions<T extends ExistingMention>(
  characters: readonly Character[],
  references: readonly T[] = [],
  query = '',
  assetTokens: Readonly<Record<string, string>> = {},
): (CharacterMention | T)[] {
  const search = query.trim().replace(/^@/, '').toLocaleLowerCase();
  let imageNumber = 0;
  for (const token of [...references.map((reference) => reference.token), ...Object.values(assetTokens)]) {
    const match = /^@图(\d+)$/.exec(token);
    if (match && Number.isSafeInteger(Number(match[1]))) imageNumber = Math.max(imageNumber, Number(match[1]));
  }
  const reserved = new Map<string, string>();
  const options: CharacterMention[] = [];
  for (const character of characters) {
    const main = character.mainImage;
    if (!main) continue;
    let token = assetTokens[main.assetId] ?? reserved.get(main.assetId);
    if (!token) { token = `@图${++imageNumber}`; reserved.set(main.assetId, token); }
    if (search && !`${character.name} ${character.tags.join(' ')}`.toLocaleLowerCase().includes(search)) continue;
    options.push({ kind: 'character', characterId: character.id, label: character.name, thumbnail: { ...main }, assetId: main.assetId, token });
  }
  return [...options, ...references.filter((reference) => !search || reference.label.toLocaleLowerCase().includes(search)
    || reference.token.toLocaleLowerCase().includes(search))];
}
