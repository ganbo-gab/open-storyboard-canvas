import React, { createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import en from '@/i18n/locales/en.json';
import zh from '@/i18n/locales/zh.json';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => values?.name ? `${key}:${values.name}` : key,
  }),
}));

import { CanvasAgentComposer, formatCanvasAgentContextEstimate } from './CanvasAgentComposer';

const noop = () => {};
const textModel = { id: 'text-model', providerLabel: 'Provider', modelLabel: 'Text Model', supportsMultimodal: true };

function localeTranslator(locale: typeof en | typeof zh) {
  return (key: string, values: { used: string; limit?: string }) => {
    const segments = key.split('.');
    const name = segments[segments.length - 1] as keyof typeof locale.canvasAgent;
    const template = locale.canvasAgent[name];
    if (typeof template !== 'string') return key;
    return template.replace(/\{\{(used|limit)\}\}/g, (_match, field: 'used' | 'limit') => values[field] ?? '');
  };
}

function render(overrides: Record<string, unknown> = {}) {
  return renderToStaticMarkup(React.createElement(CanvasAgentComposer, {
    textModels: [textModel],
    imageModels: [{ id: 'image-model', providerLabel: 'Images', modelLabel: 'Image Model' }],
    videoModels: [{ id: 'video-model', providerLabel: 'Videos', modelLabel: 'Video Model' }],
    selectedTextModel: textModel,
    selectedImageModelId: 'image-model',
    selectedVideoModelId: 'video-model',
    executionMode: 'manual',
    draft: 'Describe the shot',
    attachments: [],
    maxAttachments: 8,
    hasMissingAttachments: false,
    isRunning: false,
    hasPendingApproval: false,
    hasPendingPlan: false,
    contextEstimateTokens: 480,
    contextWindow: 128_000,
    onTextModelChange: noop,
    onImageModelChange: noop,
    onVideoModelChange: noop,
    onExecutionModeChange: noop,
    onDraftChange: noop,
    onAttach: noop,
    onRemoveAttachment: noop,
    onSend: noop,
    onCancel: noop,
    onSettings: noop,
    textareaRef: createRef<HTMLTextAreaElement>(),
    ...overrides,
  }));
}

describe('CanvasAgentComposer', () => {
  it('renders safely while optional attachment props are omitted', () => {
    expect(() => render({ attachments: undefined, maxAttachments: undefined })).not.toThrow();
  });

  it('renders removable attachment thumbnails without persisting their media bodies', () => {
    const markup = render({
      attachments: [
        { assetId: 'node-1:image', nodeId: 'node-1', title: 'Hero', origin: 'canvas-asset', source: 'https://assets.test/hero.png' },
        { assetId: 'node-2:image', nodeId: 'node-2', title: 'Style', origin: 'canvas-asset', source: 'https://assets.test/style.png' },
      ],
    });
    expect(markup).toContain('Hero');
    expect(markup).toContain('Style');
    expect(markup).toContain('canvasAgent.removeNamedAttachment:Hero');
  });

  it('names the model and channel the next turn actually uses', () => {
    expect(render()).toContain('Provider · Text Model');
  });

  it('shows configuration guidance when no runnable text model exists', () => {
    expect(render({ selectedTextModel: null, textModels: [], modelIssue: 'unset' })).toContain('canvasAgent.configureModel');
  });

  it('asks for a new choice instead of substituting another model when the saved one is gone', () => {
    const markup = render({ selectedTextModel: null, modelIssue: 'missing' });
    expect(markup).toContain('rework.agent.selection.issue.missing');
    expect(markup).not.toContain('Provider · Text Model');
    expect(markup).toMatch(/aria-label="canvasAgent\.send"[^>]*disabled=""|disabled=""[^>]*aria-label="canvasAgent\.send"/);
  });

  it('formats estimated context usage against the selected model limit', () => {
    const used = 480;
    const limit = 128_000;
    for (const locale of [en, zh]) {
      const translate = localeTranslator(locale);
      const known = formatCanvasAgentContextEstimate(translate, used, limit);
      const unknown = formatCanvasAgentContextEstimate(translate, used, null);
      expect(known).toContain(used.toLocaleString());
      expect(known).toContain(limit.toLocaleString());
      expect(unknown).toContain(used.toLocaleString());
      expect(unknown).toMatch(/unknown|未知/i);
      expect(`${known}${unknown}`).not.toMatch(/\{\{(?:used|limit)\}\}/);
    }
  });
  it('does not show an old percentage when the next turn uses a different text model', () => {
    const usage = { requestId: 'old-request', modelId: 'text-model', measuredAt: 1, usedTokens: 12000,
      breakdown: { system: 2000, tools: 5000, conversation: 5000, media: 0 }, basis: 'provider', cachedTokens: 0, outputTokens: 100, images: 0 };
    expect(render({ contextUsage: usage, contextEstimateTokens: 12000, contextWindow: 100000 })).toContain('12%');
    const changed = { ...textModel, id: 'other-text-model' };
    expect(render({ contextUsage: usage, contextEstimateTokens: 0, contextWindow: 100000, selectedTextModel: changed, textModels: [changed] })).not.toContain('12%');
  });
});
