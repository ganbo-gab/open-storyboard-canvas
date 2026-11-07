import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { computeImportedModelNormalization, disposeImportedModelMesh, ImportedModelParseCache, normalizeImportedModelGroup, createImportedModelPlaceholder } from './importedModelLoader';

type Group = InstanceType<typeof THREE.Group>;
type Object3D = InstanceType<typeof THREE.Object3D>;
function syntheticModel(): Group {
  const group = new THREE.Group();
  const box = new THREE.Mesh(new THREE.BoxGeometry(2, 4, 2), new THREE.MeshStandardMaterial({ color: 0xabcdef }));
  box.position.set(5, 4, -3);
  const sphere = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 8), new THREE.MeshStandardMaterial());
  sphere.position.set(7, 2, -1);
  const cylinder = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 2, 12), new THREE.MeshStandardMaterial());
  cylinder.position.set(3, 7, -5);
  group.add(box, sphere, cylinder);
  group.position.set(2, -1, 4);
  return group;
}
function meshes(group: Group): Object3D[] {
  const output: Object3D[] = [];
  group.traverse((object: Object3D) => { if (object.isMesh) output.push(object); });
  return output;
}
describe('imported model normalization and ownership', () => {
  it('centers X/Z, grounds the lowest point and fits the exact requested metric height', () => {
    const source = syntheticModel();
    const bounds = new THREE.Box3().setFromObject(source);
    const transform = computeImportedModelNormalization(bounds, 3.5);
    expect(transform.scale).toBeCloseTo(3.5 / (bounds.max.y - bounds.min.y));
    const normalized = normalizeImportedModelGroup(source, 3.5);
    const actual = new THREE.Box3().setFromObject(normalized);
    expect(actual.max.y - actual.min.y).toBeCloseTo(3.5);
    expect(actual.min.y).toBeCloseTo(0);
    expect(actual.min.x + actual.max.x).toBeCloseTo(0);
    expect(actual.min.z + actual.max.z).toBeCloseTo(0);
    expect(normalized.position.toArray()).toEqual([0, 0, 0]);
    expect(normalized.scale.toArray()).toEqual([1, 1, 1]);
    expect(meshes(normalized).every((mesh) => mesh.castShadow && mesh.receiveShadow)).toBe(true);
    disposeImportedModelMesh(normalized);
  });
  it('converts explicit Z-up before measuring height and rejects empty/invalid bounds', () => {
    const normalized = normalizeImportedModelGroup(syntheticModel(), 2.25, 'z');
    const actual = new THREE.Box3().setFromObject(normalized);
    expect(actual.max.y - actual.min.y).toBeCloseTo(2.25);
    expect(actual.min.y).toBeCloseTo(0);
    expect(() => normalizeImportedModelGroup(new THREE.Group(), 1)).toThrow('包围盒');
    expect(() => computeImportedModelNormalization(actual, NaN)).toThrow();
    expect(() => computeImportedModelNormalization(actual, 0)).toThrow();
    const placeholder = new THREE.Box3().setFromObject(createImportedModelPlaceholder(1.8));
    expect(placeholder.min.y).toBeCloseTo(0);
    expect(placeholder.max.y).toBeCloseTo(1.8);
    disposeImportedModelMesh(normalized);
  });
  it('parses once for concurrent callers and returns independent transforms and GPU resources', async () => {
    const template = syntheticModel();
    template.children[0].material.map = new THREE.Texture();
    const parse = vi.fn(async () => template);
    const cache = new ImportedModelParseCache(parse);
    const [first, second] = await Promise.all([cache.load('chair', 2), cache.load('chair', 3)]);
    expect(parse).toHaveBeenCalledTimes(1);
    const a = meshes(first)[0], b = meshes(second)[0], original = template.children[0];
    expect(a).not.toBe(b);
    expect(a.geometry).not.toBe(b.geometry);
    expect(a.geometry).not.toBe(original.geometry);
    expect(a.material).not.toBe(b.material);
    expect(a.material.map).not.toBe(b.material.map);
    expect(a.material.map).not.toBe(original.material.map);
    const originalDispose = vi.spyOn(original.geometry, 'dispose');
    const otherDispose = vi.spyOn(b.geometry, 'dispose');
    const textureDispose = vi.spyOn(a.material.map, 'dispose');
    a.position.x = 100;
    a.geometry.attributes.position.setX(0, 999);
    a.material.color.set(0xff0000);
    expect(b.position.x).not.toBe(100);
    expect(b.geometry.attributes.position.getX(0)).not.toBe(999);
    expect(b.material.color.getHex()).not.toBe(0xff0000);
    disposeImportedModelMesh(first);
    expect(originalDispose).not.toHaveBeenCalled();
    expect(otherDispose).not.toHaveBeenCalled();
    expect(textureDispose).toHaveBeenCalledTimes(1);
    cache.clear();
    expect(originalDispose).toHaveBeenCalled();
    expect(otherDispose).not.toHaveBeenCalled();
    expect(new THREE.Box3().setFromObject(second).max.y).toBeCloseTo(3);
    disposeImportedModelMesh(second);
  });
  it('evicts templates safely while parses are in flight and retries a failed parse', async () => {
    // ES2020 project libs do not expose Promise.withResolvers.
    let release: ((group: Group) => void) | undefined;
    const source = syntheticModel();
    const dispose = vi.spyOn(source.children[0].geometry, 'dispose');
    const parse = vi.fn((id: string): Promise<Group> => id === 'slow' ? new Promise((resolve) => { release = resolve; }) : Promise.resolve(syntheticModel()));
    const cache = new ImportedModelParseCache(parse, 1);
    const slow = cache.load('slow', 2);
    await Promise.resolve();
    const fast = await cache.load('fast', 1);
    release!(source);
    const result = await slow;
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(new THREE.Box3().setFromObject(result).max.y).toBeCloseTo(2);
    const retry = vi.fn<() => Promise<Group>>().mockRejectedValueOnce(new Error('bad')).mockResolvedValueOnce(syntheticModel());
    const retryCache = new ImportedModelParseCache(retry);
    await expect(retryCache.load('x', 1)).rejects.toThrow('bad');
    const retried = await retryCache.load('x', 1);
    expect(retry).toHaveBeenCalledTimes(2);
    [fast, result, retried].forEach(disposeImportedModelMesh);
    cache.clear(); retryCache.clear();
  });
});
