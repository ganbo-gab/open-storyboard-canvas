import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

import { GenerationTasksPanel } from './GenerationTasksPanel';

describe('GenerationTasksPanel', () => {
  it('keeps Tasks and Logs inside the existing Agent task surface', () => {
    const markup = renderToStaticMarkup(React.createElement(GenerationTasksPanel, { nodes: [] }));
    expect(markup).toContain('generationJob.view.tasks');
    expect(markup).toContain('generationJob.view.logs');
    expect(markup).toContain('role="tablist"');
    expect(markup).toContain('aria-selected="true"');
  });
});
