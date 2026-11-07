import type {
  Character, CharacterAssetRef, CharacterNormalizationIssue, CharacterNormalizationResult,
  CharacterSource, CharacterVoice,
} from './types';

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null;
/** Asset ids are opaque catalogue keys, not paths or transient media sources. */
export function isCharacterAssetId(value: unknown): value is string {
  return typeof value === 'string' && value === value.trim() && value.length > 0
    && !/^(?:blob:|data:|https?:|file:|asset-media:|asset:|\/|[A-Za-z]:[\\/])/i.test(value)
    && !/[\u0000-\u001f\u007f]/.test(value);
}
function assetRef(value: unknown): CharacterAssetRef | null {
  const id = typeof value === 'string' ? value : record(value) ? value.assetId : undefined;
  return isCharacterAssetId(id) ? { assetId: id } : null;
}
export function normalizeCharacterVoice(value: unknown): CharacterVoice | null {
  if (!record(value)) return null;
  if (value.kind === 'none') return { kind: 'none' };
  if (value.kind === 'sample' && isCharacterAssetId(value.sampleAssetId)) return { kind: 'sample', sampleAssetId: value.sampleAssetId };
  if (value.kind === 'provider' && text(value.providerId) && text(value.voiceId)) {
    return { kind: 'provider', providerId: String(value.providerId).trim(), voiceId: String(value.voiceId).trim() };
  }
  return null;
}
function sourceRef(value: unknown): CharacterSource | null {
  if (!record(value) || !text(value.id) || !['canvasNode', 'asset', 'upload'].includes(String(value.kind))) return null;
  return { kind: value.kind as CharacterSource['kind'], id: String(value.id).trim() };
}
function timestamp(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  }
  return null;
}

/** Migrates bare arrays/keyed collections, string asset ids and ISO dates. Invalid rows/fields are reported, never asserted. */
export function normalizeCharacterLibrary(input: unknown): CharacterNormalizationResult {
  const issues: CharacterNormalizationIssue[] = [];
  const characters: Character[] = [];
  const collection: unknown = Array.isArray(input) ? input : record(input) ? input.characters : undefined;
  let entries: [string | undefined, unknown][];
  if (Array.isArray(collection)) entries = collection.map((item) => [undefined, item]);
  else if (record(collection)) entries = Object.entries(collection);
  else return { characters, issues: [{ index: null, field: 'characters', reason: 'Expected an array or keyed character collection', action: 'dropped' }] };
  const seen = new Set<string>();
  entries.forEach(([legacyId, entry], index) => {
    const id = record(entry) ? text(entry.id ?? legacyId) : null;
    const report = (field: string, reason: string, action: CharacterNormalizationIssue['action'] = 'dropped') => {
      issues.push({ index, ...(id ? { characterId: id } : {}), field, reason, action });
    };
    if (!record(entry) || !id || !text(entry.name)) { report('character', 'Character id and name must be non-empty strings'); return; }
    if (String(entry.name).trim().length > 200) { report('name', 'Character name cannot exceed 200 characters'); return; }
    if (seen.has(id)) { report('id', 'Duplicate character id'); return; }
    const createdAt = entry.createdAt === undefined ? 0 : timestamp(entry.createdAt);
    const updatedAt = entry.updatedAt === undefined ? createdAt : timestamp(entry.updatedAt);
    if (createdAt === null || updatedAt === null) { report('timestamps', 'Invalid character timestamp'); return; }
    const rawImages = entry.images ?? entry.imageAssetIds ?? [];
    if (!Array.isArray(rawImages)) { report('images', 'Images must be an ordered array'); return; }
    const images: CharacterAssetRef[] = [];
    const imageIds = new Set<string>();
    for (const raw of rawImages) {
      const ref = assetRef(raw);
      if (!ref) { report('images', 'Invalid asset reference; URLs are not asset ids'); continue; }
      if (imageIds.has(ref.assetId)) { report('images', 'Duplicate asset reference'); continue; }
      imageIds.add(ref.assetId); images.push(ref);
    }
    const rawMain = entry.mainImage ?? entry.mainImageAssetId;
    const requestedMain = assetRef(rawMain);
    if (rawMain !== undefined && rawMain !== null && !requestedMain) report('mainImage', 'Invalid main image asset reference');
    // A valid legacy main image is retained, not silently discarded if the old array omitted it.
    if (requestedMain && !imageIds.has(requestedMain.assetId)) {
      images.unshift(requestedMain);
      report('mainImage', 'Added main image to ordered images', 'repaired');
    }
    const mainImage = requestedMain ?? images[0] ?? null;
    const tags: string[] = [];
    if (entry.tags !== undefined && !Array.isArray(entry.tags)) report('tags', 'Tags must be an array');
    if (Array.isArray(entry.tags)) for (const value of entry.tags) {
      const tag = text(value);
      if (!tag) { report('tags', 'Invalid empty/non-string tag'); continue; }
      if (!tags.includes(tag)) tags.push(tag);
    }
    const voice = entry.voice === undefined ? null : normalizeCharacterVoice(entry.voice);
    if (entry.voice !== undefined && !voice) report('voice', 'Invalid voice reference for the selected voice kind');
    const source = entry.source === undefined ? null : sourceRef(entry.source);
    if (entry.source !== undefined && !source) report('source', 'Invalid source reference');
    if (entry.description !== undefined && typeof entry.description !== 'string') report('description', 'Description must be a string');
    const description = text(entry.description);
    if (updatedAt < createdAt) report('updatedAt', 'Updated timestamp precedes creation; clamped to creation', 'repaired');
    seen.add(id);
    characters.push({ id, name: String(entry.name).trim(), images, mainImage, tags,
      ...(description ? { description } : {}), ...(voice ? { voice } : {}), ...(source ? { source } : {}),
      createdAt, updatedAt: Math.max(createdAt, updatedAt) });
  });
  return { characters, issues };
}
