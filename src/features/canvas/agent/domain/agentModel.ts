export const CANVAS_AGENT_RUNTIME_VERSION = 1 as const;
export const CANVAS_AGENT_DEFINITION_VERSION = 1 as const;
export const EXTERNAL_AGENT_EVENT_VERSION = 1 as const;

export type CanvasAgentRuntimeId = 'builtin' | 'codex' | 'claude';
export type ExternalAgentRuntimeId = Exclude<CanvasAgentRuntimeId, 'builtin'>;

export type ExternalAgentAvailability =
  | 'ready'
  | 'not-installed'
  | 'login-required'
  | 'incompatible'
  | 'unavailable';

export interface ExternalAgentRuntimeDiagnostic {
  runtime: ExternalAgentRuntimeId;
  availability: ExternalAgentAvailability;
  version?: string;
  executableLabel?: string;
  detail?: string;
}

export interface ExternalAgentSessionReference {
  runtime: ExternalAgentRuntimeId;
  sessionId: string;
  threadId?: string;
}

export interface ExternalAgentToolRequest {
  version: typeof EXTERNAL_AGENT_EVENT_VERSION;
  runtime: ExternalAgentRuntimeId;
  sessionId: string;
  turnId: string;
  callId: string;
  toolName: 'canvas_command' | 'diagnostics' | 'config_patch' | 'asset_read';
  arguments: unknown;
}

export type ExternalAgentEventV1 =
  | { version: 1; kind: 'session'; runtime: ExternalAgentRuntimeId; sessionId: string; threadId?: string }
  | { version: 1; kind: 'turn_started'; runtime: ExternalAgentRuntimeId; sessionId: string; turnId: string }
  | { version: 1; kind: 'message_delta'; runtime: ExternalAgentRuntimeId; sessionId: string; turnId: string; delta: string }
  | { version: 1; kind: 'reasoning_summary_delta'; runtime: ExternalAgentRuntimeId; sessionId: string; turnId: string; delta: string }
  | { version: 1; kind: 'plan'; runtime: ExternalAgentRuntimeId; sessionId: string; turnId?: string; delta: string; data?: unknown }
  | { version: 1; kind: 'progress'; runtime: ExternalAgentRuntimeId; sessionId: string; turnId?: string; message?: string; data?: unknown }
  | { version: 1; kind: 'diagnostic'; runtime: ExternalAgentRuntimeId; sessionId: string; turnId?: string; message?: string; data?: unknown }
  | { version: 1; kind: 'tool_requested'; runtime: ExternalAgentRuntimeId; sessionId: string; turnId: string; request: ExternalAgentToolRequest }
  | { version: 1; kind: 'tool_started'; runtime: ExternalAgentRuntimeId; sessionId: string; turnId: string; callId: string; toolName: string; input?: unknown }
  | { version: 1; kind: 'tool_completed'; runtime: ExternalAgentRuntimeId; sessionId: string; turnId: string; callId: string; toolName: string; output?: unknown }
  | { version: 1; kind: 'tool_failed'; runtime: ExternalAgentRuntimeId; sessionId: string; turnId: string; callId: string; toolName: string; error: string }
  | { version: 1; kind: 'completed'; runtime: ExternalAgentRuntimeId; sessionId: string; turnId: string; finalText?: string }
  | { version: 1; kind: 'cancelled'; runtime: ExternalAgentRuntimeId; sessionId: string; turnId?: string }
  | { version: 1; kind: 'error'; runtime: ExternalAgentRuntimeId; sessionId?: string; turnId?: string; code: string; message: string };

export type AgentModelProtocol =
  | 'openai-responses'
  | 'openai-chat-completions'
  | 'anthropic-messages'
  | 'google-gemini';

export interface AgentModelCapabilities {
  protocol: AgentModelProtocol;
  tools: boolean;
  stream: boolean;
  vision: boolean;
  reasoningSummary: boolean;
  toolSearch: boolean;
}

export interface AgentModelReference {
  catalogId: string;
  providerId: string;
  modelId: string;
  label: string;
  usable: boolean;
  notReadyReason?: string;
  capabilities: AgentModelCapabilities;
}

export type AgentMediaOrigin = 'canvas-asset' | 'upload';

/**
 * Transient media prepared for one Agent turn. `source` must never be persisted;
 * session history stores only the stable identifiers and bounded metadata below.
 */
export interface AgentTurnMediaInput {
  assetId: string;
  nodeId?: string;
  title: string;
  origin: AgentMediaOrigin;
  mimeType?: string;
  source: string;
}

export interface AgentSessionMediaReference {
  referenceId: string;
  runId: string;
  assetId: string;
  nodeId?: string;
  title: string;
  origin: AgentMediaOrigin;
  mimeType?: string;
  createdAt: number;
}

export type AgentSessionMediaAvailability = 'available' | 'missing';

export interface AgentSessionMediaReferenceView extends AgentSessionMediaReference {
  availability: AgentSessionMediaAvailability;
}

export type AgentModelContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; imageUrl: string; detail?: string };

export type AgentModelInputItem =
  | {
      type: 'message';
      role: 'system' | 'user' | 'assistant';
      content: AgentModelContentPart[];
    }
  | {
      type: 'function_call';
      callId: string;
      name: string;
      namespace?: string;
      arguments: string;
    }
  | {
      type: 'function_call_result';
      callId: string;
      name: string;
      namespace?: string;
      output: string;
      content?: AgentModelContentPart[];
    };

export interface AgentModelToolDefinition {
  name: string;
  namespace?: string;
  namespaceDescription?: string;
  description: string;
  parameters: Record<string, unknown>;
  strict: boolean;
  deferLoading?: boolean;
}

export interface AgentModelToolPolicy {
  mode: 'local-pruned' | 'responses-tool-search';
  deferredToolNames: string[];
  deferredNamespaces: string[];
}

export interface AgentModelTurnRequest {
  model: AgentModelReference;
  systemInstructions?: string;
  input: AgentModelInputItem[];
  tools: AgentModelToolDefinition[];
  toolPolicy?: AgentModelToolPolicy;
  toolChoice?: 'auto' | 'required' | 'none' | string;
  parallelToolCalls?: boolean;
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
}

export interface AgentModelToolCall {
  callId: string;
  name: string;
  namespace?: string;
  arguments: string;
}

export interface AgentModelUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
}

export interface AgentModelTurnResponse {
  responseId: string;
  requestId?: string;
  text?: string;
  reasoningSummary?: string;
  toolCalls: AgentModelToolCall[];
  finishReason?: string;
  usage: AgentModelUsage;
  providerSummary?: Record<string, unknown>;
}

export type AgentModelStreamEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'reasoning_summary_delta'; delta: string }
  | { type: 'completed'; response: AgentModelTurnResponse };

export interface AgentModelTransport {
  getResponse(request: AgentModelTurnRequest, signal?: AbortSignal): Promise<AgentModelTurnResponse>;
  getStreamedResponse(
    request: AgentModelTurnRequest,
    signal?: AbortSignal,
  ): AsyncIterable<AgentModelStreamEvent>;
}

export interface AgentProviderHttpRequest {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  timeoutMs: number;
}

export interface AgentProviderHttpResponse {
  status: number;
  text: string;
}

export interface AgentProviderHttpClient {
  request(
    request: AgentProviderHttpRequest,
    signal?: AbortSignal,
  ): Promise<AgentProviderHttpResponse>;
  stream(
    request: AgentProviderHttpRequest,
    signal?: AbortSignal,
  ): AsyncIterable<string>;
}
