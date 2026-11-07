import type { AssetRecord, saveAsset } from '@/features/assets/application/assetCatalog';
import type { LocalDocument } from '@/features/workbench/application/workbenchPersistence';
import { isDurableCanvasImageSource } from '@/features/canvas/domain/canvasMediaSources';
import { isCharacterAssetId, normalizeCharacterLibrary, normalizeCharacterVoice } from '../domain/normalizeCharacters';
import type {
  CanvasCharacterImageNode, Character, CharacterAssetRef, CharacterLibraryData, CharacterLibrarySnapshot,
  CharacterNormalizationIssue, CharacterQuery, CharacterVoice, CreateCharacterInput, UpdateCharacterInput,
} from '../domain/types';

export type CharacterLibraryErrorCode = 'invalidInput' | 'notFound' | 'assetNotFound' | 'imageRequired' | 'audioRequired' | 'invalidImageOrder' | 'mainImageRequired' | 'mediaNotDurable' | 'storage';
export class CharacterLibraryError extends Error {
  constructor(public readonly code: CharacterLibraryErrorCode, message: string) { super(message); this.name = 'CharacterLibraryError'; }
}
export interface CharacterAssetPort {
  resolveAsset(id: string): Promise<AssetRecord | null>;
  saveAsset: typeof saveAsset;
}
export interface CharacterLibraryDependencies {
  document: LocalDocument<CharacterLibraryData>;
  assets: CharacterAssetPort;
  now?: () => number;
  nextId?: () => string;
  normalizationIssues?: () => readonly CharacterNormalizationIssue[];
}
export type CharacterFromImageInput = Omit<CreateCharacterInput, 'name' | 'images' | 'mainImage' | 'source'> & { name?: string };
export function filterCharacters(characters: readonly Character[], query: CharacterQuery = {}): Character[] {
  const search = query.search?.trim().replace(/^@/, '').toLocaleLowerCase();
  const tags = query.tags?.map((tag) => tag.trim().toLocaleLowerCase()).filter(Boolean) ?? [];
  return characters.filter((character) => (!search || `${character.name} ${character.tags.join(' ')}`.toLocaleLowerCase().includes(search))
    && tags.every((tag) => character.tags.some((item) => item.toLocaleLowerCase() === tag)));
}

/** Serializes global-library writes so independent panels cannot overwrite each other's mutations. */
export class CharacterLibrary {
  private pending: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;
  private readonly nextId: () => string;
  constructor(private readonly dependencies: CharacterLibraryDependencies) {
    this.now = dependencies.now ?? Date.now;
    this.nextId = dependencies.nextId ?? (() => crypto.randomUUID());
  }
  async snapshot(query: CharacterQuery = {}): Promise<CharacterLibrarySnapshot> {
    await this.pending;
    await this.dependencies.document.initialize?.();
    const normalized = normalizeCharacterLibrary(this.dependencies.document.load());
    return { characters: filterCharacters(normalized.characters, query),
      issues: [...(this.dependencies.normalizationIssues?.() ?? []), ...normalized.issues],
      storageStatus: this.dependencies.document.status() };
  }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(async () => { await this.dependencies.document.initialize?.(); return await operation(); });
    this.pending = result.catch(() => undefined);
    return result;
  }
  private async persist(characters: Character[]): Promise<void> {
    try {
      this.dependencies.document.save({ characters });
      await this.dependencies.document.flush?.();
      const status = this.dependencies.document.status();
      if (status.mode === 'memory') throw new Error(status.reason);
    } catch (error) {
      throw new CharacterLibraryError('storage', error instanceof Error ? error.message : 'Character library could not be saved');
    }
  }
  private async assetReference(assetId: string, kind: 'image' | 'audio'): Promise<CharacterAssetRef> {
    if (!isCharacterAssetId(assetId)) throw new CharacterLibraryError('invalidInput', 'A catalogue asset id is required');
    const asset = await this.dependencies.assets.resolveAsset(assetId);
    if (!asset) throw new CharacterLibraryError('assetNotFound', 'The referenced asset was not found');
    if (asset.kind !== kind) throw new CharacterLibraryError(kind === 'image' ? 'imageRequired' : 'audioRequired', `The referenced asset must be ${kind}`);
    if (asset.projectId || asset.id.startsWith('project:') || /^(?:blob:|data:|https?:)/i.test(asset.source)) {
      const imported = await this.dependencies.assets.saveAsset({ name: asset.name, kind, source: asset.source,
        origin: asset.origin, metadata: { ...asset.metadata, characterSourceAssetId: asset.id } });
      if (!isCharacterAssetId(imported.id) || imported.projectId || imported.id.startsWith('project:') || /^(?:blob:|data:)/i.test(imported.source)
        || (kind === 'image' && !isDurableCanvasImageSource(imported.source))) {
        throw new CharacterLibraryError('mediaNotDurable', 'Imported character media must have a durable global asset reference');
      }
      return { assetId: imported.id };
    }
    if (!asset.source.trim() || (kind === 'image' && !isDurableCanvasImageSource(asset.source))) {
      throw new CharacterLibraryError('mediaNotDurable', 'Character media has no durable source');
    }
    return { assetId: asset.id };
  }
  private async voiceReference(voice: CharacterVoice): Promise<CharacterVoice> {
    const normalized = normalizeCharacterVoice(voice);
    if (!normalized) throw new CharacterLibraryError('invalidInput', 'Invalid character voice reference');
    return normalized.kind === 'sample' ? { kind: 'sample', sampleAssetId: (await this.assetReference(normalized.sampleAssetId, 'audio')).assetId } : normalized;
  }
  private async createEntry(input: CreateCharacterInput): Promise<Character> {
    const now = this.now();
    const candidate = normalizeCharacterLibrary([{ ...input, id: this.nextId(), createdAt: now, updatedAt: now }]);
    if (!candidate.characters[0] || candidate.issues.some((issue) => issue.action === 'dropped')) {
      throw new CharacterLibraryError('invalidInput', candidate.issues[0]?.reason ?? 'Invalid character');
    }
    const character = candidate.characters[0];
    if (this.dependencies.document.load().characters.some((entry) => entry.id === character.id)) throw new CharacterLibraryError('invalidInput', 'Duplicate character id');
    const refs = new Map<string, CharacterAssetRef>();
    for (const image of character.images) refs.set(image.assetId, await this.assetReference(image.assetId, 'image'));
    character.images = [...refs.values()];
    character.mainImage = character.mainImage ? refs.get(character.mainImage.assetId) ?? null : null;
    if (character.voice) character.voice = await this.voiceReference(character.voice);
    await this.persist([...this.dependencies.document.load().characters, character]);
    return structuredClone(character);
  }
  create(input: CreateCharacterInput): Promise<Character> { return this.enqueue(() => this.createEntry(input)); }
  createFromAsset(assetId: string, input: CharacterFromImageInput = {}): Promise<Character> {
    return this.enqueue(async () => {
      const asset = await this.dependencies.assets.resolveAsset(assetId);
      if (!asset) throw new CharacterLibraryError('assetNotFound', 'The referenced asset was not found');
      return await this.createEntry({ ...input, name: input.name ?? asset.name, images: [{ assetId }], source: { kind: 'asset', id: assetId } });
    });
  }
  createFromCanvasImageNode(node: CanvasCharacterImageNode, input: CharacterFromImageInput = {}): Promise<Character> {
    return this.enqueue(async () => {
      if (!node.id.trim()) throw new CharacterLibraryError('invalidInput', 'Canvas node id is required');
      const sourceAsset = node.assetId ? await this.dependencies.assets.resolveAsset(node.assetId) : null;
      const name = input.name ?? sourceAsset?.name ?? node.id;
      if (!name.trim() || name.trim().length > 200) throw new CharacterLibraryError('invalidInput', 'Character name must contain 1 to 200 characters');
      let assetId = node.assetId;
      if (!assetId) {
        if (!node.imageUrl?.trim()) throw new CharacterLibraryError('imageRequired', 'The canvas node has no image');
        const asset = await this.dependencies.assets.saveAsset({ name, kind: 'image', source: node.imageUrl,
          origin: 'canvas', nodeId: node.id, metadata: node.prompt ? { sourcePrompt: node.prompt } : {} });
        if (/^(?:blob:|data:)/i.test(asset.source) || asset.projectId || asset.id.startsWith('project:')) {
          throw new CharacterLibraryError('mediaNotDurable', 'Canvas image import did not produce a durable global asset');
        }
        assetId = asset.id;
      }
      return await this.createEntry({ ...input, name, images: [{ assetId }], source: { kind: 'canvasNode', id: node.id } });
    });
  }
  private mutate(id: string, operation: (character: Character) => Promise<Character> | Character): Promise<Character> {
    return this.enqueue(async () => {
      const entries = this.dependencies.document.load().characters;
      const index = entries.findIndex((entry) => entry.id === id);
      if (index < 0) throw new CharacterLibraryError('notFound', 'Character not found');
      const next = await operation(structuredClone(entries[index]));
      next.updatedAt = Math.max(next.updatedAt, this.now());
      await this.persist(entries.map((entry, position) => position === index ? next : entry));
      return structuredClone(next);
    });
  }
  update(id: string, input: UpdateCharacterInput): Promise<Character> {
    return this.mutate(id, async (character) => {
      if (input.name !== undefined) {
        if (!input.name.trim() || input.name.trim().length > 200) throw new CharacterLibraryError('invalidInput', 'Character name must contain 1 to 200 characters');
        character.name = input.name.trim();
      }
      if (input.description !== undefined) {
        if (input.description?.trim()) character.description = input.description.trim();
        else delete character.description;
      }
      if (input.voice !== undefined) {
        if (input.voice === null) delete character.voice;
        else character.voice = await this.voiceReference(input.voice);
      }
      return character;
    });
  }
  delete(id: string): Promise<void> {
    return this.enqueue(async () => {
      const entries = this.dependencies.document.load().characters;
      if (!entries.some((entry) => entry.id === id)) throw new CharacterLibraryError('notFound', 'Character not found');
      // Character deletion owns references only, never the asset or source canvas node.
      await this.persist(entries.filter((entry) => entry.id !== id));
    });
  }
  addImage(id: string, assetId: string): Promise<Character> {
    return this.mutate(id, async (character) => {
      if (character.images.some((image) => image.assetId === assetId)) return character;
      const image = await this.assetReference(assetId, 'image');
      if (!character.images.some((existing) => existing.assetId === image.assetId)) character.images.push(image);
      character.mainImage ??= image;
      return character;
    });
  }
  removeImage(id: string, assetId: string): Promise<Character> {
    return this.mutate(id, (character) => {
      if (!character.images.some((image) => image.assetId === assetId)) throw new CharacterLibraryError('assetNotFound', 'Image is not in this character');
      character.images = character.images.filter((image) => image.assetId !== assetId);
      if (character.mainImage?.assetId === assetId) character.mainImage = character.images[0] ?? null;
      return character;
    });
  }
  reorderImages(id: string, assetIds: readonly string[]): Promise<Character> {
    return this.mutate(id, (character) => {
      if (assetIds.length !== character.images.length || new Set(assetIds).size !== assetIds.length
        || assetIds.some((assetId) => !character.images.some((image) => image.assetId === assetId))) {
        throw new CharacterLibraryError('invalidImageOrder', 'Image order must contain every image exactly once');
      }
      character.images = assetIds.map((assetId) => ({ assetId }));
      return character;
    });
  }
  setMainImage(id: string, assetId: string): Promise<Character> {
    return this.mutate(id, (character) => {
      const image = character.images.find((item) => item.assetId === assetId);
      if (!image) throw new CharacterLibraryError('assetNotFound', 'Main image must already be in character images');
      character.mainImage = image;
      return character;
    });
  }
  setTags(id: string, tags: readonly string[]): Promise<Character> {
    return this.mutate(id, (character) => {
      if (tags.some((tag) => !tag.trim())) throw new CharacterLibraryError('invalidInput', 'Tags must be non-empty');
      character.tags = [...new Set(tags.map((tag) => tag.trim()))];
      return character;
    });
  }
  addTag(id: string, tag: string): Promise<Character> {
    return this.mutate(id, (character) => {
      if (!tag.trim()) throw new CharacterLibraryError('invalidInput', 'Tag must be non-empty');
      if (!character.tags.includes(tag.trim())) character.tags.push(tag.trim());
      return character;
    });
  }
  removeTag(id: string, tag: string): Promise<Character> {
    return this.mutate(id, (character) => { character.tags = character.tags.filter((item) => item !== tag.trim()); return character; });
  }
}
