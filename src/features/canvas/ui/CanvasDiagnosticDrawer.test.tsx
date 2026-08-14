import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'zh-CN' } }),
}));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true }));

import { CanvasDiagnosticDrawer } from './CanvasDiagnosticDrawer';

describe('CanvasDiagnosticDrawer', () => {
  it('uses human-readable controls without native select filters', () => {
    const markup = renderToStaticMarkup(React.createElement(CanvasDiagnosticDrawer, {
      isOpen: true,
      nodes: [],
      onClose: () => undefined,
    }));
    expect(markup).toContain('generationJob.logDrawerTitle');
    expect(markup).toContain('generationJob.searchLogs');
    expect(markup).not.toContain('<select');
    expect(markup).not.toContain('generationJob.view.tasks');
  });
});
