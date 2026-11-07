import { invoke, isTauri } from '@tauri-apps/api/core';
import type { GenerationNetworkRoute } from '@/commands/ai';
import { resolveSecretTokens, resolveSecretValue } from '@/features/secrets/secretStore';
import type { OutputSource } from '@/features/channels/runtime/types';
import { MAX_IMPORTED_MODEL_BYTES } from '../domain/importedModel';
import { getImportedModel } from './importedModelLibrary';
import { importModelFile } from './importModelFile';
import { validateModelFileBytes } from './importedModelStorage';

export type ModelDownloadErrorCode = 'too_large' | 'invalid_model' | 'network' | 'canceled' | 'storage' | 'credential';
export class ModelDownloadError extends Error {
  constructor(readonly code: ModelDownloadErrorCode, message: string) { super(message); this.name = 'ModelDownloadError'; }
}
export interface ModelDownloadNetwork { route: GenerationNetworkRoute; customProxyUrl?: string; configuredProviderOrigin?: string }

/** Download validation is deliberately independent of the provider URL's extension. */
export function sniffGeneratedModel(bytes: ArrayBuffer, contentType = ''): 'glb' | 'gltf' {
  const mime = contentType.split(';')[0].trim().toLowerCase();
  const glb = bytes.byteLength >= 4 && new DataView(bytes).getUint32(0, true) === 0x46546c67;
  if (mime && !['model/gltf-binary', 'model/gltf+json', 'application/octet-stream', 'application/json', 'binary/octet-stream'].includes(mime)) {
    throw new ModelDownloadError('invalid_model', '下载结果不是 GLB / GLTF 模型文件。');
  }
  if ((mime === 'model/gltf-binary' && !glb) || (mime === 'model/gltf+json' && glb)) throw new ModelDownloadError('invalid_model', '模型内容与 Content-Type 不一致。');
  const extension = glb ? 'glb' : 'gltf';
  try { validateModelFileBytes(bytes, `result.${extension}`); }
  catch (error) { throw new ModelDownloadError(bytes.byteLength > MAX_IMPORTED_MODEL_BYTES ? 'too_large' : 'invalid_model', error instanceof Error ? error.message : String(error)); }
  return extension;
}

export async function readModelDownload(response: Response, signal?: AbortSignal): Promise<File> {
  signal?.throwIfAborted();
  if (!response.ok) throw new ModelDownloadError('network', `下载模型失败：HTTP ${response.status}`);
  if (Number(response.headers.get('content-length')) > MAX_IMPORTED_MODEL_BYTES) {
    await response.body?.cancel();
    throw new ModelDownloadError('too_large', '模型文件超过 100 MiB，已中止下载。');
  }
  if (!response.body) throw new ModelDownloadError('invalid_model', '模型下载响应为空。');
  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = []; let size = 0;
  const cancel = () => { void reader.cancel(signal?.reason); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_IMPORTED_MODEL_BYTES) throw new ModelDownloadError('too_large', '模型文件超过 100 MiB，已中止下载。');
      chunks.push(value);
    }
    const bytes = await new Blob(chunks).arrayBuffer();
    const extension = sniffGeneratedModel(bytes, response.headers.get('content-type') ?? '');
    return new File([bytes], `generated.${extension}`, { type: extension === 'glb' ? 'model/gltf-binary' : 'model/gltf+json' });
  } finally { signal?.removeEventListener('abort', cancel); await reader.cancel().catch(() => undefined); }
}

/** Stable per-job/output identity closes the crash window between library and job commits. */
export async function importGeneratedModelOutput(jobId: string, index: number, source: OutputSource, network: ModelDownloadNetwork,
  options: { signal?: AbortSignal; onImport?: () => Promise<void> } = {}): Promise<string> {
  const id = `generated-model:${jobId}:${index}`;
  options.signal?.throwIfAborted();
  if (await getImportedModel(id)) return id;
  let input: File | string;
  if (source.type === 'url' && isTauri()) {
    const requestId = crypto.randomUUID();
    const cancel = () => { void invoke('cancel_model_download', { requestId }).catch(() => undefined); };
    options.signal?.addEventListener('abort', cancel, { once: true });
    try {
      options.signal?.throwIfAborted();
      input = await invoke<string>('download_model_asset', { requestId, url: source.url, headers: source.headers ?? {}, network });
      options.signal?.throwIfAborted();
    } catch (error) {
      options.signal?.throwIfAborted();
      if (error && typeof error === 'object' && 'code' in error && 'message' in error) throw new ModelDownloadError(error.code as ModelDownloadErrorCode, String(error.message));
      throw error;
    } finally { options.signal?.removeEventListener('abort', cancel); }
  } else if (source.type === 'url') {
    const url = await resolveSecretTokens(source.url, true);
    const headers = await resolveSecretValue(source.headers ?? {});
    options.signal?.throwIfAborted();
    input = await readModelDownload(await fetch(url, { headers, signal: options.signal, credentials: 'omit', redirect: 'error' }), options.signal);
  } else {
    if (source.data.length > Math.ceil(MAX_IMPORTED_MODEL_BYTES / 3) * 4) throw new ModelDownloadError('too_large', '模型文件超过 100 MiB。');
    let decoded: string;
    try { decoded = atob(source.data); } catch { throw new ModelDownloadError('invalid_model', '模型 base64 内容无效。'); }
    const bytes = Uint8Array.from(decoded, (char) => char.charCodeAt(0)).buffer;
    const extension = sniffGeneratedModel(bytes, source.mime);
    input = new File([bytes], `generated.${extension}`, { type: extension === 'glb' ? 'model/gltf-binary' : 'model/gltf+json' });
  }
  options.signal?.throwIfAborted();
  await options.onImport?.();
  const asset = await importModelFile(input, { id, signal: options.signal });
  return asset.id;
}
