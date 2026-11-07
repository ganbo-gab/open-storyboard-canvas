import { beforeEach, describe, expect, it, vi } from 'vitest';
import { tauriKnowledgeIO } from './tauriKnowledgeIO';

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke, isTauri: () => true }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
vi.mock('@/commands/image', () => ({ loadImage: vi.fn() }));
vi.mock('@/features/assets/application/assetMediaStorage', () => ({ getAssetPortableSource: vi.fn() }));
beforeEach(() => mocks.invoke.mockReset());

describe('knowledge native IO boundary', () => {
  it('retains every binary byte from the raw native response without text decoding', async () => {
    const input = new Uint8Array([0, 255, 128, 10, 0]);
    mocks.invoke.mockResolvedValue(input.buffer);
    const output = await tauriKnowledgeIO.readAttachment('/vault', 'attachments/nested/参考.bin');
    expect(output).toEqual(input);
    expect(output.byteLength).toBe(5);
  });
  it('rejects malformed native tree and note data before it reaches the index', async () => {
    mocks.invoke.mockResolvedValue([{ path: 'A.md', name: 'A.md', kind: 'note', size: -1, modifiedAt: 0 }]);
    await expect(tauriKnowledgeIO.listTree('/vault')).rejects.toThrow();
    mocks.invoke.mockResolvedValue([{ path: 'A.md', content: 7 }]);
    await expect(tauriKnowledgeIO.readNotes('/vault', ['A.md'])).rejects.toThrow();
    mocks.invoke.mockResolvedValue('not binary');
    await expect(tauriKnowledgeIO.readAttachment('/vault', 'attachments/image.png')).rejects.toThrow();
    mocks.invoke.mockResolvedValue({ root: '/vault' });
    await expect(tauriKnowledgeIO.openVault('/vault')).rejects.toThrow();
    mocks.invoke.mockResolvedValue('relative/vault');
    await expect(tauriKnowledgeIO.openVault('/vault')).rejects.toMatchObject({ code: 'INVALID_VAULT' });
  });
  it('rejects unsafe paths and implicit roots without issuing native filesystem requests', async () => {
    for (const path of ['/tmp/private.bin', 'attachments/%2e%2e/private.bin', 'attachments/../private.bin', 'attachments/.OBSIDIAN/private.bin']) {
      await expect(tauriKnowledgeIO.readAttachment('/vault', path)).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
      await expect(tauriKnowledgeIO.removeAttachment('/vault', path)).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    }
    await expect(tauriKnowledgeIO.initVault('~/vault')).rejects.toMatchObject({ code: 'INVALID_VAULT' });
    await expect(tauriKnowledgeIO.openVault('~/vault')).rejects.toMatchObject({ code: 'INVALID_VAULT' });
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
