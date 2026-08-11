import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => values?.name ? `${key}:${values.name}` : key,
  }),
}));

import { CanvasAgentComposer } from './CanvasAgentComposer';

const noop = () => {};

function render(overrides: Record<string, unknown> = {}) {
  return renderToStaticMarkup(React.createElement(CanvasAgentComposer, {
    entries: [{ id: 'model', providerLabel: 'Provider', modelLabel: 'Model', supportsMultimodal: true }],
    selectedEntry: { id: 'model', providerLabel: 'Provider', modelLabel: 'Model', supportsMultimodal: true },
    draft: 'Describe the shot',
    isRunning: false,
    hasPendingApproval: false,
    hasPendingPlan: false,
    onModelChange: noop,
    onDraftChange: noop,
    onAttach: noop,
    onRemoveAttachment: noop,
    onSend: noop,
    onCancel: noop,
    onSettings: noop,
    ...overrides,
  } as any));
}

describe('CanvasAgentComposer', () => {
  it('renders safely while older/HMR callers have not provided attachment props', () => {
    expect(() => render({ attachments: undefined, maxAttachments: undefined }))
      .not.toThrow();
  });

  it('renders multiple bounded attachment chips without persisting their media bodies', () => {
    const markup = render({
      attachments: [
        { assetId: 'node-1:image', nodeId: 'node-1', title: 'Hero', origin: 'canvas-asset', source: 'https://assets.test/hero.png' },
        { assetId: 'node-2:image', nodeId: 'node-2', title: 'Style', origin: 'canvas-asset', source: 'https://assets.test/style.png' },
      ],
      maxAttachments: 8,
      hasMissingAttachments: false,
    });
    expect(markup).toContain('Hero');
    expect(markup).toContain('Style');
    expect(markup).toContain('canvasAgent.attachmentCount');
  });
});
