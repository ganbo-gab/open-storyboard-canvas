import { invoke, isTauri } from '@tauri-apps/api/core';
import { persistAssetBlob, readWorkspaceRecord } from '@/features/assets/application/assetMediaStorage';
import { MAX_IMPORTED_MODEL_BYTES, type ImportedModelAsset, type ImportedModelStorage } from '../domain/importedModel';

export function modelFileExtension(fileName: string): 'glb' | 'gltf' {
  const extension = fileName.split('.').pop()?.toLowerCase();
  if (extension !== 'glb' && extension !== 'gltf') throw new Error('仅支持 .glb / .gltf 模型文件。');
  return extension;
}

/** Reject dependencies before GLTFLoader can issue network requests or resolve missing sibling files. */
export function validateModelFileBytes(bytes: ArrayBuffer, fileName: string): void {
  const extension = modelFileExtension(fileName);
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMPORTED_MODEL_BYTES) throw new Error('模型文件不能为空，且不能超过 100 MiB。');
  let jsonBytes: Uint8Array;
  if (extension === 'glb') {
    const view = new DataView(bytes);
    if (bytes.byteLength < 20 || view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== bytes.byteLength) {
      throw new Error('GLB 文件头无效（缺少 glTF 标识或长度/版本错误），请重新导出 glTF 2.0 GLB。');
    }
    let offset = 12;
    while (offset < bytes.byteLength) {
      if (offset + 8 > bytes.byteLength) throw new Error('GLB 数据块不完整。');
      const length = view.getUint32(offset, true);
      if (length % 4 !== 0 || offset + 8 + length > bytes.byteLength) throw new Error('GLB 数据块长度无效。');
      if (offset === 12 && view.getUint32(offset + 4, true) !== 0x4e4f534a) throw new Error('GLB 缺少 JSON 数据块。');
      offset += 8 + length;
    }
    jsonBytes = new Uint8Array(bytes, 20, view.getUint32(12, true));
  } else jsonBytes = new Uint8Array(bytes);
  let document: unknown;
  try { document = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(jsonBytes).replace(/^\uFEFF/, '')); }
  catch (error) { throw Object.assign(new Error('GLTF 文件不是有效的 UTF-8 JSON。'), { cause: error }); }
  if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error('GLTF 文件结构无效。');
  const root = document as Record<string, unknown>;
  if (!root.asset || typeof root.asset !== 'object' || !('version' in root.asset) || root.asset.version !== '2.0') throw new Error('仅支持 glTF 2.0 模型。');
  for (const collection of [root.buffers, root.images]) {
    if (!Array.isArray(collection)) continue;
    for (const entry of collection) {
      if (!entry || typeof entry !== 'object' || !('uri' in entry)) continue;
      if (typeof entry.uri !== 'string' || !/^data:[^,]*,/i.test(entry.uri)) {
        throw new Error('模型引用了无法解析的外部缓冲区或纹理文件；请在建模软件中导出内嵌资源的 GLB，或将 GLTF 的缓冲区和纹理全部嵌入 data URI 后再导入。');
      }
    }
  }
}

export async function readModelInput(input: File | string): Promise<{ bytes: ArrayBuffer; fileName: string }> {
  if (typeof input === 'string') {
    if (!isTauri()) throw new Error('网页版不能读取本地文件路径，请使用文件选择器传入 File。');
    const fileName = input.split(/[\\/]/).pop() ?? '';
    modelFileExtension(fileName);
    return { fileName, bytes: await invoke<ArrayBuffer>('read_model_file', { path: input }) };
  }
  modelFileExtension(input.name);
  if (input.size === 0 || input.size > MAX_IMPORTED_MODEL_BYTES) throw new Error('模型文件不能为空，且不能超过 100 MiB。');
  return { fileName: input.name, bytes: await input.arrayBuffer() };
}
export async function persistModelBytes(bytes: ArrayBuffer, fileName: string): Promise<ImportedModelStorage> {
  const extension = modelFileExtension(fileName);
  if (isTauri()) return { kind: 'app-file', path: await invoke<string>('persist_model_binary', bytes, { headers: { 'x-model-extension': extension } }) };
  const mime = extension === 'glb' ? 'model/gltf-binary' : 'model/gltf+json';
  return { kind: 'asset-media', ref: await persistAssetBlob(new Blob([bytes], { type: mime })) };
}
export async function readModelBytes(asset: ImportedModelAsset): Promise<ArrayBuffer> {
  if (asset.storage.kind === 'app-file') {
    if (!isTauri()) throw new Error('此模型保存在桌面应用数据目录中，请在桌面版打开。');
    return await invoke<ArrayBuffer>('read_model_file', { path: asset.storage.path });
  }
  const blob = await readWorkspaceRecord<Blob>('media', asset.storage.ref);
  if (!blob) throw new Error('模型文件已丢失，请重新导入。');
  return await blob.arrayBuffer();
}
