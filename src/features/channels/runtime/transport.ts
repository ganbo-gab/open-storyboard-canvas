/// <reference lib="es2024.promise" />
/// <reference lib="es2022.object" />
import { isTauri } from '@tauri-apps/api/core';
import { customHttpRequest, customHttpStreamRequest, type CustomHttpRequest } from '@/commands/ai';
import { loadImage, loadAudioSourceDataUrl, persistVideoSource, prepareNodeImageSourceWithHeaders } from '@/commands/image';
import { useSettingsStore } from '@/stores/settingsStore';
import { getAssetPortableSource } from '@/features/assets/application/assetMediaStorage';
import type { HttpRequest, ResolveRef } from '../domain/template';
import type { HttpTransport } from './templateAdapter';
import { isPublicReferenceUrl, ReferenceNeedsPublicUrlError } from '../domain/referenceErrors';
import { formatChannelError, normalizeChannelError, redactChannelErrorText } from '../domain/errors';
import { resolveSecretTokens, resolveSecretValue } from '@/features/secrets/secretStore';
import { createSecretResponseRedactor } from '@/features/secrets/transportSecrets';
import { credentialFailureOf } from '@/features/secrets/credentialFailure';

export class ChannelChatTransportError extends Error {
  constructor(message: string, readonly status?: number, readonly responseStarted = false, readonly upstreamMessage?: string, readonly retryAfterMs?: number) {
    super(message); this.name = 'ChannelChatTransportError';
  }
}

function streamFailure(request: HttpRequest, status: number | undefined, raw: string, started = false, retryAfterMs?: number): ChannelChatTransportError {
  const credentialFailure = credentialFailureOf(raw);
  if (credentialFailure) return new ChannelChatTransportError(JSON.stringify(credentialFailure), status, started);
  let safe = raw;
  // Auth names are user-defined: mask header/query values, not just well-known key names.
  for (const value of [...Object.values(request.headers), ...new URL(request.url).searchParams.values()]) {
    if (value) {
      safe = safe.split(value).join('[redacted]');
      const token = value.trim().split(/\s+/).at(-1);
      if (token && token !== value) safe = safe.split(token).join('[redacted]');
    }
  }
  safe = redactChannelErrorText(safe);
  return new ChannelChatTransportError(formatChannelError(normalizeChannelError(status, safe)), status, started, safe, retryAfterMs);
}

export function parseChannelRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value?.trim()) return undefined;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(delay) && delay >= 0 ? delay : undefined;
}

/** The request is already rendered. Transport never changes its headers, URL or body. */
export function createChannelHttpStreamTransport(network = useSettingsStore.getState().generationNetworkSettings, onStatus?: (status: number) => void) {
  const snapshot = { ...network };
  return async function* (request: HttpRequest): AsyncIterable<string> {
    request.signal?.throwIfAborted();
    if (request.body.mode !== 'json') throw new Error('文本流式渠道必须声明 JSON 请求体');
    if (isTauri()) {
      const chunks: string[] = [];
      let wake: (() => void) | undefined;
      let done = false; let failure: unknown; let count = 0; let status: number | undefined; let received = '';
      const notify = () => { wake?.(); wake = undefined; };
      const onAbort = () => { failure = new DOMException('The channel stream was aborted.', 'AbortError'); notify(); };
      request.signal?.addEventListener('abort', onAbort, { once: true });
      // Native cancellation is unavailable. Aborting stops delivery, never claims to cancel upstream work.
      void customHttpStreamRequest({ url: request.url, method: request.method, headers: request.headers,
        bodyMode: 'json', body: request.body.json, timeoutMs: 30 * 60 * 1000,
        networkRoute: snapshot.route, customProxyUrl: snapshot.customProxyUrl }, {
        onStatus: (value) => { status = value; onStatus?.(value); },
        onChunk: (chunk, value) => {
          status = value ?? status;
          if (failure || (status !== undefined && (status < 200 || status >= 300))) return;
          count += 1; received += chunk; chunks.push(chunk); notify();
        },
        onError: (_message, value) => {
          status = value ?? status;
          failure = streamFailure(request, status, _message, count > 0); notify();
        },
      }).then((response) => {
        status = response.status;
        if (status < 200 || status >= 300) failure = streamFailure(request, status, response.text, count > 0);
        // The bridge may miss trailing delivery events. Reconcile bytes from this same submit, never re-submit or duplicate deltas.
        if (!failure && response.text.startsWith(received) && response.text.length > received.length) chunks.push(response.text.slice(received.length));
        done = true; notify();
      }, (error: unknown) => { failure ??= streamFailure(request, status, error instanceof Error ? error.message : String(error), count > 0); done = true; notify(); });
      try {
        while (true) {
          if (failure) throw failure;
          if (chunks.length) { yield chunks.shift()!; continue; }
          if (done) break;
          await new Promise<void>((resolve) => { wake = resolve; });
        }
      } finally { request.signal?.removeEventListener('abort', onAbort); }
      return;
    }
    const redactor = await createSecretResponseRedactor({ url: request.url, headers: request.headers, body: request.body });
    request = { ...request, url: await resolveSecretTokens(request.url, true),
      headers: await resolveSecretValue(request.headers), body: await resolveSecretValue(request.body) };
    if (request.body.mode !== 'json') throw new Error('文本流式渠道必须声明 JSON 请求体');
    const response = await fetch(request.url, { method: request.method, headers: request.headers,
      body: JSON.stringify(request.body.json), signal: request.signal ?? AbortSignal.timeout(30 * 60 * 1000),
      credentials: 'omit', redirect: 'error' }).catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') throw error;
        throw new ChannelChatTransportError(redactor.redact(error instanceof Error ? error.message : 'Channel request failed'));
      });
    onStatus?.(response.status);
    if (!response.ok) throw streamFailure(request, response.status, redactor.redact(await response.text()), false,
      parseChannelRetryAfter(response.headers.get('retry-after')));
    if (!response.body) throw new ChannelChatTransportError('渠道流式响应为空', response.status);
    const reader = response.body.getReader(); const decoder = new TextDecoder();
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        const text = redactor.chunk(decoder.decode(result.value, { stream: true }));
        if (text) yield text;
      }
      const remaining = redactor.chunk(decoder.decode()) + redactor.finish(); if (remaining) yield remaining;
    } finally { await reader.cancel(); }
  };
}

export async function blobDataUrl(blob: Blob): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const reader = new FileReader(); reader.onload = () => resolve(String(reader.result));
  reader.onerror = () => reject(reader.error ?? new Error('无法读取素材')); reader.readAsDataURL(blob);
  return promise;
}
export const resolveChannelRef: ResolveRef = async (ref, encoding) => {
  if (encoding === 'url') {
    if (!isPublicReferenceUrl(ref.path)) throw new ReferenceNeedsPublicUrlError(ref);
    return ref.path;
  }
  let dataUrl = await getAssetPortableSource(ref.path);
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
      if (body.mode === 'form-urlencoded') { native.bodyMode = 'form-urlencoded'; native.body = Object.fromEntries(body.fields.map(({ name, value }) => [name, value])); }
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
    const redactor = await createSecretResponseRedactor({ url: request.url, headers: request.headers, body: request.body });
    request = { ...request, url: await resolveSecretTokens(request.url, true),
      headers: await resolveSecretValue(request.headers), body: await resolveSecretValue(request.body) };
    let body: BodyInit | undefined;
    const headers = { ...request.headers };
    if (request.body.mode === 'json') body = JSON.stringify(request.body.json);
    if (request.body.mode === 'form-urlencoded') body = new URLSearchParams(request.body.fields.map(({ name, value }) => [name, value]));
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
      signal: request.signal ?? AbortSignal.timeout(9 * 60 * 1000), credentials: 'omit', redirect: 'error' }).catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') throw error;
        throw new Error(redactor.redact(error instanceof Error ? error.message : 'Channel request failed'));
      });
    return { status: response.status, headers: Object.fromEntries([...response.headers].map(([name, value]) => [name, redactor.redact(value)])),
      bodyText: redactor.redact(await response.text()) };
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
