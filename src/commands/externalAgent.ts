import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export const EXTERNAL_AGENT_EVENT_NAME = 'external-agent-event';

export type ExternalAgentRuntime = 'codex' | 'claude';

export interface ExternalAgentRuntimeDiagnostic {
  runtime: ExternalAgentRuntime;
  installed: boolean;
  compatible: boolean;
  authenticated: boolean;
  version: string | null;
  executableName: string | null;
  status: 'notInstalled' | 'incompatible' | 'authRequired' | 'ready' | 'error';
  message: string | null;
}

export interface ExternalAgentToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  requiresApproval: boolean;
}

export interface ExternalAgentStartRequest {
  runtime: ExternalAgentRuntime;
  tools: ExternalAgentToolDefinition[];
  resumeId?: string | null;
  model?: string | null;
}

export interface ExternalAgentSessionInfo {
  sessionId: string;
  runtime: ExternalAgentRuntime;
  providerSessionId: string | null;
  status: string;
  model: string | null;
  permissionSummary: string;
  createdAt: number;
}

export type ExternalAgentConnectionStatus =
  | 'disconnected'
  | 'ready'
  | 'connected'
  | 'expired';

export interface ExternalAgentProviderConfig {
  format: 'toml' | 'json';
  contents: string;
  destinationMacos: string;
  destinationWindows: string;
}

export interface ExternalAgentConnectionInfo {
  schemaVersion: 1;
  connectionId: string | null;
  status: ExternalAgentConnectionStatus;
  project: { id: string; name: string } | null;
  scope: string[];
  permissionMode: 'manual';
  createdAt: number | null;
  expiresAt: number | null;
  connectedAt: number | null;
  lastActivityAt: number | null;
  callCount: number;
  descriptorPath: string | null;
  configs: {
    codex: ExternalAgentProviderConfig;
    claude: ExternalAgentProviderConfig;
  } | null;
}

export interface CreateExternalAgentConnectionRequest {
  projectId: string;
  projectName: string;
  tools: ExternalAgentToolDefinition[];
}

export interface ExternalAgentAttachment {
  referenceId: string;
  title: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  /** Transient IPC payload. The backend never puts this value in events or CLI arguments. */
  bytesBase64: string;
}

export interface ExternalAgentTurnRequest {
  sessionId: string;
  prompt: string;
  attachments?: ExternalAgentAttachment[];
}

export interface ExternalAgentTurnReceipt {
  sessionId: string;
  turnId: string;
  accepted: boolean;
}

export type ExternalAgentToolOutcome = 'approved' | 'denied' | 'error';

export interface ExternalAgentToolResolution {
  outcome: ExternalAgentToolOutcome;
  result?: unknown;
  errorCode?: string | null;
  message?: string | null;
  revision?: number | null;
  receiptId?: string | null;
}

export interface ExternalAgentResolveToolCallRequest {
  sessionId: string;
  callId: string;
  resolution: ExternalAgentToolResolution;
}

export interface ExternalAgentToolCall {
  callId: string;
  name: string;
  input: unknown;
  requiresApproval: boolean;
}

export type ExternalAgentEventKind =
  | 'sessionStarted'
  | 'turnStarted'
  | 'messageDelta'
  | 'reasoningSummary'
  | 'plan'
  | 'toolRequested'
  | 'toolResolved'
  | 'progress'
  | 'diagnostic'
  | 'error'
  | 'completed'
  | 'canceled';

export interface ExternalAgentEventV1 {
  schemaVersion: 1;
  sessionId: string;
  runtime: ExternalAgentRuntime;
  turnId: string | null;
  kind: ExternalAgentEventKind;
  message: string | null;
  data: unknown | null;
  toolCall: ExternalAgentToolCall | null;
}

export interface ExternalAgentInvokeErrorShape {
  code: string;
  message: string;
  retryable: boolean;
}

export class ExternalAgentInvokeError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(error: ExternalAgentInvokeErrorShape) {
    super(error.message);
    this.name = 'ExternalAgentInvokeError';
    this.code = error.code;
    this.retryable = error.retryable;
  }
}

function normalizeInvokeError(error: unknown): ExternalAgentInvokeError {
  if (error && typeof error === 'object') {
    const value = error as Record<string, unknown>;
    if (typeof value.code === 'string' && typeof value.message === 'string') {
      return new ExternalAgentInvokeError({
        code: value.code,
        message: value.message,
        retryable: value.retryable === true,
      });
    }
  }
  if (typeof error === 'string') {
    return new ExternalAgentInvokeError({
      code: 'invoke_failed',
      message: error,
      retryable: true,
    });
  }
  if (error instanceof Error) {
    return new ExternalAgentInvokeError({
      code: 'invoke_failed',
      message: error.message,
      retryable: true,
    });
  }
  return new ExternalAgentInvokeError({
    code: 'invoke_failed',
    message: 'External Agent command failed.',
    retryable: true,
  });
}

function assertTauri(): void {
  if (!isTauri()) {
    throw new ExternalAgentInvokeError({
      code: 'runtime_unavailable',
      message: 'External Agents require the Tauri desktop runtime.',
      retryable: false,
    });
  }
}

async function invokeExternalAgent<T>(
  command: string,
  args?: Record<string, unknown>
): Promise<T> {
  assertTauri();
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw normalizeInvokeError(error);
  }
}

export function diagnoseExternalAgentRuntimes(): Promise<ExternalAgentRuntimeDiagnostic[]> {
  return invokeExternalAgent('diagnose_external_agent_runtimes');
}

export function startExternalAgentSession(
  request: ExternalAgentStartRequest
): Promise<ExternalAgentSessionInfo> {
  return invokeExternalAgent('start_external_agent_session', { request });
}

export function sendExternalAgentTurn(
  request: ExternalAgentTurnRequest
): Promise<ExternalAgentTurnReceipt> {
  return invokeExternalAgent('send_external_agent_turn', { request });
}

export function cancelExternalAgentSession(sessionId: string): Promise<void> {
  return invokeExternalAgent('cancel_external_agent_session', { sessionId });
}

export function resolveExternalAgentToolCall(
  request: ExternalAgentResolveToolCallRequest
): Promise<void> {
  return invokeExternalAgent('external_agent_resolve_tool_call', { request });
}

export function createExternalAgentConnection(
  request: CreateExternalAgentConnectionRequest
): Promise<ExternalAgentConnectionInfo> {
  return invokeExternalAgent('create_external_agent_connection', { request });
}

export function inspectExternalAgentConnection(): Promise<ExternalAgentConnectionInfo> {
  return invokeExternalAgent('inspect_external_agent_connection');
}

export function revokeExternalAgentConnection(
  connectionId: string
): Promise<ExternalAgentConnectionInfo> {
  return invokeExternalAgent('revoke_external_agent_connection', { connectionId });
}

export function replayExternalAgentPendingToolCalls(): Promise<number> {
  return invokeExternalAgent('replay_external_agent_pending_tool_calls');
}

export async function listenExternalAgentEvents(
  handler: (event: ExternalAgentEventV1) => void,
  onProtocolError?: (error: Error) => void,
): Promise<UnlistenFn> {
  assertTauri();
  return listen<ExternalAgentEventV1>(EXTERNAL_AGENT_EVENT_NAME, (event) => {
    if (Number(event.payload.schemaVersion) !== 1) {
      onProtocolError?.(new Error(`Unsupported external Agent event version ${String(event.payload.schemaVersion)}.`));
      return;
    }
    handler(event.payload);
  });
}
