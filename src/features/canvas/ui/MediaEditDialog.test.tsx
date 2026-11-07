// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/features/assets/ui/useAssetDisplaySource', () => ({ useAssetDisplaySource: (source: string) => ({ url: source, error: null }) }));
vi.mock('@/features/canvas/application/media', async (original) => ({ ...await original<typeof import('@/features/canvas/application/media')>(),
  getMediaEditCapability: vi.fn(async () => ({ supported: true })), runNodeMediaEdit: vi.fn() }));
import { MediaEditDialog } from './MediaEditDialog';
import { runNodeMediaEdit } from '@/features/canvas/application/media';
beforeEach(() => vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} }));
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });
it('edits a library video using the shared source callback without mutating canvas nodes', async () => {
  const onApply = vi.fn(async () => ({ count: 1 }));
  render(<MediaEditDialog source="/fixture/video.webm" media="video" onClose={vi.fn()} onApply={onApply} />);
  fireEvent.click(screen.getByRole('button', { name: '保存编辑副本' }));
  await waitFor(() => expect(onApply).toHaveBeenCalledOnce());
  expect(onApply).toHaveBeenCalledWith({ kind: 'video.captureFrame', timeSeconds: 0 }, expect.objectContaining({ signal: expect.any(AbortSignal), onProgress: expect.any(Function) }));
  expect(runNodeMediaEdit).not.toHaveBeenCalled(); expect(await screen.findByText(/原素材未改动/)).toBeTruthy();
});
