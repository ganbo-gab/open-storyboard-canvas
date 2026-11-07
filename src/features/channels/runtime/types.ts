// Execution contract shared by template channels and special adapters (docs/rework/02 §6).
import type { OperationKind } from '../domain/profile';

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type MediaKind = 'image' | 'video' | 'audio' | 'model';

export interface JobRef {
  kind: Exclude<MediaKind, 'model'>;
  /** Explicit mode reference slot; never inferred from reference order. */
  slot?: string;
  assetId: string;
  /** Absolute local file path of the asset. */
  path: string;
  mime: string;
  width?: number;
  height?: number;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: JsonValue;
  /** Standard OpenAI chat tool protocol; preserved verbatim through messages templates. */
  tool_calls?: JsonValue[];
  tool_call_id?: string;
  name?: string;
}

export interface JobInput {
  jobId: string;
  channelId: string;
  modelId: string;
  modeId?: string;
  operation: OperationKind;
  /** Authoring prompt; the shared renderer compiles the model's declared mention dialect. */
  prompt: string;
  /** Chat operation only; when absent, renderers derive [{ role: 'user', content: prompt }]. */
  messages?: ChatMessage[];
  /** Chat-only JSON tool declarations; sent only if explicitly referenced by the template. */
  tools?: JsonValue;
  toolChoice?: JsonValue;
  /** Ephemeral provider-native chat fields; templates must explicitly select each top-level field. */
  chatPayload?: JsonValue;
  params: Record<string, JsonValue>;
  refs: JobRef[];
  count: number;
}

export type OutputSource =
  | { type: 'url'; url: string; headers?: Record<string, string> }
  | { type: 'base64'; data: string; mime: string };

export type Output =
  | { kind: MediaKind; source: OutputSource }
  | { kind: 'text'; text: string };

export type ChannelErrorCategory =
  | 'auth'
  | 'credential'
  | 'balance'
  | 'not_found'
  | 'too_large'
  | 'rate_limit'
  | 'upstream'
  | 'moderation'
  | 'network'
  | 'validation'
  | 'timeout';

export interface ChannelError {
  category: ChannelErrorCategory;
  /** User-facing Chinese explanation. */
  message: string;
  upstreamMessage?: string;
  status?: number;
  retryable: boolean;
}

export type SubmitResult =
  | { state: 'done'; outputs: Output[] }
  | { state: 'submitted'; taskId: string }
  | { state: 'failed'; error: ChannelError }
  /** Request may have been accepted upstream; never auto-retry. */
  | { state: 'unknown'; error: ChannelError };

export type PollResult =
  | { state: 'pending'; progress?: number; message?: string; diagnostic?: ChannelError }
  | { state: 'done'; outputs: Output[] }
  | { state: 'failed'; error: ChannelError };

export interface RequestPreview {
  method: 'GET' | 'POST';
  url: string;
  /** Secrets masked. */
  headers: Record<string, string>;
  body: { mode: 'json'; json: JsonValue } | { mode: 'form-urlencoded'; fields: { name: string; value: string }[] } | { mode: 'multipart'; fields: { name: string; value: string }[] } | { mode: 'none' };
}

export interface ChannelAdapter {
  submit(job: JobInput, signal?: AbortSignal): Promise<SubmitResult>;
  poll?(job: JobInput, taskId: string, signal?: AbortSignal): Promise<PollResult>;
  cancel?(job: JobInput, taskId: string): Promise<boolean>;
  preview?(job: JobInput): RequestPreview;
  /** models.list operation. */
  listModels?(signal?: AbortSignal): Promise<{ ok: true; models: string[] } | { ok: false; error: ChannelError }>;
}
