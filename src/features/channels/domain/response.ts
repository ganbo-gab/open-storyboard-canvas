import type { AsyncResponse, ChannelProfileV2, OperationKind, OutputSpec } from './profile';
import { render, TemplateValidationError } from './template';
import type { MediaKind, Output } from '../runtime/types';

/** Dotted paths, numeric indices, wildcard expansion, and explicit JSON-string decoding. */
export function getPathValues(payload: unknown, path: string): unknown[] {
  if (!path) return [payload];
  const [head, ...decoded] = path.split('|json.');
  const tokens = head.replace(/\[(\*|\d+)\]/g, '.$1').split('.').filter(Boolean);
  let values: unknown[] = [payload];
  for (const token of tokens) values = values.flatMap((value) => {
    if (token === '*') return Array.isArray(value) ? value : [];
    if (!value || typeof value !== 'object' || !Object.prototype.hasOwnProperty.call(value, token)) return [];
    return [(value as Record<string, unknown>)[token]];
  });
  if (decoded.length) return values.flatMap((value) => {
    if (typeof value !== 'string') return [];
    try { return getPathValues(JSON.parse(value), decoded.join('|json.')); } catch { return []; }
  });
  return values;
}
export function getPath(payload: unknown, path: string): unknown {
  const values = getPathValues(payload, path);
  return path.includes('[*]') ? values : values[0];
}
export function extractError(payload: unknown, errorPath?: string): string | undefined {
  if (!errorPath) return undefined;
  const value = getPathValues(payload, errorPath)[0];
  if (value === undefined || value === null || value === '') return undefined;
  return typeof value === 'string' ? value : JSON.stringify(value);
}
export interface OutputContext { profile: ChannelProfileV2; apiKey: string; taskId?: string; submit?: unknown }
export function extractOutputs(payload: unknown, specs: OutputSpec[], operation: OperationKind, context?: OutputContext): Output[] {
  const kind: MediaKind = operation.startsWith('video.') ? 'video' : operation.startsWith('audio.') ? 'audio' : 'image';
  const outputs: Output[] = [];
  const seen = new Set<string>();
  for (const spec of specs) {
    if ('url' in spec) {
      if (!context) continue;
      const rendered = render(spec.url, { taskId: context.taskId ? encodeURIComponent(context.taskId) : undefined, submit: context.submit }, ['taskId']);
      if (typeof rendered !== 'string') throw new TemplateValidationError('outputs.url', '结果 URL 缺少模板变量');
      if (!/^https?:\/\//i.test(rendered) && (!rendered.startsWith('/') || rendered.startsWith('//'))) throw new TemplateValidationError('outputs.url', '结果 URL 必须是相对路径或同源绝对地址');
      const url = new URL(rendered, context.profile.baseUrl);
      if (url.origin !== new URL(context.profile.baseUrl).origin || url.username || url.password) throw new TemplateValidationError('outputs.url', '结果 URL 必须与渠道同源');
      const headers: Record<string, string> = {};
      if (spec.auth) {
        Object.assign(headers, context.profile.headers);
        const auth = context.profile.auth;
        if (auth.type === 'bearer') headers.Authorization = `Bearer ${context.apiKey}`;
        if (auth.type === 'header') headers[auth.name] = `${auth.prefix ?? ''}${context.apiKey}`;
        if (auth.type === 'query') url.searchParams.set(auth.name, context.apiKey);
      }
      outputs.push({ kind: spec.kind, source: { type: 'url', url: url.toString(), ...(Object.keys(headers).length ? { headers } : {}) } });
      continue;
    }
    for (const value of getPathValues(payload, spec.path)) {
    if (typeof value !== 'string' || !value.trim()) continue;
    const media = spec.kind ?? kind;
    let output: Output;
    if (spec.as === 'url') {
      if (!/^https?:\/\//i.test(value)) continue;
      output = { kind: media, source: { type: 'url', url: value } };
    } else if (spec.as === 'data-url') {
      const match = /^data:([^;,]+);base64,([\s\S]+)$/.exec(value);
      if (!match) continue;
      output = { kind: media, source: { type: 'base64', data: match[2], mime: match[1] } };
    } else output = { kind: media, source: { type: 'base64', data: value, mime: media === 'video' ? 'video/mp4' : media === 'audio' ? 'audio/mpeg' : 'image/png' } };
    const key = JSON.stringify(output);
    if (!seen.has(key)) { seen.add(key); outputs.push(output); }
    }
  }
  return outputs;
}
export function classifyAsyncStatus(payload: unknown, response: AsyncResponse, operation: OperationKind, errorPath?: string, context?: OutputContext): { state: 'pending' | 'done' | 'failed'; outputs: Output[]; progress?: number; message?: string } {
  const outputs = extractOutputs(payload, response.poll.outputs.filter((spec) => 'path' in spec), operation, context);
  const message = extractError(payload, errorPath);
  const rawStatus = response.poll.statusPath ? getPathValues(payload, response.poll.statusPath)[0] : undefined;
  const status = String(rawStatus ?? '').trim().toLowerCase();
  const failure = response.poll.failure.some((value) => value.toLowerCase() === status);
  const success = response.poll.success.some((value) => value.toLowerCase() === status);
  const state = failure || (!response.poll.statusPath && message) ? 'failed' : success || ((!response.poll.statusPath || response.poll.success.length === 0) && outputs.length > 0) ? 'done' : 'pending';
  const progress = response.poll.progressPath ? getPathValues(payload, response.poll.progressPath)[0] : undefined;
  return { state, outputs, ...(typeof progress === 'number' && Number.isFinite(progress) ? { progress } : {}), ...(message ? { message } : {}) };
}
export function extractChatText(payload: unknown): string | undefined {
  // These are protocol response fields, not inferred request parameters.
  const paths = ['choices[0].message.content', 'content[*].text', 'candidates[*].content.parts[*].text', 'output[*].content[*].text', 'output_text'];
  for (const path of paths) {
    const text = getPathValues(payload, path).filter((item): item is string => typeof item === 'string').join('');
    if (text) return text;
  }
  return undefined;
}
