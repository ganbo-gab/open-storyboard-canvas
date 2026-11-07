import { describe, expect, it } from 'vitest';
import { MAX_IMPORTED_MODEL_BYTES, normalizeImportedModelAsset, normalizeImportedModelLibrary, type ImportedModelAsset } from './importedModel';

const asset: ImportedModelAsset = {
  id: 'model-1', name: '座椅', fileName: 'chair.glb', mime: 'model/gltf-binary', sizeBytes: 128, createdAt: 123,
  source: 'file', storage: { kind: 'asset-media', ref: `asset-media:model%2Fgltf-binary:${'a'.repeat(64)}` },
  bounds: { x: 0.6, y: 1.2, z: 0.5 }, defaultHeightMeters: 1.2, upAxis: 'y',
};
describe('imported model persisted normalizers', () => {
  it('round trips all durable fields without retaining unknown fields', () => {
    expect(normalizeImportedModelAsset(JSON.parse(JSON.stringify({ ...asset, ignored: 1 })))).toEqual(asset);
    expect(normalizeImportedModelAsset({ ...asset, storage: { kind: 'app-file', path: '/app/models/a.glb' } })?.storage).toEqual({ kind: 'app-file', path: '/app/models/a.glb' });
  });
  it('migrates legacy optional fields and uses Z height only when explicitly flagged', () => {
    expect(normalizeImportedModelAsset({ ...asset, name: '', mime: 'wrong', createdAt: undefined, defaultHeightMeters: undefined, upAxis: 'z', source: undefined })).toMatchObject({ name: 'chair.glb', mime: 'model/gltf-binary', createdAt: 0, defaultHeightMeters: 0.5, upAxis: 'z', source: 'file' });
    expect(normalizeImportedModelLibrary([asset, asset, null, 'broken'])).toEqual({ version: 1, assets: [asset] });
  });
  it('drops garbage, invalid dimensions and transient storage rather than fabricating bytes', () => {
    for (const value of [null, [], 1, {}, { ...asset, sizeBytes: NaN }, { ...asset, sizeBytes: MAX_IMPORTED_MODEL_BYTES + 1 }, { ...asset, bounds: { x: 1, y: 0, z: 1 } }, { ...asset, storage: { kind: 'app-file', path: '../private.glb' } }, { ...asset, storage: { kind: 'asset-media', ref: 'blob:temporary' } }, { ...asset, fileName: 'x.obj' }]) {
      expect(normalizeImportedModelAsset(value)).toBeNull();
    }
    expect(normalizeImportedModelLibrary({ assets: [false, asset, { ...asset, id: '' }] })).toEqual({ version: 1, assets: [asset] });
    expect(() => normalizeImportedModelLibrary({ version: 2, assets: [asset] })).toThrow('版本');
  });
});
