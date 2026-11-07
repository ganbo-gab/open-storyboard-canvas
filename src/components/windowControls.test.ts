import { describe, expect, it, vi } from 'vitest';
import { changeWindowSize } from './windowControls';
const window = (maximized = false, fullscreen = false) => ({
  isMaximized: vi.fn(async () => maximized), isFullscreen: vi.fn(async () => fullscreen),
  maximize: vi.fn(async () => {}), unmaximize: vi.fn(async () => {}), setFullscreen: vi.fn(async (_value: boolean) => {}),
});
describe('desktop window actions', () => {
  it('enters and exits native fullscreen without treating it as maximization', async () => {
    const normal = window(); await changeWindowSize(normal, 'fullscreen'); expect(normal.setFullscreen).toHaveBeenCalledWith(true); expect(normal.maximize).not.toHaveBeenCalled();
    const full = window(false, true); await changeWindowSize(full, 'fullscreen'); expect(full.setFullscreen).toHaveBeenCalledWith(false);
  });
  it('maximizes and restores Windows / Option-green / double-click states', async () => {
    const normal = window(); await changeWindowSize(normal, 'maximize'); expect(normal.maximize).toHaveBeenCalledOnce();
    const max = window(true); await changeWindowSize(max, 'maximize'); expect(max.unmaximize).toHaveBeenCalledOnce();
    const full = window(false, true); await changeWindowSize(full, 'maximize'); expect(full.setFullscreen).toHaveBeenCalledWith(false); expect(full.maximize).not.toHaveBeenCalled();
  });
  it('does not maximize while native fullscreen is active, so F11/Ctrl-Cmd-F remains a toggle', async () => {
    const full = window(true, true); await changeWindowSize(full, 'maximize');
    expect(full.setFullscreen).toHaveBeenCalledWith(false);
    expect(full.unmaximize).not.toHaveBeenCalled();
    expect(full.maximize).not.toHaveBeenCalled();
  });
});
