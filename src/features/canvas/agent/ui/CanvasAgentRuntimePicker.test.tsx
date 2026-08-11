import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }));

import { CanvasAgentRuntimePicker } from './CanvasAgentRuntimePicker';

describe('CanvasAgentRuntimePicker', () => {
  it('renders all runtimes and an actionable unavailable status', () => {
    const markup = renderToStaticMarkup(React.createElement(CanvasAgentRuntimePicker, {
      value: 'codex',
      diagnostics: {
        codex: { runtime: 'codex', availability: 'not-installed', detail: 'codex was not found' },
        claude: { runtime: 'claude', availability: 'ready', version: '1.2.3' },
      },
      isRefreshing: false,
      onChange: vi.fn(),
      onRefresh: vi.fn(),
    }));

    expect(markup).toContain('canvasAgent.runtime.builtin');
    expect(markup).toContain('canvasAgent.runtime.codex');
    expect(markup).toContain('canvasAgent.runtime.claude');
    expect(markup).toContain('canvasAgent.runtime.status.not-installed');
    expect(markup).toContain('codex was not found');
    expect(markup).toContain('canvasAgent.runtime.installGuide');
  });

  it('locks runtime switching and refresh while a turn or approval is active', () => {
    const markup = renderToStaticMarkup(React.createElement(CanvasAgentRuntimePicker, {
      value: 'builtin',
      diagnostics: {},
      isRefreshing: false,
      disabled: true,
      onChange: vi.fn(),
      onRefresh: vi.fn(),
    }));
    expect(markup.match(/disabled=""/g)).toHaveLength(4);
  });
});
