import { createWorkspaceDocument } from '@/features/workbench/application/workspaceDocument';
import { normalizeImportedModelAsset, normalizeImportedModelLibrary, type ImportedModelAsset, type ImportedModelLibrary } from '../domain/importedModel';

export const IMPORTED_MODEL_LIBRARY_KEY = 'storyboard-copilot:imported-models:v1';
const document = createWorkspaceDocument<ImportedModelLibrary>(IMPORTED_MODEL_LIBRARY_KEY, () => ({ version: 1, assets: [] }), normalizeImportedModelLibrary);
let pending: Promise<unknown> = Promise.resolve();

// Serialize reads as well as writes so callers never observe an uncommitted mutation.
function withLibrary<T>(operation: () => Promise<T>): Promise<T> {
  const next = pending.then(async () => { await document.initialize?.(); return await operation(); });
  pending = next.catch(() => undefined);
  return next;
}
async function commit(assets: ImportedModelAsset[]): Promise<void> {
  const previous = document.load();
  document.save({ version: 1, assets });
  try { await document.flush?.(); }
  catch (error) {
    document.save(previous);
    await document.flush?.().catch(() => undefined);
    throw Object.assign(new Error('模型库未能持久保存，请检查存储空间或浏览器存储权限。'), { cause: error });
  }
}

/** Adds only a validated, already-durable asset; ids are immutable and cannot overwrite other bytes. */
export function addImportedModel(asset: ImportedModelAsset): Promise<ImportedModelAsset> {
  return withLibrary(async () => {
    const normalized = normalizeImportedModelAsset(asset);
    if (!normalized) throw new Error('模型资产记录无效。');
    if (document.load().assets.some((entry) => entry.id === normalized.id)) throw new Error('模型编号已存在。');
    await commit([...document.load().assets, normalized]);
    return structuredClone(normalized);
  });
}
export function listImportedModels(): Promise<ImportedModelAsset[]> {
  return withLibrary(async () => structuredClone(document.load().assets).sort((a, b) => b.createdAt - a.createdAt));
}
export function getImportedModel(id: string): Promise<ImportedModelAsset | null> {
  return withLibrary(async () => structuredClone(document.load().assets.find((entry) => entry.id === id) ?? null));
}
export function renameImportedModel(id: string, name: string): Promise<void> {
  return withLibrary(async () => {
    if (!name.trim()) throw new Error('模型名称不能为空。');
    if (!document.load().assets.some((entry) => entry.id === id)) throw new Error('模型不存在。');
    await commit(document.load().assets.map((entry) => entry.id === id ? { ...entry, name: name.trim() } : entry));
  });
}
/** Like the asset catalog, removes the library reference, never shared bytes or existing canvas items. */
export function deleteImportedModel(id: string): Promise<void> {
  return withLibrary(async () => { await commit(document.load().assets.filter((entry) => entry.id !== id)); });
}
export const getImportedModelStorageStatus = () => document.status();
