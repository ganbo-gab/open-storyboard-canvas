import { resolveNativeChannelModel } from '@/features/channels/application/channelService';
import { resolveModelModeOrFirst } from '@/features/channels/application/modelModes';
import type { AgentModelReference } from '../domain/agentModel';
import { z } from 'zod';
import { readWorkspaceRecord, writeWorkspaceRecord } from '@/features/assets/application/assetMediaStorage';

/** Provider-only replay data. Never render it as assistant text or include it in diagnostic summaries. */
export const providerContinuationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.enum(['anthropic-content', 'gemini-parts', 'responses-output']), items: z.array(z.json()) }),
  z.strictObject({ kind: z.literal('chat-reasoning'), reasoningContent: z.string().max(8 * 1024 * 1024) }),
]);
export type AgentProviderContinuation = z.infer<typeof providerContinuationSchema>;
const recordSchema = z.strictObject({ version: z.literal(1), modelRef: z.string(), value: providerContinuationSchema });
const pointerSchema = z.object({ storyboardResponseGroup: z.string().optional(), storyboardContinuationRef: z.string().uuid().optional() });
const memory = new Map<string, z.infer<typeof recordSchema>>();

/** Commit before handing a tool call to the runner: approval/reload can then resume exactly. */
export async function saveProviderContinuation(modelRef: string, value: AgentProviderContinuation): Promise<string> {
  const record = recordSchema.parse({ version: 1, modelRef, value });
  if (new TextEncoder().encode(JSON.stringify(record)).byteLength > 8 * 1024 * 1024) throw new Error('供应商续聊数据超过本机保存上限，请缩短本轮任务。');
  const id = crypto.randomUUID();
  if (typeof indexedDB !== 'undefined') await writeWorkspaceRecord('documents', `agent-protocol-state:${id}`, record);
  memory.set(id, record);
  if (memory.size > 128) memory.delete(memory.keys().next().value!);
  return id;
}
export async function readProviderContinuation(data: unknown, modelRef: string): Promise<{ responseGroup?: string; continuation?: AgentProviderContinuation }> {
  const parsed = pointerSchema.safeParse(data);
  if (!parsed.success) return {};
  const id = parsed.data.storyboardContinuationRef;
  if (!id) return { responseGroup: parsed.data.storyboardResponseGroup };
  const cached = memory.get(id);
  const stored = cached ?? (typeof indexedDB !== 'undefined' ? await readWorkspaceRecord<unknown>('documents', `agent-protocol-state:${id}`) : undefined);
  const record = recordSchema.safeParse(stored);
  if (!record.success) throw new Error('当前会话缺少供应商续聊数据，请新建会话后继续。已有消息和已完成操作仍保留。');
  // Provider reasoning/signatures may never be replayed into another model or channel.
  if (record.data.modelRef !== modelRef) return {};
  return { responseGroup: parsed.data.storyboardResponseGroup, continuation: record.data.value };
}

/** Bound to the actual provider route; changing a URL/protocol cannot replay another provider's state. */
export function providerContinuationScope(model: AgentModelReference): string {
  const channel = resolveNativeChannelModel(model.catalogId);
  const chatMode = channel?.model.modes?.find(mode => mode.operation === 'chat');
  const operation = channel && chatMode ? resolveModelModeOrFirst(channel.model, chatMode.id).operationSpec ?? channel.profile.operations.chat : channel?.profile.operations.chat;
  return JSON.stringify([model.catalogId, model.capabilities.protocol, channel?.profile.baseUrl ?? '', operation?.path ?? '', channel?.profile.auth ?? null]);
}
