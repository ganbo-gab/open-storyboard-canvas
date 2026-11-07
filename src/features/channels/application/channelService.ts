import { channelProfileSchema, validateProfile, templateVariables, type ChannelProfileV2, type ProfileValidationError } from '../domain/profile';
import { renderPreview, renderRequest, resolveJobOperation, resolveParamValue } from '../domain/template';
import type { JobInput, JsonValue, ChatMessage } from '../runtime/types';
import { TemplateAdapter } from '../runtime/templateAdapter';
import { createChannelHttpTransport, createChannelHttpStreamTransport, resolveChannelRef } from '../runtime/transport';
import { submitChannelJob } from '../runtime/channelExecution';
import { ensureChannelStoresHydrated, useChannelStore, saveChannelRecord, removeChannelRecord, getChannelCredential, setChannelCredential, projectChannelProviders, type ChannelRecord } from '../store/channelStore';
import { parseCustomProviderModelId } from '@/features/canvas/application/imageProviderContracts';
import { resolveModelMode } from './modelModes';
import { ChannelRequestFailure } from '../domain/errors';
import { adaptChannelChatPayload } from '../runtime/channelChatPayload';
import { previewChannelSmokeRequest } from '../runtime/channelSmokeRequest';

export function resolveNativeChannelModel(catalogId: string) {
  const parsed = parseCustomProviderModelId(catalogId) ?? (catalogId.startsWith('agnes:chat:')
    ? { providerId: 'settings-agnes-chat', upstreamModel: catalogId.slice('agnes:chat:'.length) } : null);
  if (!parsed) return null;
  const channels = useChannelStore.getState().channels;
  const projection = projectChannelProviders(channels).find((provider) => provider.id === parsed.providerId);
  const channelId = projection?.extraParams?.channelProfileId;
  const record = channels.find((entry) => entry.profile.id === (channelId ?? parsed.providerId));
  if (!record) return null;
  const profile = record.profile;
  const model = profile?.models.find((entry) => entry.id === parsed.upstreamModel);
  return profile && model ? { profile, model } : null;
}

export type ProfileImportResult = { ok: true; profile: ChannelProfileV2; errors: [] }
  | { ok: false; errors: ProfileValidationError[] };
/** Accept a raw JSON object or a single JSON fenced block, never evaluate JS or silently pick one of many profiles. */
export function parseProfileImport(text: string): ProfileImportResult {
  if (new TextEncoder().encode(text).length > 1024 * 1024) return { ok: false, errors: [{ path: '', message: '配置文本超过 1MB' }] };
  const trimmed = text.replace(/^\uFEFF/, '').trim();
  const blocks = [...trimmed.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/gi)];
  if (blocks.length > 1) return { ok: false, errors: [{ path: '', message: '请只粘贴一个渠道 JSON 配置块' }] };
  const source = blocks.length === 1 ? blocks[0][1].trim() : trimmed;
  let input: unknown;
  try { input = JSON.parse(source); } catch (error) {
    return { ok: false, errors: [{ path: '', message: `JSON 无法解析：${error instanceof Error ? error.message : String(error)}` }] };
  }
  const errors = validateProfile(input);
  return errors.length ? { ok: false, errors } : { ok: true, profile: channelProfileSchema.parse(input), errors: [] };
}
export function listChannels() { return useChannelStore.getState().channels; }
function ensureCredentialSeparation(profile: ChannelProfileV2, credential: string): void {
  if (credential && JSON.stringify(profile).includes(JSON.stringify(credential).slice(1, -1))) throw new Error('请将密钥移到独立 API Key 栏，不能保存在配置 JSON 中');
}
export async function createChannel(input: ChannelProfileV2, credential = ''): Promise<ChannelRecord> {
  await ensureChannelStoresHydrated();
  const profile = channelProfileSchema.parse(input);
  if (listChannels().some((entry) => entry.profile.id === profile.id)) throw new Error('渠道 ID 已存在，请修改 ID 或使用更新操作');
  ensureCredentialSeparation(profile, credential);
  if (credential) await setChannelCredential(profile.id, credential);
  return saveChannelRecord(profile);
}
export async function updateChannel(id: string, input: ChannelProfileV2, credential?: string): Promise<ChannelRecord> {
  await ensureChannelStoresHydrated();
  const previous = listChannels().find((entry) => entry.profile.id === id);
  if (!previous) throw new Error('渠道不存在');
  const profile = channelProfileSchema.parse(input);
  if (profile.id !== id) throw new Error('更新不能更改渠道 ID');
  ensureCredentialSeparation(profile, credential ?? getChannelCredential(id));
  if (credential !== undefined) await setChannelCredential(id, credential);
  return saveChannelRecord(profile);
}
export function deleteChannel(id: string): void {
  removeChannelRecord(id);
}
/** Generic smoke jobs use the same explicit protocol codec as public chat callers. */
export function normalizeChannelSmokeInput(profile: ChannelProfileV2, job: JobInput): JobInput {
  if (job.operation !== 'chat' || job.messages !== undefined || job.chatPayload !== undefined) return job;
  const model = profile.models.find((entry) => entry.id === job.modelId);
  if (!model) throw new Error('缺少或未声明模型');
  const resolved = resolveModelMode(model, job.modeId);
  const params: Record<string, JsonValue> = {};
  for (const key of Object.keys(job.params)) {
    if (!resolved.params.some((param) => param.key === key)) throw new Error(`渠道未声明文本请求参数 ${key}；请求未发送`);
  }
  for (const param of resolved.params) {
    const value = resolveParamValue(param, job.params[param.key]);
    if (value !== undefined) params[param.key] = value;
  }
  const payload = adaptChannelChatPayload(profile, { ...params,
    messages: [{ role: 'user', content: job.prompt }],
    ...(job.modeId !== undefined ? { channel_mode_id: job.modeId } : {}),
    ...(job.tools !== undefined ? { tools: job.tools } : {}),
    ...(job.toolChoice !== undefined ? { tool_choice: job.toolChoice } : {}),
  }, job.modelId);
  const chat = channelChatInput(profile, job.modelId, payload);
  return { ...job, ...chat, jobId: job.jobId, prompt: job.prompt, params: { ...params, ...chat.params }, refs: job.refs, count: job.count };
}
export function previewChannel(profile: ChannelProfileV2, job: JobInput) {
  const parsed = channelProfileSchema.parse(profile);
  // Fully adapted chat jobs also serve ordinary SSE previews, outside the smoke executor.
  return job.operation === 'chat' && job.messages === undefined && job.chatPayload === undefined
    ? previewChannelSmokeRequest(parsed, normalizeChannelSmokeInput(parsed, job)) : renderPreview(parsed, job);
}
export async function testChannelModels(profile: ChannelProfileV2, credential = getChannelCredential(profile.id), signal?: AbortSignal) {
  // Testing never falls back to a paid chat/image submit.
  if (!profile.operations['models.list']) return { ok: false as const, error: { category: 'validation' as const, message: '渠道未声明免费的 models.list 操作', retryable: false } };
  return new TemplateAdapter({ profile: channelProfileSchema.parse(profile), apiKey: credential,
    http: createChannelHttpTransport(), resolveRef: resolveChannelRef }).listModels(signal);
}
/** Explicit paid-operation boundary. The caller owns confirmation; no automatic smoke call occurs on save/import/test. */
export async function submitChannelSmoke(profile: ChannelProfileV2, job: JobInput, credential = getChannelCredential(profile.id), signal?: AbortSignal): Promise<string> {
  if (job.operation === 'models.list') throw new Error('模型列表请使用免费测试操作');
  const parsed = channelProfileSchema.parse(profile);
  const normalized = normalizeChannelSmokeInput(parsed, job);
  previewChannelSmokeRequest(parsed, normalized);
  return submitChannelJob(parsed, normalized, credential, signal);
}
export function channelChatInput(profile: ChannelProfileV2, modelId: string, payload: unknown): JobInput {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('文本请求必须是 JSON 对象');
  const record = { ...payload } as Record<string, unknown>;
  const model = profile.models.find((entry) => entry.id === modelId);
  const modeId = record.channel_mode_id;
  if (modeId !== undefined && typeof modeId !== 'string') throw new Error('文本请求 channel_mode_id 必须是模式 ID');
  delete record.channel_mode_id;
  const resolved = model?.modes ? resolveModelMode(model, typeof modeId === 'string' ? modeId : model.modes.find((mode) => mode.operation === 'chat')?.id) : undefined;
  const op = resolved?.operationSpec ?? profile.operations.chat;
  if (!model || (model.modes ? resolved?.operation !== 'chat' : !model.operations.includes('chat')) || !op) throw new Error('所选渠道模型不支持文本对话');
  const path = op.path;
  const geminiMode = path.includes('{{chatPayload.action}}') && path.includes('{{chatPayload.alt}}');
  if (geminiMode) {
    record.action = record.stream === true ? 'streamGenerateContent' : 'generateContent';
    record.alt = record.stream === true ? 'sse' : 'json';
  }
  const messages = record.messages;
  if (messages !== undefined && (!Array.isArray(messages) || !messages.length)) throw new Error('文本请求 messages 无效');
  const template = op.template;
  const fields = template && typeof template === 'object' && !Array.isArray(template) ? template : {};
  const variables = new Set([...templateVariables(template), ...templateVariables(path)]);
  const mapped = (key: string) => variables.has(`chatPayload.${key}`);
  if (messages !== undefined && fields.messages !== '{{messages}}' && !mapped('messages')) throw new Error('此渠道未声明完整 messages 映射；不能静默转换消息、图片或工具历史');
  if (!messages && !['input', 'contents'].some((key) => record[key] !== undefined && mapped(key))) throw new Error('文本请求缺少渠道声明的消息输入');
  const normalized: ChatMessage[] = (Array.isArray(messages) ? messages : []).map((message) => {
    if (!message || typeof message !== 'object' || Array.isArray(message) || !['system', 'user', 'assistant', 'tool'].includes(message.role)) throw new Error('文本消息 role 无效');
    // Preserve provider message extensions, multimodal parts and tool-only null content.
    return { ...message, content: message.content ?? null } as ChatMessage;
  });
  const params: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined || key === 'model') continue;
    if (key === 'stream' && geminiMode) continue;
    if (key === 'messages' && fields.messages === '{{messages}}') continue;
    if (mapped(key)) continue;
    if (key === 'tools' && fields.tools === '{{tools}}') continue;
    if (key === 'tool_choice' && fields.tool_choice === '{{toolChoice}}') continue;
    const param = (resolved?.params ?? model.params).find((entry) => entry.key === key);
    if (param && fields[key] === `{{param.${key}}}`) { params[key] = value as JsonValue; continue; }
    if (Object.hasOwn(fields, key) && JSON.stringify(fields[key]) === JSON.stringify(value)) continue;
    // false is an execution-mode request, not a field to inject into an undeclared template.
    if (key === 'stream' && value === false && fields.stream === undefined) continue;
    throw new Error(`渠道模板未声明文本请求字段 ${key}；请求未发送，避免静默丢失参数`);
  }
  return { jobId: `chat-${crypto.randomUUID()}`, channelId: profile.id, modelId, ...(resolved ? { modeId: resolved.mode.id } : {}), operation: 'chat',
    prompt: normalized.filter((message) => message.role === 'user').map((message) => typeof message.content === 'string' ? message.content : '').join('\n'),
    messages: normalized, chatPayload: record as JsonValue, tools: record.tools as JsonValue | undefined, toolChoice: record.tool_choice as JsonValue | undefined, params, refs: [], count: 1 };
}
export async function submitChannelChat(profile: ChannelProfileV2, modelId: string, payload: unknown, signal?: AbortSignal): Promise<{ text: string; raw: unknown; status?: number }> {
  const record = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
  const job = channelChatInput(profile, modelId, { ...record, stream: false });
  let raw: unknown; let status: number | undefined;
  const result = await new TemplateAdapter({ profile, apiKey: getChannelCredential(profile.id),
    http: createChannelHttpTransport(), resolveRef: resolveChannelRef,
    onChatResponse: (response, http) => { raw = response; status = http.status; } }).submit(job, signal);
  if (result.state !== 'done') {
    if (result.state === 'submitted') throw new Error('chat 操作必须返回同步文本结果');
    throw new ChannelRequestFailure(result.error, getChannelCredential(profile.id));
  }
  const text = result.outputs.flatMap((output) => output.kind === 'text' ? [output.text] : []).join('\n');
  // Tool-only replies have no text; the actual response goes straight to the
  // existing Agent codec and is never reconstructed or persisted as a snapshot.
  return { text, raw, status };
}

/** A single real streaming submit, rendered by the same template as its preview. Never retries. */
export async function* streamChannelChat(profile: ChannelProfileV2, modelId: string, payload: unknown, signal?: AbortSignal, onStatus?: (status: number) => void): AsyncIterable<string> {
  const record = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
  const job = channelChatInput(profile, modelId, { ...record, stream: true });
  const op = resolveJobOperation(profile, job);
  if (op.response.mode !== 'sync') throw new Error('chat 流式操作必须是同步响应');
  const rendered = await renderRequest(profile, job, getChannelCredential(profile.id), resolveChannelRef);
  rendered.request.signal = signal;
  yield* createChannelHttpStreamTransport(undefined, onStatus)(rendered.request);
}
