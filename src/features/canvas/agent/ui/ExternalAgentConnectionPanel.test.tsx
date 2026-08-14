import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { destination?: string }) => options?.destination ? `${key}:${options.destination}` : key,
    i18n: { language: 'en' },
  }),
}));

vi.mock('@/commands/externalAgent', () => ({
  createExternalAgentConnection: vi.fn(),
  inspectExternalAgentConnection: vi.fn(() => new Promise(() => undefined)),
  listenExternalAgentEvents: vi.fn(() => new Promise(() => undefined)),
  replayExternalAgentPendingToolCalls: vi.fn(),
  resolveExternalAgentToolCall: vi.fn(),
  revokeExternalAgentConnection: vi.fn(),
}));

vi.mock('../application/externalAgentCanvasBridge', () => ({
  prepareExternalAgentToolRequest: vi.fn(),
  resolveExternalAgentToolApproval: vi.fn(),
}));

import { ExternalAgentConnectionPanel } from './ExternalAgentConnectionPanel';

describe('ExternalAgentConnectionPanel', () => {
  it('explains the external process and manual approval boundary', () => {
    const markup = renderToStaticMarkup(React.createElement(ExternalAgentConnectionPanel, {
      projectId: 'project-1',
      projectName: 'Opening sequence',
      tools: [{
        name: 'canvas_command',
        description: 'Canvas only',
        inputSchema: { type: 'object' },
        requiresApproval: true,
      }],
    }));
    expect(markup).toContain('canvasAgent.externalMcp.title');
    expect(markup).toContain('canvasAgent.externalMcp.description');
    expect(markup).toContain('canvasAgent.externalMcp.manualApproval');
    expect(markup).not.toContain('启动 Codex');
    expect(markup).not.toContain('启动 Claude');
  });
});
