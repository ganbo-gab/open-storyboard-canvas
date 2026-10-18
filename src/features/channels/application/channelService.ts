import { channelProfileSchema, validateProfile, type ChannelProfileV2, type ProfileValidationError } from '../domain/profile';
import { renderPreview } from '../domain/template';
import type { JobInput, JsonValue, ChatMessage } from '../runtime/types';
import { TemplateAdapter } from '../runtime/templateAdapter';
import { createChannelHttpTransport, resolveChannelRef } from '../runtime/transport';
import { submitChannelJob } from '../runtime/channelExecution';
import { useChannelStore, saveChannelRecord, removeChannelRecord, getChannelCredential, setChannelCredential } from '../store/channelStore';
import { useCustomProvidersStore } from '@/stores/customProvidersStore';
import { parseCustomProviderModelId } from '@/features/canvas/application/imageProviderContracts';

export function resolveNativeChannelModel(catalogId: string) {
  const parsed = parseCustomProviderModelId(catalogId);
  if (!parsed) return null;
  const projection = useCustomProvidersStore.getState().providers.find((provider) => provider.id === parsed.providerId);
  const channelId = projection?.extraParams?.channelProfileId;
  if (typeof channelId !== 'string') return null;
  const profile = useChannelStore.getState().channels.find((entry) => entry.origin === 'native' && entry.profile.id === channelId)?.profile;
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
export function createChannel(input: ChannelProfileV2, credential = '') {
  const profile = channelProfileSchema.parse(input);
  if (listChannels().some((entry) => entry.profile.id === profile.id)) throw new Error('渠道 ID 已存在，请修改 ID 或使用更新操作');
  ensureCredentialSeparation(profile, credential);
  const record = saveChannelRecord(profile);
  if (credential) setChannelCredential(profile.id, credential);
  return record;
}
export function updateChannel(id: string, input: ChannelProfileV2, credential?: string) {
  const previous = listChannels().find((entry) => entry.profile.id === id);
  if (!previous) throw new Error('渠道不存在');
  const profile = channelProfileSchema.parse(input);
  if (profile.id !== id) throw new Error('更新不能更改渠道 ID');
  ensureCredentialSeparation(profile, credential ?? getChannelCredential(id));
  const record = saveChannelRecord(profile);
  if (credential !== undefined) setChannelCredential(id, credential);
  if (previous.origin === 'legacy') useCustomProvidersStore.getState().removeProvider(id);
  return record;
}
export function deleteChannel(id: string): void {
  const record = listChannels().find((entry) => entry.profile.id === id);
  removeChannelRecord(id);
  if (record?.origin === 'legacy') useCustomProvidersStore.getState().removeProvider(id);
}
export function previewChannel(profile: ChannelProfileV2, job: JobInput) {
  return renderPreview(channelProfileSchema.parse(profile), job);
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
  return submitChannelJob(profile, job, credential, signal);
}
export function channelChatInput(profile: ChannelProfileV2, modelId: string, payload: unknown): JobInput {
  const record = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const messages = record.messages;
  if (!Array.isArray(messages) || !messages.length) throw new Error('文本请求缺少 messages');
  const normalized: ChatMessage[] = messages.map((message) => {
    if (!message || typeof message !== 'object' || !['system', 'user', 'assistant', 'tool'].includes(message.role)) throw new Error('文本消息 role 无效');
    // Tool-only assistant messages legitimately have null content.
    return { role: message.role as ChatMessage['role'], content: (message.content ?? null) as JsonValue,
      ...(Array.isArray(message.tool_calls) ? { tool_calls: message.tool_calls as JsonValue[] } : {}),
      ...(typeof message.tool_call_id === 'string' ? { tool_call_id: message.tool_call_id } : {}),
      ...(typeof message.name === 'string' ? { name: message.name } : {}) };
  });
  const model = profile.models.find((entry) => entry.id === modelId);
  const params: Record<string, JsonValue> = {};
  for (const param of model?.params ?? []) if (record[param.key] !== undefined) params[param.key] = record[param.key] as JsonValue;
  return { jobId: `chat-${crypto.randomUUID()}`, channelId: profile.id, modelId, operation: 'chat',
    prompt: normalized.filter((message) => message.role === 'user').map((message) => typeof message.content === 'string' ? message.content : '').join('\n'),
    messages: normalized, tools: record.tools as JsonValue | undefined, toolChoice: record.tool_choice as JsonValue | undefined, params, refs: [], count: 1 };
}
export async function submitChannelChat(profile: ChannelProfileV2, modelId: string, payload: unknown, signal?: AbortSignal): Promise<{ text: string; raw: unknown; status?: number }> {
  const job = channelChatInput(profile, modelId, payload);
  let raw: unknown; let status: number | undefined;
  const result = await new TemplateAdapter({ profile, apiKey: getChannelCredential(profile.id),
    http: createChannelHttpTransport(), resolveRef: resolveChannelRef,
    onChatResponse: (response, http) => { raw = response; status = http.status; } }).submit(job, signal);
  if (result.state !== 'done') throw new Error(result.state === 'submitted' ? 'chat 操作必须返回同步文本结果' : result.error.message);
  const text = result.outputs.flatMap((output) => output.kind === 'text' ? [output.text] : []).join('\n');
  // Tool-only replies have no text; the actual response goes straight to the
  // existing Agent codec and is never reconstructed or persisted as a snapshot.
  return { text, raw, status };
}
