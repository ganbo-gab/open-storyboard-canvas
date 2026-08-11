import {
  listenExternalAgentEvents,
  type ExternalAgentEventV1 as RawExternalAgentEventV1,
  type ExternalAgentRuntimeDiagnostic as RawRuntimeDiagnostic,
} from '@/commands/externalAgent';
import { redactSensitiveValue } from './agentRedaction';
import {
  EXTERNAL_AGENT_EVENT_VERSION,
  type ExternalAgentEventV1,
  type ExternalAgentRuntimeDiagnostic,
} from '../domain/agentModel';

export function projectExternalAgentRuntimeDiagnostic(
  value: RawRuntimeDiagnostic,
): ExternalAgentRuntimeDiagnostic {
  const availability: ExternalAgentRuntimeDiagnostic['availability'] = value.status === 'ready'
    ? 'ready'
    : value.status === 'notInstalled'
      ? 'not-installed'
      : value.status === 'authRequired'
        ? 'login-required'
        : value.status === 'incompatible'
          ? 'incompatible'
          : 'unavailable';
  return {
    runtime: value.runtime,
    availability,
    version: value.version ?? undefined,
    executableLabel: value.executableName ?? undefined,
    detail: value.message ?? undefined,
  };
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function normalizeExternalAgentEvent(
  raw: RawExternalAgentEventV1,
): ExternalAgentEventV1 {
  if (Number(raw.schemaVersion) !== EXTERNAL_AGENT_EVENT_VERSION) {
    throw new Error(`Unsupported external Agent event version ${String(raw.schemaVersion)}.`);
  }
  const runtime = raw.runtime;
  const sessionId = raw.sessionId;
  const turnId = raw.turnId ?? undefined;
  const message = text(redactSensitiveValue(raw.message ?? ''));
  const data = raw.data === undefined || raw.data === null
    ? undefined
    : redactSensitiveValue(raw.data);

  switch (raw.kind) {
    case 'sessionStarted': {
      const record = data && typeof data === 'object' && !Array.isArray(data)
        ? data as Record<string, unknown>
        : {};
      return {
        version: 1,
        kind: 'session',
        runtime,
        sessionId,
        threadId: typeof record.providerSessionId === 'string' ? record.providerSessionId : undefined,
      };
    }
    case 'turnStarted':
      if (!turnId) throw new Error('External Agent turnStarted event is missing turnId.');
      return { version: 1, kind: 'turn_started', runtime, sessionId, turnId };
    case 'messageDelta':
      if (!turnId) throw new Error('External Agent messageDelta event is missing turnId.');
      return { version: 1, kind: 'message_delta', runtime, sessionId, turnId, delta: message };
    case 'reasoningSummary':
      if (!turnId) throw new Error('External Agent reasoningSummary event is missing turnId.');
      return { version: 1, kind: 'reasoning_summary_delta', runtime, sessionId, turnId, delta: message };
    case 'plan':
      return {
        version: 1,
        kind: 'plan',
        runtime,
        sessionId,
        turnId,
        delta: message,
        data,
      };
    case 'progress':
      return { version: 1, kind: 'progress', runtime, sessionId, turnId, message: message || undefined, data };
    case 'diagnostic':
      return { version: 1, kind: 'diagnostic', runtime, sessionId, turnId, message: message || undefined, data };
    case 'toolRequested': {
      if (!turnId || !raw.toolCall) throw new Error('External Agent toolRequested event is incomplete.');
      if (!['canvas_command', 'diagnostics', 'config_patch', 'asset_read'].includes(raw.toolCall.name)) {
        throw new Error(`External Agent requested unknown tool ${raw.toolCall.name}.`);
      }
      return {
        version: 1,
        kind: 'tool_requested',
        runtime,
        sessionId,
        turnId,
        request: {
          version: 1,
          runtime,
          sessionId,
          turnId,
          callId: raw.toolCall.callId,
          toolName: raw.toolCall.name as 'canvas_command' | 'diagnostics' | 'config_patch' | 'asset_read',
          arguments: redactSensitiveValue(raw.toolCall.input),
        },
      };
    }
    case 'toolResolved': {
      const record = data && typeof data === 'object' && !Array.isArray(data)
        ? data as Record<string, unknown>
        : {};
      const callId = text(record.callId);
      const outcome = text(record.outcome);
      if (!turnId || !callId) throw new Error('External Agent toolResolved event is incomplete.');
      if (outcome === 'approved') {
        return { version: 1, kind: 'tool_completed', runtime, sessionId, turnId, callId, toolName: 'canvas_tool', output: data };
      }
      return { version: 1, kind: 'tool_failed', runtime, sessionId, turnId, callId, toolName: 'canvas_tool', error: message || outcome || 'Tool call failed.' };
    }
    case 'completed':
      if (!turnId) throw new Error('External Agent completed event is missing turnId.');
      return { version: 1, kind: 'completed', runtime, sessionId, turnId, finalText: message || undefined };
    case 'canceled':
      return { version: 1, kind: 'cancelled', runtime, sessionId, turnId };
    case 'error': {
      const record = data && typeof data === 'object' && !Array.isArray(data)
        ? data as Record<string, unknown>
        : {};
      return {
        version: 1,
        kind: 'error',
        runtime,
        sessionId,
        turnId,
        code: text(record.code) || 'external_agent_error',
        message: message || 'External Agent failed.',
      };
    }
    default:
      throw new Error('Unknown external Agent event kind.');
  }
}

export function listenNormalizedExternalAgentEvents(
  handler: (event: ExternalAgentEventV1) => void,
  onProtocolError: (error: Error) => void,
) {
  return listenExternalAgentEvents((event) => {
    try {
      handler(normalizeExternalAgentEvent(event));
    } catch (error) {
      onProtocolError(error instanceof Error ? error : new Error(String(error)));
    }
  }, onProtocolError);
}
