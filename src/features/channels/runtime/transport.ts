/// <reference lib="es2024.promise" />
/// <reference lib="es2022.object" />
import { isTauri } from '@tauri-apps/api/core';
import { customHttpRequest, type CustomHttpRequest } from '@/commands/ai';
import { loadImage, loadAudioSourceDataUrl, persistVideoSource, prepareNodeImageSourceWithHeaders } from '@/commands/image';
import { useSettingsStore } from '@/stores/settingsStore';
import type { HttpRequest, ResolveRef } from '../domain/template';
import type { HttpTransport } from './templateAdapter';

export async function blobDataUrl(blob: Blob): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const reader = new FileReader(); reader.onload = () => resolve(String(reader.result));
  reader.onerror = () => reject(reader.error ?? new Error('无法读取素材')); reader.readAsDataURL(blob);
  return promise;
}
export const resolveChannelRef: ResolveRef = async (ref, encoding) => {
  if (encoding === 'url') {
    if (!/^https?:\/\//i.test(ref.path)) throw new Error('此渠道要求可访问的素材 URL，不能把本机文件路径发送给上游');
    return ref.path;
  }
  let dataUrl = ref.path;
  if (!dataUrl.startsWith('data:')) {
    if (isTauri()) {
      let path = ref.path;
      if (ref.kind === 'audio') dataUrl = await loadAudioSourceDataUrl(path);
      else {
        if (/^https?:\/\//i.test(path)) path = ref.kind === 'image'
          ? (await prepareNodeImageSourceWithHeaders(path, {})).imagePath : await persistVideoSource(path);
        dataUrl = await loadImage(path.replace(/^file:\/\//, ''));
      }
      dataUrl = dataUrl.replace(/^data:[^;,]+/, `data:${ref.mime}`);
    } else {
      const response = await fetch(ref.path);
      if (!response.ok) throw new Error(`读取参考素材失败：HTTP ${response.status}`);
      dataUrl = await blobDataUrl(await response.blob());
    }
  }
  if (encoding === 'base64') {
    const match = /^data:[^,]*;base64,(.*)$/s.exec(dataUrl);
    if (!match) throw new Error('参考素材不是 base64 data URL');
    return match[1];
  }
  return dataUrl;
};

/** Native transport never falls back to fetch: bridge errors must remain visible. */
export function createChannelHttpTransport(network = useSettingsStore.getState().generationNetworkSettings): HttpTransport {
  const snapshot = { ...network };
  return async (request: HttpRequest) => {
    request.signal?.throwIfAborted();
    if (isTauri()) {
      const body = request.body;
      const native: CustomHttpRequest = { url: request.url, method: request.method, headers: request.headers,
        timeoutMs: 9 * 60 * 1000, networkRoute: snapshot.route, customProxyUrl: snapshot.customProxyUrl };
      if (body.mode === 'json') { native.bodyMode = 'json'; native.body = body.json; }
      if (body.mode === 'multipart') {
        native.bodyMode = 'multipart';
        native.multipart = { fields: body.fields, files: await Promise.all(body.files.map(async (file) => ({
          name: file.name, fileName: file.filename, mimeType: file.mime,
          dataUrl: await resolveChannelRef({ kind: file.mime.startsWith('video/') ? 'video' : file.mime.startsWith('audio/') ? 'audio' : 'image',
            assetId: file.path, path: file.path, mime: file.mime }, 'data-url'),
        }))) };
      }
      const response = await customHttpRequest(native);
      // A native request already sent cannot be cancelled safely. Consume its task ID
      // even if the view unmounts; the executor persists it before stopping polling.
      return { status: response.status, headers: {}, bodyText: response.text };
    }
    let body: BodyInit | undefined;
    const headers = { ...request.headers };
    if (request.body.mode === 'json') body = JSON.stringify(request.body.json);
    if (request.body.mode === 'multipart') {
      const form = new FormData();
      for (const field of request.body.fields) form.append(field.name, field.value);
      for (const file of request.body.files) {
        const source = await resolveChannelRef({ kind: 'image', assetId: file.path, path: file.path, mime: file.mime }, 'data-url');
        form.append(file.name, await (await fetch(source)).blob(), file.filename);
      }
      for (const key of Object.keys(headers)) if (key.toLowerCase() === 'content-type') delete headers[key];
      body = form;
    }
    const response = await fetch(request.url, { method: request.method, headers, body,
      signal: request.signal ?? AbortSignal.timeout(9 * 60 * 1000), credentials: 'omit', redirect: 'error' });
    return { status: response.status, headers: Object.fromEntries(response.headers.entries()), bodyText: await response.text() };
  };
}

export const MAX_CHANNEL_DOC_BYTES = 200 * 1024;
export async function fetchChannelDocument(url: string, signal?: AbortSignal): Promise<string> {
  const parsed = new URL(url);
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('文档地址必须是无账号密码的 HTTP(S) URL');
  if ([...parsed.searchParams.keys()].some((key) => /key|token|secret|signature|credential|password/i.test(key))) throw new Error('文档 URL 不能携带密钥参数');
  signal?.throwIfAborted();
  if (isTauri()) {
    const response = await customHttpRequest({ url: parsed.href, method: 'GET', headers: { Accept: 'text/html,text/plain,application/json' },
      timeoutMs: 30000, maxResponseBytes: MAX_CHANNEL_DOC_BYTES });
    signal?.throwIfAborted();
    if (response.status < 200 || response.status >= 300) throw new Error(`抓取文档失败：HTTP ${response.status}`);
    return response.text;
  }
  const response = await fetch(parsed.href, { signal: signal ?? AbortSignal.timeout(30000), credentials: 'omit', redirect: 'error' });
  if (!response.ok) throw new Error(`抓取文档失败：HTTP ${response.status}`);
  if (Number(response.headers.get('content-length')) > MAX_CHANNEL_DOC_BYTES) throw new Error('文档超过 200KB，请粘贴相关接口片段');
  if (!response.body) throw new Error('文档响应为空');
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let size = 0; let text = '';
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > MAX_CHANNEL_DOC_BYTES) throw new Error('文档超过 200KB，请粘贴相关接口片段');
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally { await reader.cancel(); }
}
