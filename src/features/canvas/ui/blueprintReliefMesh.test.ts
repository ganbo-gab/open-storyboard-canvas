import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { createDepthReliefMesh, disposeDepthReliefMesh } from './blueprintReliefMesh';
import type { DepthReliefMap, DepthReliefParameters } from '@/features/stage/domain/depthRelief';

const image = { width: 4, height: 2 } as HTMLImageElement;
const params: DepthReliefParameters = { widthM: 4, depthM: 2, fovDeg: 60, segments: 4 };
const flatDepth = (value: number): DepthReliefMap => ({ width: 2, height: 2, data: new Float32Array(4).fill(value) });

function onlyMesh(group: InstanceType<typeof THREE.Group>) {
  return group.children[0] as InstanceType<typeof THREE.Mesh>;
}

describe('depth relief mesh', () => {
  it('builds an aspect-correct indexed grid on the ground facing +Z with an unlit image texture', () => {
    const group = createDepthReliefMesh(image, flatDepth(1), params);
    const mesh = onlyMesh(group);
    expect(mesh.geometry.attributes.position.count).toBe(15);
    expect(mesh.geometry.index.count).toBe(48);
    const box = new THREE.Box3().setFromObject(group);
    expect(box.min.y).toBeCloseTo(0);
    expect(box.max.x - box.min.x).toBeCloseTo(4);
    expect(box.max.y - box.min.y).toBeCloseTo(2);
    expect(box.max.z - box.min.z).toBeCloseTo(0);
    expect(mesh.geometry.attributes.normal.getZ(0)).toBeCloseTo(1);
    expect(mesh.material.isMeshBasicMaterial).toBe(true);
    expect(mesh.material.map.image).toBe(image);
    expect(mesh.castShadow).toBe(false);
    expect(mesh.receiveShadow).toBe(false);
    disposeDepthReliefMesh(group);
  });

  it('cuts triangles spanning an inverse-depth discontinuity instead of stretching the texture', () => {
    const group = createDepthReliefMesh(image, {
      width: 3, height: 2, data: new Float32Array([0, 0, 1, 0, 0, 1]),
    }, { ...params, segments: 2 });
    const mesh = onlyMesh(group);
    expect(mesh.geometry.attributes.position.count).toBe(6);
    expect(mesh.geometry.index.count).toBe(6);
    for (const index of mesh.geometry.index.array) {
      expect(mesh.geometry.attributes.position.getZ(index)).toBeCloseTo(-2);
    }
    disposeDepthReliefMesh(group);
  });

  it('maps bright inverse depth nearer and projects farther pixels along the source FOV rays', () => {
    const depth: DepthReliefMap = { width: 3, height: 2, data: new Float32Array([0, 0.5, 1, 0, 0.5, 1]) };
    const group = createDepthReliefMesh(image, depth, { ...params, segments: 2, discontinuityThreshold: 1 });
    const positions = onlyMesh(group).geometry.attributes.position;
    expect(positions.getZ(0)).toBeCloseTo(-2);
    expect(positions.getZ(1)).toBeCloseTo(-1);
    expect(positions.getZ(2)).toBeCloseTo(0);
    const cameraDistance = 2 / (2 * Math.tan(Math.PI / 6));
    expect(positions.getX(0)).toBeCloseTo(-2 * (cameraDistance + 2) / cameraDistance);
    expect(positions.getX(2)).toBeCloseTo(2);
    expect(new THREE.Box3().setFromObject(group).min.y).toBeCloseTo(0);
    disposeDepthReliefMesh(group);
  });

  it('keeps all triangles when depth span is zero and accepts the persisted relief as mesh parameters', () => {
    const relief = { ...params, depthM: 0, imageUrl: '/image.png', depthUrl: '/depth.png' };
    const group = createDepthReliefMesh(image, {
      width: 2, height: 2, data: new Float32Array([0, 1, 0, 1]),
    }, relief);
    expect(onlyMesh(group).geometry.index.count).toBe(48);
    disposeDepthReliefMesh(group);
  });

  it('rejects corrupt depth maps before allocating a mesh', () => {
    expect(() => createDepthReliefMesh(image, { width: 2, height: 2, data: new Float32Array(3) }, params)).toThrow('dimensions');
    expect(() => createDepthReliefMesh(image, flatDepth(NaN), params)).toThrow('[0, 1]');
  });

  it('disposes geometry, material and texture exactly once without closing the source image', () => {
    const group = createDepthReliefMesh(image, flatDepth(1), params);
    const mesh = onlyMesh(group);
    const geometryDisposed = vi.fn();
    const materialDisposed = vi.fn();
    const textureDisposed = vi.fn();
    mesh.geometry.addEventListener('dispose', geometryDisposed);
    mesh.material.addEventListener('dispose', materialDisposed);
    mesh.material.map.addEventListener('dispose', textureDisposed);
    disposeDepthReliefMesh(group);
    disposeDepthReliefMesh(group);
    expect(geometryDisposed).toHaveBeenCalledTimes(1);
    expect(materialDisposed).toHaveBeenCalledTimes(1);
    expect(textureDisposed).toHaveBeenCalledTimes(1);
    expect(group.children).toHaveLength(0);
  });
});
