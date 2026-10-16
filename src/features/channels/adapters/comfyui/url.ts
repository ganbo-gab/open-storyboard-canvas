export type ComfyUIAuth =
  | { mode: 'none' }
  | { mode: 'bearer'; value: string }
  | { mode: 'header'; name: string; value: string }
  | { mode: 'query'; name: string; value: string };

/** Shared with legacy provider URL handling; protocol selection stays adapter-specific. */
export function sanitizeProviderUrlInput(value: string): string {
  return value.trim().replace(/：/g, ':').replace(/\s+/g, '');
}

/** Serializable endpoint strings, safe to persist in a job snapshot. */
export interface ComfyUIResolvedUrls {
  base: string;
  prompt: string;
  history: string;
  view: string;
  ws: string;
  objectInfo: string;
  systemStats: string;
  upload: string;
  defaultedScheme: boolean;
  strippedPath: string | null;
}

export function resolveComfyUIUrls(input: string): ComfyUIResolvedUrls {
  const value = sanitizeProviderUrlInput(input);
  if (!value) throw new Error('请填写 ComfyUI 地址。');
  const explicit = /^[a-z][a-z\d+.-]*:\/\//i.test(value);
  const url = new URL(explicit ? value : `http://${value.replace(/^\/\//, '')}`);
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
    throw new Error('ComfyUI 地址必须使用 http 或 https，且不能包含用户名或密码。');
  }
  const path = url.pathname.replace(/\/+$/, '');
  // Keep a reverse-proxy prefix, but remove pasted Comfy API endpoints.
  const match = /\/(?:api(?:\/.*)?|prompt|history(?:\/.*)?|view|ws|object_info(?:\/.*)?|system_stats|upload(?:\/.*)?)$/i.exec(path);
  const prefix = match ? path.slice(0, match.index) : path;
  url.pathname = prefix || '/';
  url.search = '';
  url.hash = '';
  const base = url.toString().replace(/\/+$/, '');
  return {
    base, prompt: `${base}/prompt`, history: `${base}/history`, view: `${base}/view`,
    ws: `${base.replace(/^http/, 'ws')}/ws`, objectInfo: `${base}/object_info`,
    systemStats: `${base}/system_stats`, upload: `${base}/upload/image`,
    defaultedScheme: !explicit, strippedPath: match?.[0] ?? null,
  };
}

export function comfyUIHistoryUrl(urls: ComfyUIResolvedUrls, id: string): string {
  return `${urls.history}/${encodeURIComponent(id)}`;
}

export function comfyUIViewUrl(urls: ComfyUIResolvedUrls, params: Record<string, string>): string {
  const url = new URL(urls.view);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  return url.toString();
}

export function comfyUIWebSocketUrl(urls: ComfyUIResolvedUrls, clientId: string): string {
  const url = new URL(urls.ws);
  url.searchParams.set('clientId', clientId);
  return url.toString();
}

/** Authentication mode is honored even when its configured value is empty. */
export function applyComfyUIAuth(url: string, auth: ComfyUIAuth): { url: string; headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  if (auth.mode === 'bearer' && /[\r\n]/.test(auth.value)) throw new Error('ComfyUI 鉴权头无效。');
  if (auth.mode === 'bearer') headers.Authorization = `Bearer ${auth.value}`;
  if (auth.mode === 'header') {
    if (!/^[!#$%&'*+.^_`|~\w-]+$/.test(auth.name) || /[\r\n]/.test(auth.value)) throw new Error('ComfyUI 鉴权头无效。');
    headers[auth.name] = auth.value;
  }
  if (auth.mode === 'query') {
    if (!auth.name.trim()) throw new Error('ComfyUI 鉴权查询参数名不能为空。');
    const parsed = new URL(url);
    parsed.searchParams.set(auth.name, auth.value);
    url = parsed.toString();
  }
  return { url, headers };
}
