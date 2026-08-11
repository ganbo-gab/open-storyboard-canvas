export const CANVAS_AGENT_RUNTIME_VERSION = 1 as const;
export const CANVAS_AGENT_DEFINITION_VERSION = 1 as const;

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
