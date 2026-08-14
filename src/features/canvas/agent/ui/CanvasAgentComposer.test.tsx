import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import en from '@/i18n/locales/en.json';
import zh from '@/i18n/locales/zh.json';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => values?.name ? `${key}:${values.name}` : key,
  }),
}));

import {
  CanvasAgentComposer,
  formatCanvasAgentContextEstimate,
  shouldSubmitCanvasAgentComposerEnter,
} from './CanvasAgentComposer';

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

  it('uses compact non-native controls for attachments, models, mode, and context', () => {
    const markup = render();
    expect(markup).not.toContain('<select');
    expect(markup).toContain('canvasAgent.addAttachment');
    expect(markup).toContain('canvasAgent.modelMenuTitle');
    expect(markup).toContain('canvasAgent.executionMode');
    expect(markup).toContain('canvasAgent.contextUsage');
    expect(markup).toContain('canvasAgent.send');
  });

  it('shows configuration guidance when no built-in text model is available', () => {
    expect(render({ selectedTextModel: null })).toContain('canvasAgent.configureModel');
  });

  it('declares quick model category labels for the grouped picker', () => {
    const source = String(CanvasAgentComposer);
    expect(source).toContain('canvasAgent.modelTabs.text');
    expect(source).toContain('canvasAgent.modelTabs.image');
    expect(source).toContain('canvasAgent.modelTabs.video');
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

  it('does not submit the Enter key that commits an IME composition', () => {
    expect(shouldSubmitCanvasAgentComposerEnter({
      key: 'Enter', shiftKey: false, nativeIsComposing: true,
      trackedIsComposing: true, compositionEndedAgoMs: 0,
    })).toBe(false);
    expect(shouldSubmitCanvasAgentComposerEnter({
      key: 'Enter', shiftKey: false, nativeIsComposing: false,
      trackedIsComposing: false, compositionEndedAgoMs: 20,
    })).toBe(false);
    expect(shouldSubmitCanvasAgentComposerEnter({
      key: 'Enter', shiftKey: false, nativeIsComposing: false,
      trackedIsComposing: false, compositionEndedAgoMs: 120,
    })).toBe(true);
  });
});
