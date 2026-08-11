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

import { AgentFeedCard } from './AgentFeedCard';

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
    onPlanChange: noop,
    onPlanConfirm: noop,
    onPlanCancel: noop,
    onBudgetLimitChange: noop,
    onRollback: noop,
  } as any));
}

describe('AgentFeedCard diagnostics export actions', () => {
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
