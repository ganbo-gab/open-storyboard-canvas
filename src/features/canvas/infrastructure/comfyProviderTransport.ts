import { customHttpRequest, type CustomHttpResponse } from '@/commands/ai';
import { useSettingsStore } from '@/stores/settingsStore';
import type { CustomProviderConfig } from '@/stores/customProvidersStore';
import { applyComfyUIAuth, resolveComfyUIProviderAuth, resolveComfyUIUrls, type ComfyUIAuth } from '@/features/channels/adapters/comfyui/url';
import type { ComfyUITransport } from './comfyuiGateway';
import { createSecretResponseRedactor } from '@/features/secrets/transportSecrets';

export class ComfyUIControlError extends Error {
  constructor(message: string, readonly status?: number) { super(message); this.name = 'ComfyUIControlError'; }
}

/** Independent ComfyUI control API; paid workflow submissions use comfyExecution. */
export function createComfyProviderTransport(cfg: CustomProviderConfig): ComfyUITransport {
  const base = resolveComfyUIUrls(cfg.baseUrl).base;
  const resolved = resolveComfyUIProviderAuth(cfg);
  const auth: ComfyUIAuth = resolved.config.mode === 'none' ? { mode: 'none' }
    : resolved.config.mode === 'bearer' ? { mode: 'bearer', value: resolved.value }
    : { mode: resolved.config.mode, name: 'name' in resolved.config ? resolved.config.name : '', value: resolved.value };
  const headers = { ...cfg.extraHeaders };
  const query = { ...cfg.queryParams };
  const sensitiveValues = [cfg.apiKey, ...Object.values(headers), ...Object.values(query)].filter(Boolean);
  const redact = (text: string): string => {
    for (const value of sensitiveValues) {
      for (const variant of [value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1)]) text = text.split(variant).join('[redacted]');
    }
    return text;
  };
  const address = (path: string, params: Record<string, string> = {}) => {
    const applied = applyComfyUIAuth(`${base}/${path.replace(/^\/+/, '')}`, auth);
    const url = new URL(applied.url);
    for (const [name, value] of Object.entries({ ...query, ...params })) url.searchParams.set(name, value);
    return { url: url.href, headers: { ...applied.headers, ...headers } };
  };
  const network = { ...useSettingsStore.getState().generationNetworkSettings };
  const request = async (path: string, method: 'GET' | 'POST', body?: unknown, multipart?: Parameters<ComfyUITransport['multipart']>[1]) => {
    const addressed = address(path);
    const redactor = await createSecretResponseRedactor(addressed);
    let response: CustomHttpResponse;
    try {
      response = await customHttpRequest({ ...addressed, method,
        bodyMode: multipart ? 'multipart' : 'json', body, multipart, timeoutMs: 30000,
        networkRoute: network.route, customProxyUrl: network.customProxyUrl });
    } catch (cause) {
      throw new ComfyUIControlError(redact(redactor.redact(cause instanceof Error ? cause.message : String(cause))));
    }
    const text = redact(redactor.redact(response.text));
    if (response.status < 200 || response.status >= 300) throw new ComfyUIControlError(`ComfyUI HTTP ${response.status}: ${text}`, response.status);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error(`ComfyUI ${method} ${path} 返回了无效的 JSON；请确认地址指向 ComfyUI API，而不是登录页或代理错误页。`);
    }
  };
  return { json: (path, method, body) => request(path, method, body), multipart: (path, body) => request(path, 'POST', undefined, body),
    url: (path, params) => address(path, params).url };
}
