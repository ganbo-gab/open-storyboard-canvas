import * as THREE from 'three';
import { normalizeImportedModelAsset, type ImportedModelAsset, type ModelUpAxis } from '../domain/importedModel';
import { addImportedModel, getImportedModel } from './importedModelLibrary';
import { disposeImportedModelTemplate, importedModelParseCache, parseImportedModelBytes } from './importedModelLoader';
import { persistModelBytes, readModelInput } from './importedModelStorage';

export interface ImportModelOptions { name?: string; heightMeters?: number; upAxis?: ModelUpAxis; id?: string; signal?: AbortSignal }

/** Parses once, commits immutable bytes before the index, then transfers the template to the loader cache. */
export async function importModelFile(input: File | string, options: ImportModelOptions = {}): Promise<ImportedModelAsset> {
  options.signal?.throwIfAborted();
  if (options.id) {
    const existing = await getImportedModel(options.id);
    if (existing) return existing;
  }
  const { bytes, fileName } = await readModelInput(input);
  options.signal?.throwIfAborted();
  const template = await parseImportedModelBytes(bytes, fileName);
  try {
    options.signal?.throwIfAborted();
    template.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(template);
    const size = box.getSize(new THREE.Vector3());
    const authoredHeight = options.upAxis === 'z' ? size.z : size.y;
    if (box.isEmpty() || ![size.x, size.y, size.z, authoredHeight].every(Number.isFinite) || authoredHeight <= 0) throw new Error('模型没有可测量的正高度，请检查几何或上轴设置。');
    if (options.heightMeters !== undefined && (!Number.isFinite(options.heightMeters) || options.heightMeters <= 0)) throw new Error('模型高度必须大于零。');
    const asset = normalizeImportedModelAsset({
      id: options.id ?? crypto.randomUUID(), name: options.name?.trim() || fileName.replace(/\.(glb|gltf)$/i, ''), fileName,
      sizeBytes: bytes.byteLength, createdAt: Date.now(), source: 'file',
      storage: await persistModelBytes(bytes, fileName), bounds: { x: size.x, y: size.y, z: size.z },
      defaultHeightMeters: options.heightMeters ?? authoredHeight, upAxis: options.upAxis,
    });
    if (!asset) throw new Error('模型资产记录无效。');
    options.signal?.throwIfAborted();
    const saved = await addImportedModel(asset);
    importedModelParseCache.prime(saved.id, template);
    return saved;
  } catch (error) { disposeImportedModelTemplate(template); throw error; }
}
