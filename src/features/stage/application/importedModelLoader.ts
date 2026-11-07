import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { BlueprintItem } from '@/features/canvas/domain/canvasNodes';
import { BLUEPRINT_PRESERVE_MATERIAL_COLOR } from '@/features/canvas/ui/blueprintMeshFactory';
import type { ModelUpAxis } from '../domain/importedModel';
import { getImportedModel } from './importedModelLibrary';
import { readModelBytes, validateModelFileBytes } from './importedModelStorage';

type Group = InstanceType<typeof THREE.Group>;
type Object3D = InstanceType<typeof THREE.Object3D>;
type Material = InstanceType<typeof THREE.Material>;
type Texture = InstanceType<typeof THREE.Texture>;
export interface ModelBounds { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } }

/** Bounds are measured after up-axis conversion. Offsets are in the resulting metric coordinates. */
export function computeImportedModelNormalization(bounds: ModelBounds, heightMeters: number): { scale: number; offset: { x: number; y: number; z: number } } {
  const { min, max } = bounds;
  if (![min.x, min.y, min.z, max.x, max.y, max.z, heightMeters].every(Number.isFinite)
    || heightMeters <= 0 || max.y <= min.y || max.x < min.x || max.z < min.z) throw new Error('模型没有有效的立体包围盒或目标高度。');
  const scale = heightMeters / (max.y - min.y);
  return { scale, offset: { x: -(min.x + max.x) * 0.5 * scale, y: -min.y * scale, z: -(min.z + max.z) * 0.5 * scale } };
}

/** Owns the supplied instance; never pass the cache's template. The outer group remains an identity item transform. */
export function normalizeImportedModelGroup(instance: Group, heightMeters: number, upAxis: ModelUpAxis = 'y'): Group {
  const oriented = new THREE.Group();
  oriented.add(instance);
  if (upAxis === 'z') oriented.rotation.x = -Math.PI / 2;
  oriented.updateMatrixWorld(true);
  const transform = computeImportedModelNormalization(new THREE.Box3().setFromObject(oriented), heightMeters);
  const normalized = new THREE.Group();
  normalized.add(oriented);
  normalized.scale.setScalar(transform.scale);
  normalized.position.set(transform.offset.x, transform.offset.y, transform.offset.z);
  const root = new THREE.Group();
  root.add(normalized);
  root.traverse((object: Object3D) => { if (object.isMesh) { object.castShadow = true; object.receiveShadow = true; } });
  root.updateMatrixWorld(true);
  return root;
}

function materialTextures(material: Material): Texture[] {
  return Object.values(material).filter((value): value is Texture => Boolean(value && typeof value === 'object' && 'isTexture' in value && value.isTexture === true));
}

/** Every returned instance owns its geometries, materials, textures and skeletons; CPU texture pixels may be shared read-only. */
function cloneModelInstance(template: Group): Group {
  const instance = new THREE.Group();
  instance.add(cloneSkeleton(template));
  instance.traverse((object: Object3D) => {
    if (!object.isMesh) return;
    object.geometry = object.geometry.clone();
    if (object.isSkinnedMesh) object.geometry.addEventListener('dispose', () => object.skeleton.dispose());
    const cloneMaterial = (original: Material): Material => {
      const material = original.clone();
      material.userData[BLUEPRINT_PRESERVE_MATERIAL_COLOR] = true;
      const textures = new Map<Texture, Texture>();
      for (const [key, value] of Object.entries(original)) {
        if (!value || typeof value !== 'object' || !('isTexture' in value) || value.isTexture !== true) continue;
        const source = value as Texture;
        let texture = textures.get(source);
        if (!texture) { texture = source.clone(); textures.set(source, texture); }
        material[key] = texture;
      }
      material.addEventListener('dispose', () => { for (const texture of textures.values()) texture.dispose(); textures.clear(); });
      return material;
    };
    object.material = Array.isArray(object.material) ? object.material.map(cloneMaterial) : cloneMaterial(object.material);
  });
  return instance;
}

/** Matches BlueprintScene's geometry/material traversal; cloned materials also release their owned texture handles. */
export function disposeImportedModelMesh(root: Group): void {
  root.traverse((object: Object3D) => {
    if (!object.isMesh) return;
    object.geometry.dispose();
    if (Array.isArray(object.material)) object.material.forEach((material: Material) => material.dispose());
    else object.material.dispose();
  });
}
export function disposeImportedModelTemplate(root: Group): void {
  const textures = new Set<Texture>();
  root.traverse((object: Object3D) => {
    if (!object.isMesh) return;
    const materials: Material[] = Array.isArray(object.material) ? object.material : [object.material];
    materials.forEach((material) => materialTextures(material).forEach((texture) => textures.add(texture)));
    if (object.isSkinnedMesh) object.skeleton.dispose();
  });
  disposeImportedModelMesh(root);
  textures.forEach((texture) => texture.dispose());
}
interface CacheEntry { promise: Promise<Group>; template?: Group; users: number; retired: boolean }

/** Single-flight parse with bounded LRU templates. Live clones never share disposable GPU handles with templates. */
export class ImportedModelParseCache {
  private entries = new Map<string, CacheEntry>();
  constructor(private readonly parse: (assetId: string) => Promise<Group>, private readonly capacity = 4) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error('Invalid model cache capacity');
  }
  prime(assetId: string, template: Group): void {
    this.clear(assetId);
    this.entries.set(assetId, { promise: Promise.resolve(template), template, users: 0, retired: false });
    this.trim();
  }
  async load(assetId: string, heightMeters: number, upAxis: ModelUpAxis = 'y'): Promise<Group> {
    let entry = this.entries.get(assetId);
    if (!entry) {
      entry = { promise: Promise.resolve().then(() => this.parse(assetId)), users: 0, retired: false };
      this.entries.set(assetId, entry);
    } else { this.entries.delete(assetId); this.entries.set(assetId, entry); }
    entry.users++;
    this.trim();
    try {
      entry.template = await entry.promise;
      const clone = cloneModelInstance(entry.template);
      try { return normalizeImportedModelGroup(clone, heightMeters, upAxis); }
      catch (error) { disposeImportedModelMesh(clone); throw error; }
    } catch (error) {
      if (this.entries.get(assetId) === entry) this.clear(assetId);
      throw error;
    } finally {
      entry.users--;
      if (entry.retired && entry.users === 0 && entry.template) disposeImportedModelTemplate(entry.template);
    }
  }
  clear(assetId?: string): void {
    for (const [id, entry] of this.entries) {
      if (assetId !== undefined && id !== assetId) continue;
      this.entries.delete(id);
      entry.retired = true;
      if (entry.users === 0 && entry.template) disposeImportedModelTemplate(entry.template);
    }
  }
  private trim(): void {
    while (this.entries.size > this.capacity) this.clear(this.entries.keys().next().value!);
  }
}

export async function parseImportedModelBytes(bytes: ArrayBuffer, fileName: string): Promise<Group> {
  validateModelFileBytes(bytes, fileName);
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url: string) => {
    if (!/^(data:|blob:)/i.test(url)) throw new Error('模型包含未嵌入的外部资源，请重新导出内嵌资源的 GLB。');
    return url;
  });
  try {
    const result = await new GLTFLoader(manager).parseAsync(bytes, '');
    const group = new THREE.Group();
    group.add(result.scene);
    return group;
  } catch (error) { throw Object.assign(new Error('模型解析失败；请检查文件完整性，并导出无需额外解码器的 glTF 2.0 / GLB。'), { cause: error }); }
}
export const importedModelParseCache = new ImportedModelParseCache(async (id) => {
  const asset = await getImportedModel(id);
  if (!asset) throw new Error('模型不存在或已从模型库删除。');
  return await parseImportedModelBytes(await readModelBytes(asset), asset.fileName);
});
export async function loadImportedModel(assetId: string, heightMeters?: number): Promise<Group> {
  const asset = await getImportedModel(assetId);
  if (!asset) throw new Error('模型不存在或已从模型库删除。');
  return await importedModelParseCache.load(assetId, heightMeters ?? asset.defaultHeightMeters, asset.upAxis);
}
export function createImportedModelPlaceholder(heightM: number): Group {
  if (!Number.isFinite(heightM) || heightM <= 0) throw new Error('模型高度必须大于零。');
  const group = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(heightM * 0.5, heightM, heightM * 0.5), new THREE.MeshBasicMaterial({ color: 0x94a3b8, wireframe: true }));
  mesh.position.y = heightM * 0.5;
  group.add(mesh);
  return group;
}
export async function resolveImportedModelMesh(item: BlueprintItem, heightM?: number): Promise<Group | null> {
  return item.importedModelId ? await loadImportedModel(item.importedModelId, heightM) : null;
}
