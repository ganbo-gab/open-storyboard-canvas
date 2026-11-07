// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('./useAssetDisplaySource', () => ({ useAssetDisplaySource: (source: string) => ({ url: source, error: null }) }));
vi.mock('../application/assetMediaStorage', async (original) => ({ ...await original<typeof import('../application/assetMediaStorage')>(),
  getAssetPortableSource: async (source: string) => source, getAssetDisplaySource: async (source: string) => source }));
vi.mock('@/features/canvas/application/imageData', async (original) => ({ ...await original<typeof import('@/features/canvas/application/imageData')>(),
  loadImageElement: vi.fn(async () => ({ naturalWidth: 480, naturalHeight: 270, src: '' })) }));
vi.mock('@/features/canvas/ui/tool-editors/CropToolEditor', () => ({ CropToolEditor: ({ onOptionsChange }: { onOptionsChange(value: Record<string, number | string>): void }) =>
  <button onClick={() => onOptionsChange({ cropX: 10, cropY: 20, cropWidth: 480, cropHeight: 270, aspectRatio: 'free' })}>模拟选定裁剪范围</button> }));
vi.mock('@/features/canvas/ui/tool-editors/AnnotateToolEditor', () => ({ AnnotateToolEditor: () => <span>标注画布</span> }));
import { canvasToolProcessor } from '@/features/canvas/application/canvasServices';
import { AssetEditDialog } from './AssetEditDialog';
import type { AssetRecord } from '../application/assetCatalog';
const image: AssetRecord = { id: 'original', kind: 'image', name: 'Original', source: '/fixture/original.png', origin: 'uploaded', favorite: false, createdAt: 1, metadata: { prompt: 'Original prompt' } };
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
  vi.spyOn(canvasToolProcessor, 'process').mockResolvedValue({ outputImageUrl: '/fixture/cropped.png' });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('saves current crop and explanation directly without requiring a separate apply click', async () => {
  const save = vi.fn(async () => ({ ...image, id: 'derived', source: '/fixture/cropped.png' })); const onClose = vi.fn();
  render(<AssetEditDialog asset={image} save={save} onClose={onClose} />);
  fireEvent.click(screen.getByRole('button', { name: '模拟选定裁剪范围' }));
  fireEvent.change(screen.getByRole('textbox', { name: '素材提示词 / 说明' }), { target: { value: 'Edited explanation' } });
  fireEvent.click(screen.getByRole('button', { name: '保存编辑副本' }));
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(canvasToolProcessor.process).toHaveBeenCalledExactlyOnceWith('crop', image.source, expect.objectContaining({ cropWidth: 480, cropHeight: 270 }));
  expect(save).toHaveBeenCalledWith({ kind: 'image', source: '/fixture/cropped.png', width: 480, height: 270 },
    expect.objectContaining({ prompt: 'Edited explanation', operations: ['裁剪'] }));
  expect(image.source).toBe('/fixture/original.png'); expect(onClose).toHaveBeenCalledOnce();
});
it('keeps the editor open on save failure and does not report success', async () => {
  const save = vi.fn().mockRejectedValue(new Error('disk full')); const onClose = vi.fn(); const onSaved = vi.fn();
  render(<AssetEditDialog asset={{ ...image, kind: 'text', source: 'Original text' }} save={save} onClose={onClose} onSaved={onSaved} />);
  fireEvent.change(screen.getByRole('textbox', { name: '文本内容' }), { target: { value: 'Edited text' } });
  fireEvent.click(screen.getByRole('button', { name: '保存编辑副本' }));
  expect((await screen.findByRole('alert')).textContent).toContain('disk full');
  expect(save).toHaveBeenCalledWith({ kind: 'text', source: 'Edited text' }, expect.objectContaining({ operations: ['text.edit'] }));
  expect(canvasToolProcessor.process).not.toHaveBeenCalled(); expect(onSaved).not.toHaveBeenCalled(); expect(onClose).not.toHaveBeenCalled();
});
it('preserves pending crop when switching to annotation and permits one step undo', async () => {
  render(<AssetEditDialog asset={image} onClose={vi.fn()} save={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: '模拟选定裁剪范围' }));
  fireEvent.click(screen.getByRole('radio', { name: '标注' }));
  expect(await screen.findByText('标注画布')).toBeTruthy();
  expect(canvasToolProcessor.process).toHaveBeenCalledOnce();
  expect(screen.getByRole('button', { name: '撤销图片编辑' }).hasAttribute('disabled')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: '撤销图片编辑' }));
  expect(screen.getByText(/当前步骤：原图/)).toBeTruthy();
});
