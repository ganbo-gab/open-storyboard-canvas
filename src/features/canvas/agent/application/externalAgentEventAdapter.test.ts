import { describe, expect, it } from 'vitest';
import {
  normalizeExternalAgentEvent,
  projectExternalAgentRuntimeDiagnostic,
} from './externalAgentEventAdapter';

describe('external Agent event adapter', () => {
  it('maps native diagnostic status without exposing executable paths', () => {
    expect(projectExternalAgentRuntimeDiagnostic({
      runtime: 'claude',
      installed: true,
      compatible: true,
      authenticated: false,
      version: '1.2.3',
      executableName: 'claude',
      status: 'authRequired',
      message: 'login first',
    })).toEqual(expect.objectContaining({
      runtime: 'claude',
      availability: 'login-required',
      executableLabel: 'claude',
      detail: 'login first',
    }));
  });

  it('fails closed on unknown tools', () => {
    expect(() => normalizeExternalAgentEvent({
      schemaVersion: 1,
      sessionId: 'session-1',
      runtime: 'codex',
      turnId: 'turn-1',
      kind: 'toolRequested',
      message: null,
      data: null,
      toolCall: { callId: 'call-1', name: 'shell', input: {}, requiresApproval: true },
    })).toThrow(/unknown tool/i);
  });

  it('redacts dynamic payloads before exposing them to the panel', () => {
    const event = normalizeExternalAgentEvent({
      schemaVersion: 1,
      sessionId: 'session-1',
      runtime: 'claude',
      turnId: 'turn-1',
      kind: 'toolRequested',
      message: null,
      data: null,
      toolCall: {
        callId: 'call-1',
        name: 'diagnostics',
        input: { authorization: 'Bearer should-not-leak', path: '/Users/alice/file.png' },
        requiresApproval: true,
      },
    });
    expect(JSON.stringify(event)).not.toContain('should-not-leak');
    expect(JSON.stringify(event)).not.toContain('/Users/alice');
  });

  it('keeps streamed plan text and accepts session-level cancellation', () => {
    expect(normalizeExternalAgentEvent({
      schemaVersion: 1,
      sessionId: 'session-1',
      runtime: 'codex',
      turnId: 'turn-1',
      kind: 'plan',
      message: 'Inspect the selected nodes first.',
      data: null,
      toolCall: null,
    })).toEqual(expect.objectContaining({
      kind: 'plan',
      delta: 'Inspect the selected nodes first.',
      turnId: 'turn-1',
    }));

    expect(normalizeExternalAgentEvent({
      schemaVersion: 1,
      sessionId: 'session-1',
      runtime: 'codex',
      turnId: null,
      kind: 'canceled',
      message: null,
      data: null,
      toolCall: null,
    })).toEqual({
      version: 1,
      kind: 'cancelled',
      runtime: 'codex',
      sessionId: 'session-1',
      turnId: undefined,
    });
  });

  it('fails closed on unsupported event versions', () => {
    expect(() => normalizeExternalAgentEvent({
      schemaVersion: 2 as 1,
      sessionId: 'session-1',
      runtime: 'codex',
      turnId: null,
      kind: 'sessionStarted',
      message: null,
      data: null,
      toolCall: null,
    })).toThrow(/unsupported external Agent event version/i);
  });
});
