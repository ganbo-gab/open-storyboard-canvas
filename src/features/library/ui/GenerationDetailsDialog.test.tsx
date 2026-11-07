// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { GenerationDetailsDialog } from './GenerationDetailsDialog';
import { loadGenerationDetails } from '../application/generationDetails';
import { requestHistoryNavigation } from '@/features/studio/studioNavigation';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }));
vi.mock('../application/generationDetails', () => ({ loadGenerationDetails: vi.fn(async () => ({
  source: { surface: 'canvas', nodeId: 'source' }, facts: [{ key: 'model', value: 'saved-model' }, { key: 'size' }],
  prompt: 'saved prompt', upstreamPrompt: undefined, jobs: [], outputs: [], records: [], errors: [], diagnostics: '{"safe":true}',
})) }));
vi.mock('@/features/studio/studioNavigation', () => ({ requestHistoryNavigation: vi.fn() }));
afterEach(cleanup);

it('shows missing evidence and locates the original source without a generation action', async () => {
  const close = vi.fn(); render(<GenerationDetailsDialog target={{ recordId: 'old' }} onClose={close} />);
  await screen.findByText('saved-model');
  expect(screen.getByText('ui.details.upstreamMissing')).toBeTruthy();
  expect(screen.getByText('ui.details.notRecorded')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'ui.details.retrieve' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'ui.details.locateSource' }));
  expect(requestHistoryNavigation).toHaveBeenCalledWith({ surface: 'canvas', nodeId: 'source' });
  expect(close).toHaveBeenCalledOnce();
  await waitFor(() => expect(loadGenerationDetails).toHaveBeenCalledOnce());
});
