import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, values?: Record<string, unknown>) => values ? `${key}:${JSON.stringify(values)}` : key }),
}));

import { CanvasAgentFeedViewport, projectAgentFeedForDisplay } from './CanvasAgentFeedViewport';

const noop = () => {};
const approval = (id: string) => ({
  id,
  kind: 'approval' as const,
  runId: 'run',
  approvalId: id,
  toolName: 'canvas_command',
  summary: `approval ${id}`,
  arguments: {},
  impact: { effect: 'read' as const, title: 'read', summary: 'read', affectedNodeCount: 0, affectedEdgeCount: 0, externalSideEffect: false },
  expiresAt: Date.now() + 60_000,
  status: 'pending' as const,
  createdAt: 1,
});

describe('CanvasAgentFeedViewport approval queue', () => {
  it('groups completed tools per user turn while keeping live and failed tools visible', () => {
    const feed = [
      { id: 'u1', kind: 'message', role: 'user', text: 'one', createdAt: 1 },
      { id: 't1', kind: 'tool', toolName: 'canvas_command', status: 'succeeded', createdAt: 2 },
      { id: 'a1', kind: 'message', role: 'assistant', text: 'done', createdAt: 3 },
      { id: 'u2', kind: 'message', role: 'user', text: 'two', createdAt: 4 },
      { id: 't2', kind: 'tool', toolName: 'diagnostics', status: 'failed', createdAt: 5 },
      { id: 't3', kind: 'tool', toolName: 'canvas_command', status: 'succeeded', createdAt: 6 },
    ] as any;
    expect(projectAgentFeedForDisplay(feed, false, false).map((item) => item.id)).toEqual(['u1', 'a1', 'u2', 't2']);
    const shown = projectAgentFeedForDisplay(feed, false, true);
    expect(shown.filter((item) => item.kind === 'tool-group')).toHaveLength(2);
    const runningFeed = [
      ...feed,
      { id: 'u3', kind: 'message', role: 'user', text: 'three', createdAt: 7 },
      { id: 't4', kind: 'tool', toolName: 'canvas_command', status: 'succeeded', createdAt: 8 },
    ] as any;
    expect(projectAgentFeedForDisplay(runningFeed, true, false).map((item) => item.id)).toEqual([
      'u1', 'a1', 'u2', 't2', 'u3', 't4',
    ]);
    expect(projectAgentFeedForDisplay(runningFeed, true, true).filter((item) => item.kind === 'tool-group')).toHaveLength(2);
  });

  it('keeps a locatable generation receipt visible after completion', () => {
    const feed = [
      { id: 'u1', kind: 'message', role: 'user', text: 'generate', createdAt: 1 },
      {
        id: 'generation',
        kind: 'tool',
        toolName: 'canvas_command',
        status: 'succeeded',
        generationInputNodeIds: ['input'],
        generationResultNodeIds: ['result'],
        createdAt: 2,
      },
    ] as any;
    expect(projectAgentFeedForDisplay(feed, false, false).map((item) => item.id)).toEqual(['u1', 'generation']);
  });

  it('groups pending approvals in one bounded queue with fixed bulk actions', () => {
    const markup = renderToStaticMarkup(React.createElement(CanvasAgentFeedViewport, {
      projectId: 'project',
      activeView: 'conversation',
      nodes: [],
      displayedFeed: [approval('a'), approval('b'), approval('c')],
      sessions: [],
      isRunning: false,
      showCompletedTools: false,
      pendingCount: 3,
      showNewItems: false,
      scrollRef: { current: null },
      onScroll: noop,
      onStartConversation: noop,
      onLoadSession: noop,
      onApproval: noop,
      onBatchApproval: noop,
      onLocate: noop,
      onRestoreDraft: noop,
      onDiagnose: noop,
      onPlanChange: noop,
      onPlanConfirm: noop,
      onPlanCancel: noop,
      onRollback: noop,
      onJumpToLatest: noop,
    } as any));
    expect(markup).toContain('canvasAgent.approvalQueueTitle');
    expect(markup).toContain('max-h-[min(46vh,420px)]');
    expect(markup).toContain('canvasAgent.approveAll');
    expect(markup).toContain('canvasAgent.rejectAll');
  });
});
