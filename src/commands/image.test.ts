import { beforeEach, describe, expect, it, vi } from 'vitest';

const tauriMocks = vi.hoisted(() => ({
  isTauri: vi.fn<() => boolean>(),
  invoke: vi.fn<(command: string, args?: unknown) => Promise<string>>(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  isTauri: tauriMocks.isTauri,
  invoke: tauriMocks.invoke,
}));

import { persistImageSource } from './image';

describe('image persistence runtime routing', () => {
  beforeEach(() => {
    tauriMocks.isTauri.mockReset();
    tauriMocks.invoke.mockReset();
  });

  it('keeps a browser data URL for project image-pool persistence without invoking Tauri', async () => {
    tauriMocks.isTauri.mockReturnValue(false);
    const source = 'data:image/png;base64,cGl4ZWxz';

    await expect(persistImageSource(source)).resolves.toBe(source);
    expect(tauriMocks.invoke).not.toHaveBeenCalled();
  });

  it('persists image data through the native command in Tauri', async () => {
    tauriMocks.isTauri.mockReturnValue(true);
    tauriMocks.invoke.mockResolvedValue('/saved/snapshot.png');

    await expect(persistImageSource('data:image/png;base64,cGl4ZWxz')).resolves.toBe('/saved/snapshot.png');
    expect(tauriMocks.invoke).toHaveBeenCalledWith('persist_image_source', {
      source: 'data:image/png;base64,cGl4ZWxz',
    });
  });
});
