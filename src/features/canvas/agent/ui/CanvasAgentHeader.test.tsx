import React from 'react';
import { createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { CanvasAgentHeader } from './CanvasAgentHeader';

function render(taskCount = 0) {
  return renderToStaticMarkup(React.createElement(CanvasAgentHeader, {
    selectedEntry: { providerLabel: 'Provider', modelLabel: 'Model' },
    activeView: 'conversation',
    taskCount,
    isRunning: false,
    isReady: true,
    showCompletedTools: false,
    onToggleCompletedTools: vi.fn(),
    onNewConversation: vi.fn(),
    onViewChange: vi.fn(),
    onOpenExternalConnection: vi.fn(),
    onClose: vi.fn(),
    closeRef: createRef<HTMLButtonElement>(),
  }));
}

function renderRunning(activityText?: string) {
  return renderToStaticMarkup(React.createElement(CanvasAgentHeader, {
    selectedEntry: { providerLabel: 'Provider', modelLabel: 'Model' },
    activeView: 'conversation',
    taskCount: 1,
    isRunning: true,
    isReady: true,
    activityText,
    showCompletedTools: false,
    onToggleCompletedTools: vi.fn(),
    onNewConversation: vi.fn(),
    onViewChange: vi.fn(),
    onOpenExternalConnection: vi.fn(),
    onClose: vi.fn(),
    closeRef: createRef<HTMLButtonElement>(),
  }));
}

describe('CanvasAgentHeader', () => {
  it('shows the built-in model and focused header actions without a runtime picker', () => {
    const markup = render();
    expect(markup).toContain('Provider / Model');
    expect(markup).toContain('canvasAgent.newConversation');
    expect(markup).toContain('canvasAgent.moreActions');
    expect(markup).toContain('canvasAgent.history');
    expect(markup).not.toContain('canvasAgent.runtime.codex');
    expect(markup).not.toContain('canvasAgent.runtime.claude');
    expect(markup).toContain('canvasAgent.tasks');
    expect(markup).toContain('canvasAgent.conversation');
  });

  it('keeps Tasks reachable after generation finishes and badges active work', () => {
    expect(render(0)).toContain('canvasAgent.tasks');
    expect(render(2)).toContain('>2</span>');
  });

  it('shows concrete generation progress instead of generic thinking while polling', () => {
    expect(renderRunning('图片生成中 · 7 / 72')).toContain('图片生成中 · 7 / 72');
    expect(renderRunning()).toContain('canvasAgent.statusThinking');
  });
});
