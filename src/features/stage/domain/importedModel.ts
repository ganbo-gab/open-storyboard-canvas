export const MAX_IMPORTED_MODEL_BYTES = 100 * 1024 * 1024;
export type ModelUpAxis = 'y' | 'z';
export type ImportedModelStorage = { kind: 'app-file'; path: string } | { kind: 'asset-media'; ref: string };
export interface ImportedModelAsset {
  id: string;
  name: string;
  fileName: string;
  mime: 'model/gltf-binary' | 'model/gltf+json';
  sizeBytes: number;
  createdAt: number;
  source: 'file';
  storage: ImportedModelStorage;
  /** Axis-aligned dimensions in authored glTF units (meters), before up-axis conversion. */
  bounds: { x: number; y: number; z: number };
  defaultHeightMeters: number;
  upAxis?: ModelUpAxis;
}
export interface ImportedModelLibrary { version: 1; assets: ImportedModelAsset[] }

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function text(value: unknown): string { return typeof value === 'string' ? value.trim() : ''; }
function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }

/** Missing optional legacy fields get deterministic defaults; broken references/bounds are never fabricated. */
export function normalizeImportedModelAsset(value: unknown): ImportedModelAsset | null {
  const input = record(value);
  if (!input) return null;
  const id = text(input.id), fileName = text(input.fileName);
  const extension = fileName.split('.').pop()?.toLowerCase();
  const bounds = record(input.bounds), ref = record(input.storage);
  if (!id || !['glb', 'gltf'].includes(extension ?? '') || !bounds || !ref
    || !finite(input.sizeBytes) || !Number.isSafeInteger(input.sizeBytes) || input.sizeBytes <= 0 || input.sizeBytes > MAX_IMPORTED_MODEL_BYTES
    || (input.source !== undefined && input.source !== 'file')) return null;
  if (!finite(bounds.x) || !finite(bounds.y) || !finite(bounds.z) || bounds.x < 0 || bounds.y < 0 || bounds.z < 0) return null;
  const upAxis = input.upAxis === 'z' ? 'z' : input.upAxis === 'y' ? 'y' : undefined;
  const authoredHeight = upAxis === 'z' ? bounds.z : bounds.y;
  if (authoredHeight <= 0) return null;
  let storage: ImportedModelStorage;
  if (ref.kind === 'app-file' && /^(\/|[a-z]:[\\/])/i.test(text(ref.path))) storage = { kind: 'app-file', path: text(ref.path) };
  else if (ref.kind === 'asset-media' && /^asset-media:[^:]+:[a-f0-9]{64}$/.test(text(ref.ref))) storage = { kind: 'asset-media', ref: text(ref.ref) };
  else return null;
  return {
    id, name: text(input.name) || fileName, fileName,
    mime: extension === 'glb' ? 'model/gltf-binary' : 'model/gltf+json',
    sizeBytes: input.sizeBytes, createdAt: finite(input.createdAt) && input.createdAt >= 0 ? input.createdAt : 0,
    source: 'file', storage, bounds: { x: bounds.x, y: bounds.y, z: bounds.z },
    defaultHeightMeters: finite(input.defaultHeightMeters) && input.defaultHeightMeters > 0 ? input.defaultHeightMeters : authoredHeight,
    ...(upAxis ? { upAxis } : {}),
  };
}

export function normalizeImportedModelLibrary(value: unknown): ImportedModelLibrary {
  const input = record(value);
  if (input?.version !== undefined && input.version !== 1) throw new Error('模型库版本不受支持，原始数据已保留。');
  const entries: unknown[] = Array.isArray(value) ? value : Array.isArray(input?.assets) ? input.assets : [];
  const assets: ImportedModelAsset[] = [], seen = new Set<string>();
  for (const entry of entries) {
    const asset = normalizeImportedModelAsset(entry);
    if (asset && !seen.has(asset.id)) { seen.add(asset.id); assets.push(asset); }
  }
  return { version: 1, assets };
}
