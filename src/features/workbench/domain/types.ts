import type { GenerationJobPollStatus } from '@/features/canvas/application/ports';
import { referenceUrlFailureOf } from '@/features/channels/domain/referenceErrors';
import { credentialFailureOf, credentialFailureMessage } from '@/features/secrets/credentialFailure';

export type WorkbenchKind = 'image' | 'video' | 'audio' | 'chat';
export interface WorkbenchReference {
  id: string;
  kind: 'image' | 'video' | 'audio' | 'text';
  source: string;
  name?: string;
}
export interface WorkbenchConfig {
  size?: string;
  aspectRatio?: string;
  seconds?: number;
  extraParams?: Record<string, unknown>;
}
export interface WorkbenchSubmitInput {
  conversationId?: string;
  /** Historical submission attribution, when explicitly retained by the caller. */
  projectId?: string;
  kind: WorkbenchKind;
  prompt: string;
  model: string;
  channelModeId?: string;
  referenceSlots?: Record<string, string[]>;
  config?: WorkbenchConfig;
  references?: WorkbenchReference[];
}
export interface WorkbenchDraft extends Omit<WorkbenchSubmitInput, 'conversationId' | 'projectId'> {}
export interface WorkbenchConversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  pinnedAt: number | null;
  projectId: string | null;
}
export interface WorkbenchMessage {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  text: string;
  taskId: string;
  createdAt: number;
}
export type WorkbenchFailureKind = 'storage' | 'configuration' | 'authentication' | 'quota' | 'rate-limit' | 'network' | 'provider' | 'unknown-submit' | 'interrupted';
export interface WorkbenchFailure {
  kind: WorkbenchFailureKind;
  message: string;
  code?: 'reference.needsPublicUrl' | 'task.stalled';
  slotKey?: string;
  slotKind?: 'image' | 'video' | 'audio';
}
export interface WorkbenchResult { kind: 'image' | 'video' | 'audio' | 'model' | 'text'; source: string; assetId?: string; importedModelId?: string }
export interface WorkbenchTask {
  id: string;
  conversationId: string;
  input: WorkbenchSubmitInput;
  status: GenerationJobPollStatus['status'];
  jobId?: string;
  job?: GenerationJobPollStatus;
  results: WorkbenchResult[];
  failure?: WorkbenchFailure;
  waitingCanceled: boolean;
  /** Local observation window; repeated polling timestamps are not evidence of progress. */
  tracking?: { startedAt: number; lastProgressAt: number };
  createdAt: number;
  updatedAt: number;
}
export interface WorkbenchData {
  conversations: Record<string, WorkbenchConversation>;
  messages: Record<string, WorkbenchMessage>;
  tasks: Record<string, WorkbenchTask>;
  selectedConversationId: string | null;
  draft: WorkbenchDraft;
}
export function emptyWorkbenchData(): WorkbenchData {
  return { conversations: {}, messages: {}, tasks: {}, selectedConversationId: null,
    draft: { kind: 'image', model: '', prompt: '', references: [], config: {} } };
}

export function classifyWorkbenchFailure(error: unknown, duringSubmit = false): WorkbenchFailure {
  if (credentialFailureOf(error)) return { kind: 'authentication', message: credentialFailureMessage(error) };
  const raw = error instanceof Error ? error.message : String(error);
  // Never echo provider response bodies, credentials, or signed URL queries into persisted history.
  const message = raw.replace(/(Bearer\s+)\S+/gi, '$1[redacted]')
    .replace(/((?:api[_-]?key|token|authorization|password|secret)\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted]')
    .replace(/https?:\/\/[^\s"'<>]+/g, (url) => { try { const parsed = new URL(url); return `${parsed.origin}${parsed.pathname}`; } catch { return '[URL]'; } })
    .replace(/data:[^\s]+/gi, '[media]').slice(0, 1200);
  const named = error instanceof Error ? error.name : '';
  const reference = referenceUrlFailureOf(error);
  const referenceFailure = reference ? { code: 'reference.needsPublicUrl' as const, ...reference } : undefined;
  let kind: WorkbenchFailureKind = 'provider';
  if (referenceFailure) kind = 'configuration';
  else if (/QuotaExceededError|SecurityError/.test(named) || /localstorage|storage|存储/i.test(raw)) kind = 'storage';
  else if (/insufficient.quota|quota.exceeded|余额|配额|billing|credit/i.test(raw)) kind = 'quota';
  else if (/429|rate.limit|限流/i.test(raw)) kind = 'rate-limit';
  else if (/401|403|unauthori|forbidden|API Key|认证|鉴权|凭据|授权|钥匙串/i.test(raw)) kind = 'authentication';
  else if (/配置|模型|not configured|unsupported|不支持|未找到|未填写/i.test(raw)) kind = 'configuration';
  else if (/timeout|timed.out|network|fetch|连接|超时|未知|提交结果未知|ECONN/i.test(raw)) kind = duringSubmit ? 'unknown-submit' : 'network';
  return { kind, message, ...referenceFailure };
}
