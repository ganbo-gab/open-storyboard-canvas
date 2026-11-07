// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readClipboardContent, writeTextToClipboard } from './clipboardIO';
import { readSystemClipboard, writeSystemClipboardText } from '@/commands/image';
vi.mock('@/commands/image', () => ({ readSystemClipboard: vi.fn(), writeSystemClipboardText: vi.fn() }));
let browserRead = vi.fn();
beforeEach(() => { vi.resetAllMocks(); browserRead = vi.fn(); Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { read: browserRead, writeText: vi.fn(), readText: vi.fn() } }); });
afterEach(() => vi.restoreAllMocks());
describe('authoritative system clipboard', () => {
  it('does not revive a different browser representation when native clipboard is empty or fails', async () => {
    vi.mocked(readSystemClipboard).mockResolvedValue({ text: null, image: null, filePaths: [] });
    expect((await readClipboardContent()).text).toBe(''); expect(browserRead).not.toHaveBeenCalled();
    vi.mocked(readSystemClipboard).mockRejectedValue(new Error('locked'));
    expect((await readClipboardContent()).readFailed).toBe(true); expect(browserRead).not.toHaveBeenCalled();
  });
  it('passes through native files and reads browser media/text from a single snapshot', async () => {
    vi.mocked(readSystemClipboard).mockResolvedValueOnce({ filePaths: ['/tmp/a.mov'], text: 'a.mov' });
    expect((await readClipboardContent()).filePaths).toEqual(['/tmp/a.mov']);
    vi.mocked(readSystemClipboard).mockResolvedValue(null);
    browserRead.mockResolvedValue([{ types: ['text/plain','image/png'], getType: async (type: string) => type==='text/plain' ? { text: async () => 'image label' } : new Blob(['png'], { type }) }]);
    const value = await readClipboardContent();
    expect(value.text).toBe('image label'); expect(value.mediaFile?.type).toBe('image/png');
    expect(browserRead).toHaveBeenCalledOnce(); expect(navigator.clipboard.readText).not.toHaveBeenCalled();
  });
  it('writes node text using native clipboard before considering browser APIs', async () => {
    vi.mocked(writeSystemClipboardText).mockResolvedValue(true);
    await writeTextToClipboard('node snapshot');
    expect(writeSystemClipboardText).toHaveBeenCalledWith('node snapshot');
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });
  it('reports denied browser binary reads rather than pasting an incomplete text representation', async () => {
    vi.mocked(readSystemClipboard).mockResolvedValue(null);
    browserRead.mockRejectedValue(new Error('permission denied'));
    expect((await readClipboardContent()).readFailed).toBe(true);
    expect(navigator.clipboard.readText).not.toHaveBeenCalled();
  });
});
