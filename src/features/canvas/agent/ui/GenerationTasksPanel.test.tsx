import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

import { GenerationTasksPanel } from './GenerationTasksPanel';

describe('GenerationTasksPanel', () => {
  it('keeps generation tasks contextual and leaves diagnostics outside the Agent', () => {
    const markup = renderToStaticMarkup(React.createElement(GenerationTasksPanel, { nodes: [] }));
    expect(markup).toContain('generationJob.taskPanelTitle');
    expect(markup).not.toContain('generationJob.view.logs');
    expect(markup).not.toContain('<select');
  });
});
