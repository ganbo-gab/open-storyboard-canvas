import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => options
      ? `${key}:${JSON.stringify(options)}`
      : key,
  }),
}));

import { AgentFeedCard, normalizeCompactAgentMarkdown } from './AgentFeedCard';

const noop = () => {};
const report = {
  classification: ['upstream'],
  confidence: 'high',
  summary: 'The provider returned HTTP 429.',
  evidence: [{ code: 'upstream-rate-limit', message: 'HTTP 429', source: 'provider', severity: 'blocking' }],
  unknowns: [],
  eventTimeline: [],
  configSnapshotDiff: [],
};

function renderDiagnosticTool(security: { passed: boolean; findings: string[] }) {
  return renderToStaticMarkup(React.createElement(AgentFeedCard, {
    item: {
      id: 'tool-1',
      kind: 'tool',
      toolName: 'diagnostics',
      status: 'succeeded',
      output: {
        version: 1,
        createdAt: 456,
        publication: 'draft-only',
        report,
        canvasHealth: report,
        configSnapshot: { current: {}, diff: [] },
        reproductionSteps: ['Submit the selected node'],
        issueDraft: {
          title: '[Diagnostic] upstream-rate-limit',
          body: 'This is a local redacted draft. It has not been published.',
        },
        security,
        execution: { receiptId: 'receipt-1', replayed: false },
      },
      createdAt: 456,
    },
    onApproval: noop,
    onLocate: noop,
    onRestoreDraft: noop,
    onDiagnose: noop,
    onPlanChange: noop,
    onPlanConfirm: noop,
    onPlanCancel: noop,
    onBudgetLimitChange: noop,
    onRollback: noop,
  } as any));
}

describe('AgentFeedCard diagnostics export actions', () => {
  it('repairs tightly packed prose/list markdown without changing inline code or URLs', () => {
    const normalized = normalizeCompactAgentMarkdown('**生成成功！**任务已完成： - 节点ID: `abc-123` - 比例:16:9 https://example.test/a-b');
    expect(normalized).toContain('**生成成功！**\n');
    expect(normalized).toContain('\n- 节点ID: `abc-123`');
    expect(normalized).toContain('\n- 比例:16:9');
    expect(normalized).toContain('https://example.test/a-b');
  });

  it('shows copy and download actions only for a security-approved diagnostic bundle', () => {
    const markup = renderDiagnosticTool({ passed: true, findings: [] });
    expect(markup).toContain('canvasAgent.copyDiagnosticBundle');
    expect(markup).toContain('canvasAgent.copyDiagnosticIssueDraft');
    expect(markup).toContain('canvasAgent.downloadDiagnosticBundle');
  });

  it('withholds export actions when the bundle security check failed', () => {
    const markup = renderDiagnosticTool({ passed: false, findings: ['unsafe-content-withheld'] });
    expect(markup).not.toContain('canvasAgent.copyDiagnosticBundle');
    expect(markup).not.toContain('canvasAgent.copyDiagnosticIssueDraft');
    expect(markup).not.toContain('canvasAgent.downloadDiagnosticBundle');
  });
});

describe('AgentFeedCard skill routing summary', () => {
  it('shows tool-search mode and keeps the routing reason in an expandable disclosure', () => {
    const markup = renderToStaticMarkup(React.createElement(AgentFeedCard, {
      item: {
        id: 'skill-1',
        kind: 'skill',
        skillIds: ['generation-diagnostics', 'provider-configuration'],
        reason: '匹配错误码和供应商配置。',
        estimatedTokens: 240,
        toolCount: 2,
        mode: 'tool-search',
        deferredToolCount: 2,
        createdAt: 456,
      },
      onApproval: noop,
      onLocate: noop,
      onRestoreDraft: noop,
      onDiagnose: noop,
      onPlanChange: noop,
      onPlanConfirm: noop,
      onPlanCancel: noop,
      onBudgetLimitChange: noop,
      onRollback: noop,
    } as any));
    expect(markup).toContain('<details');
    expect(markup).toContain('canvasAgent.skillRouteMode.tool-search');
    expect(markup).toContain('&quot;tools&quot;:2');
    expect(markup).toContain('&quot;deferred&quot;:2');
    expect(markup).toContain('匹配错误码和供应商配置。');
  });
});

describe('AgentFeedCard message and recovery presentation', () => {
  it('renders assistant markdown without exposing formatting markers', () => {
    const markup = renderToStaticMarkup(React.createElement(AgentFeedCard, {
      item: { id: 'message-1', kind: 'message', role: 'assistant', text: '**已确认**\n\n- 比例：16:9', createdAt: 1 },
      onApproval: noop,
      onLocate: noop,
      onRestoreDraft: noop,
      onDiagnose: noop,
      onPlanChange: noop,
      onPlanConfirm: noop,
      onPlanCancel: noop,
      onBudgetLimitChange: noop,
      onRollback: noop,
    } as any));
    expect(markup).toContain('<strong>已确认</strong>');
    expect(markup).toContain('<li>比例：16:9</li>');
    expect(markup).not.toContain('**已确认**');
  });

  it('collapses resolved approval cards to a one-line receipt by default', () => {
    const markup = renderToStaticMarkup(React.createElement(AgentFeedCard, {
      item: {
        id: 'approval-1', kind: 'approval', runId: 'run-1', approvalId: 'call-1',
        toolName: 'canvas_command', summary: 'Create image node', arguments: { type: 'node.create' },
        impact: { effect: 'canvas-write', title: 'node.create', summary: 'Create image node', affectedNodeCount: 1, affectedEdgeCount: 0, externalSideEffect: false },
        expiresAt: Date.now() + 60_000, status: 'approved', createdAt: 1,
      },
      onApproval: noop,
      onLocate: noop,
      onRestoreDraft: noop,
      onDiagnose: noop,
      onPlanChange: noop,
      onPlanConfirm: noop,
      onPlanCancel: noop,
      onBudgetLimitChange: noop,
      onRollback: noop,
    } as any));
    expect(markup).toContain('canvasAgent.approvalStatus.approved');
    expect(markup).not.toContain('Create image node');
    expect(markup).not.toContain('canvasAgent.viewDetails');
  });

  it('offers Agent diagnostics and draft restoration after a recoverable failure', () => {
    const markup = renderToStaticMarkup(React.createElement(AgentFeedCard, {
      item: {
        id: 'error-1', kind: 'status', status: 'error', text: '生成失败',
        retryMessage: '创建图片', diagnosticMessage: '诊断后继续', createdAt: 1,
      },
      onApproval: noop,
      onLocate: noop,
      onRestoreDraft: noop,
      onDiagnose: noop,
      onPlanChange: noop,
      onPlanConfirm: noop,
      onPlanCancel: noop,
      onBudgetLimitChange: noop,
      onRollback: noop,
    } as any));
    expect(markup).toContain('canvasAgent.diagnoseAndContinue');
    expect(markup).toContain('canvasAgent.restoreDraft');
  });

  it('uses warning semantics for stale preview conflicts and exposes both generation locate targets', () => {
    const markup = renderToStaticMarkup(React.createElement(AgentFeedCard, {
      item: {
        id: 'warning', kind: 'tool', toolName: 'canvas_command', status: 'warning',
        error: '画布或配置在审批后发生变化，需要重新预览。',
        generationInputNodeIds: ['input'], generationResultNodeIds: ['result'], createdAt: 1,
      },
      onApproval: noop,
      onLocate: noop,
      onRestoreDraft: noop,
      onDiagnose: noop,
      onPlanChange: noop,
      onPlanConfirm: noop,
      onPlanCancel: noop,
      onBudgetLimitChange: noop,
      onRollback: noop,
    } as any));
    expect(markup).toContain('canvasAgent.toolStatus.warning');
    expect(markup).toContain('border-amber-500/30');
    expect(markup).not.toContain('role="alert"');
    expect(markup).toContain('canvasAgent.locateGenerationInput');
    expect(markup).toContain('canvasAgent.locateGenerationResult');
  });
});
