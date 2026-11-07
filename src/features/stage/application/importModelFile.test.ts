import 'fake-indexeddb/auto';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { importModelFile } from './importModelFile';
import { MAX_IMPORTED_MODEL_BYTES } from '../domain/importedModel';
import { addImportedModel, deleteImportedModel, getImportedModel, IMPORTED_MODEL_LIBRARY_KEY, listImportedModels, renameImportedModel } from './importedModelLibrary';
import { disposeImportedModelMesh, importedModelParseCache, loadImportedModel, resolveImportedModelMesh } from './importedModelLoader';
import { validateModelFileBytes } from './importedModelStorage';
import { readWorkspaceRecord } from '@/features/assets/application/assetMediaStorage';

function syntheticGlb(): ArrayBuffer {
  const positions = new Float32Array([0, 0, 0, 2, 0, 0, 0, 2, 1]);
  const json = JSON.stringify({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }], buffers: [{ byteLength: positions.byteLength }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positions.byteLength }], accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [2, 2, 1] }] });
  const jsonBytes = new TextEncoder().encode(json.padEnd(Math.ceil(json.length / 4) * 4, ' '));
  const buffer = new ArrayBuffer(12 + 8 + jsonBytes.byteLength + 8 + positions.byteLength);
  const view = new DataView(buffer);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, buffer.byteLength, true);
  view.setUint32(12, jsonBytes.byteLength, true); view.setUint32(16, 0x4e4f534a, true);
  new Uint8Array(buffer, 20, jsonBytes.byteLength).set(jsonBytes);
  const binOffset = 20 + jsonBytes.byteLength;
  view.setUint32(binOffset, positions.byteLength, true); view.setUint32(binOffset + 4, 0x004e4942, true);
  new Uint8Array(buffer, binOffset + 8).set(new Uint8Array(positions.buffer));
  return buffer;
}
afterEach(() => { vi.restoreAllMocks(); importedModelParseCache.clear(); });

describe('model file import and persistent library', () => {
  it('rejects wrong GLB magic, mismatched version/length, invalid JSON and oversize before reading', async () => {
    await expect(importModelFile(new File(['not glTF'], 'wrong.glb'))).rejects.toThrow('文件头');
    const bad = syntheticGlb(); new DataView(bad).setUint32(4, 1, true);
    expect(() => validateModelFileBytes(bad, 'bad.glb')).toThrow('文件头');
    await expect(importModelFile(new File(['not json'], 'wrong.gltf'))).rejects.toThrow('JSON');
    await expect(importModelFile(new File(['{}'], 'wrong.obj'))).rejects.toThrow('仅支持');
    const file = new File(['tiny'], 'large.glb');
    Object.defineProperty(file, 'size', { value: MAX_IMPORTED_MODEL_BYTES + 1 });
    const read = vi.spyOn(file, 'arrayBuffer');
    await expect(importModelFile(file)).rejects.toThrow('100 MiB');
    expect(read).not.toHaveBeenCalled();
    await expect(importModelFile('/tmp/model.glb')).rejects.toThrow('网页版');
  });
  it('rejects unresolved external buffers and textures, accepts embedded GLTF data', () => {
    for (const dependency of [{ buffers: [{ uri: 'mesh.bin' }] }, { images: [{ uri: 'https://example.com/texture.png' }] }]) {
      const bytes = new TextEncoder().encode(JSON.stringify({ asset: { version: '2.0' }, ...dependency })).buffer;
      expect(() => validateModelFileBytes(bytes, 'model.gltf')).toThrow('外部缓冲区或纹理');
    }
    expect(() => validateModelFileBytes(new TextEncoder().encode(JSON.stringify({ asset: { version: '2.0' }, buffers: [{ uri: 'data:application/octet-stream;base64,AAAA' }] })).buffer, 'model.gltf')).not.toThrow();
  });
  it('persists bytes/index, measures once, caches the import parse, and reloads after module restart', async () => {
    const parse = vi.spyOn(GLTFLoader.prototype, 'parseAsync');
    const bytes = syntheticGlb();
    const asset = await importModelFile(new File([bytes], '道具.GLB'), { heightMeters: 1.75 });
    expect(asset).toMatchObject({ name: '道具', sizeBytes: bytes.byteLength, bounds: { x: 2, y: 2, z: 1 }, defaultHeightMeters: 1.75, storage: { kind: 'asset-media' } });
    expect(await getImportedModel(asset.id)).toEqual(asset);
    if (asset.storage.kind !== 'asset-media') throw new Error('Expected browser media storage');
    const blob = await readWorkspaceRecord<Blob>('media', asset.storage.ref);
    expect(await blob!.arrayBuffer()).toEqual(bytes);
    const instance = await loadImportedModel(asset.id);
    expect(parse).toHaveBeenCalledTimes(1);
    expect(new THREE.Box3().setFromObject(instance).max.y).toBeCloseTo(1.75);
    const explicit = await resolveImportedModelMesh({ id: 'item', label: '', x: 0, y: 0, color: '#fff', importedModelId: asset.id }, 3);
    expect(new THREE.Box3().setFromObject(explicit).max.y).toBeCloseTo(3);
    expect(await resolveImportedModelMesh({ id: 'item', label: '', x: 0, y: 0, color: '#fff' }, 3)).toBeNull();
    await Promise.all([renameImportedModel(asset.id, '改名'), addImportedModel({ ...asset, id: 'second' })]);
    await expect(addImportedModel({ ...asset, id: 'second' })).rejects.toThrow('已存在');
    await expect(renameImportedModel(asset.id, '  ')).rejects.toThrow('不能为空');
    await expect(renameImportedModel('missing', 'name')).rejects.toThrow('不存在');
    expect((await listImportedModels()).some((entry) => entry.id === 'second')).toBe(true);
    const envelope = await readWorkspaceRecord<{ data: { assets: unknown[] } }>('documents', IMPORTED_MODEL_LIBRARY_KEY);
    expect(envelope?.data.assets).toHaveLength(2);
    vi.resetModules();
    // A static import cannot exercise hydration of a fresh module after process restart.
    const reloaded = await import('./importedModelLibrary');
    expect(await reloaded.getImportedModel(asset.id)).toMatchObject({ name: '改名' });
    await Promise.all([reloaded.deleteImportedModel(asset.id), reloaded.renameImportedModel('second', '保留')]);
    expect(await reloaded.getImportedModel(asset.id)).toBeNull();
    expect(await readWorkspaceRecord('media', asset.storage.ref)).toBeDefined();
    expect(new THREE.Box3().setFromObject(instance).max.y).toBeCloseTo(1.75);
    disposeImportedModelMesh(instance); disposeImportedModelMesh(explicit);
    await reloaded.deleteImportedModel('second');
    await deleteImportedModel(asset.id); await deleteImportedModel('second');
  });
});
