import React from 'react';
import { createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { CanvasAgentHeader } from './CanvasAgentHeader';

describe('CanvasAgentHeader', () => {
  it('shows the selected external runtime instead of the built-in model label', () => {
    const markup = renderToStaticMarkup(React.createElement(CanvasAgentHeader, {
      selectedEntry: { providerLabel: 'Provider', modelLabel: 'Model' },
      runtimeLabel: 'Codex',
      activeView: 'conversation',
      pendingCount: 0,
      isRunning: false,
      isReady: true,
      onViewChange: vi.fn(),
      onClose: vi.fn(),
      closeRef: createRef<HTMLButtonElement>(),
    }));
    expect(markup).toContain('Codex');
    expect(markup).not.toContain('Provider / Model');
  });
});
