// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MediaViewerHost } from './MediaViewerHost';
import { closeMediaViewer, openMediaViewer, useMediaViewerStore } from './viewerStore';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/features/assets/ui/useAssetDisplaySource', () => ({ useAssetDisplaySource: (source: string) => ({ url: source, error: null }) }));
afterEach(() => { cleanup(); closeMediaViewer(); });

it('switches media by keyboard, resets zoom, and closes with Escape', () => {
  openMediaViewer([{ id: 'one', kind: 'image', source: 'data:image/png;base64,one', title: 'One' }, { id: 'two', kind: 'video', source: '/two.mp4', title: 'Two' }]);
  render(<MediaViewerHost />);
  fireEvent.click(screen.getByRole('button', { name: 'ui.viewer.zoomIn' }));
  expect(screen.getByText('125%')).toBeTruthy();
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowRight' });
  expect(useMediaViewerStore.getState().index).toBe(1);
  expect(document.querySelector('video')?.getAttribute('src')).toBe('/two.mp4');
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowLeft' });
  expect(screen.getByText('100%')).toBeTruthy();
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  expect(useMediaViewerStore.getState().open).toBe(false);
});

it('does not duplicate a pending action and shows a media error with recovery guidance', async () => {
  const work = Promise.withResolvers<void>();
  const run = vi.fn(() => work.promise);
  openMediaViewer([{ id: 'one', kind: 'image', source: '/missing.png', actions: [{ id: 'original', label: 'Original', run }] }]);
  render(<MediaViewerHost />);
  fireEvent.click(screen.getByRole('button', { name: 'Original' }));
  fireEvent.click(screen.getByRole('button', { name: 'Original' }));
  expect(run).toHaveBeenCalledOnce();
  await act(async () => work.resolve());
  fireEvent.error(document.querySelector('img')!);
  expect(screen.getByRole('alert').textContent).toBe('ui.viewer.mediaMissing');
});
