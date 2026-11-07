import { beforeEach, describe, expect, it, vi } from 'vitest';
const upload = vi.hoisted(() => vi.fn());
const portable = vi.hoisted(() => vi.fn());
vi.mock('@/features/canvas/application/imageHosting', () => ({ uploadImageToConfiguredHost: upload }));
vi.mock('@/features/assets/application/assetMediaStorage', () => ({ getAssetPortableSource: portable }));
import { hostChannelReferenceSlot, isImageHostConfigured, uploadChannelReferenceToConfiguredHost } from './referenceHosting';
import type { JobRef } from '../runtime/types';
import { DEFAULT_IMAGE_HOST_SETTINGS, useSettingsStore } from '@/stores/settingsStore';

const ref: JobRef = { kind: 'image', slot: 'first_frame', assetId: 'local', path: 'data:image/png;base64,AA==', mime: 'image/png' };
beforeEach(() => {
  upload.mockReset().mockResolvedValue('https://hosting.example/public.png');
  portable.mockReset().mockImplementation(async (source: string) => source.startsWith('asset-media:') ? ref.path : source);
});
describe('explicit configured reference hosting', () => {
  it('uploads only after explicit confirmation, preserving reference identity and slot', async () => {
    await expect(uploadChannelReferenceToConfiguredHost(ref, { confirmed: false } as unknown as { confirmed: true })).rejects.toThrow('reference.uploadNotConfirmed');
    expect(upload).not.toHaveBeenCalled();
    expect(await uploadChannelReferenceToConfiguredHost(ref, { confirmed: true }, 2)).toEqual({ ...ref, path: 'https://hosting.example/public.png' });
    expect(upload).toHaveBeenCalledExactlyOnceWith(ref.path, 2, useSettingsStore.getState().imageHostSettings);
    expect(ref.path).toBe('data:image/png;base64,AA==');
  });
  it('resolves durable asset handles before passing confirmed image bytes to the configured host', async () => {
    await uploadChannelReferenceToConfiguredHost({ ...ref, path: 'asset-media:durable-frame' }, { confirmed: true });
    expect(upload).toHaveBeenCalledExactlyOnceWith(ref.path, 0, useSettingsStore.getState().imageHostSettings);
  });
  it('never uploads remote references or silently disguises non-image media as an image', async () => {
    const remote = { ...ref, path: 'https://cdn.example/frame.png' };
    expect(await uploadChannelReferenceToConfiguredHost(remote, { confirmed: true })).toBe(remote);
    await expect(uploadChannelReferenceToConfiguredHost({ ...ref, kind: 'audio', mime: 'audio/wav' }, { confirmed: true })).rejects.toThrow('reference.publicUrlRequiredForMedia');
    expect(upload).not.toHaveBeenCalled();
  });
  it('rejects non-public or credential-bearing URLs returned by a configured host', async () => {
    upload.mockResolvedValue('https://user:secret@hosting.example/result.png');
    await expect(uploadChannelReferenceToConfiguredHost(ref, { confirmed: true })).rejects.toThrow('reference.invalidHostedUrl');
  });
});
describe('hosting one failed slot', () => {
  it('hosts each local source in order and leaves public sources and other slots untouched', async () => {
    upload.mockResolvedValueOnce('https://hosting.example/a.png').mockResolvedValueOnce('https://hosting.example/c.png');
    const slots = { first_frame: ['/a.png', 'https://cdn.example/b.png', 'asset-media:c'], last_frame: ['/last.png'] };
    expect(await hostChannelReferenceSlot(slots, 'first_frame', 'image', { confirmed: true })).toEqual({
      first_frame: ['https://hosting.example/a.png', 'https://cdn.example/b.png', 'https://hosting.example/c.png'],
      last_frame: ['/last.png'],
    });
    expect(upload.mock.calls.map(([source, index]) => [source, index])).toEqual([['/a.png', 0], [ref.path, 2]]);
    expect(slots.first_frame[0]).toBe('/a.png');
  });
  it('rejects as a whole when any upload fails, so no partially hosted slot is produced', async () => {
    upload.mockResolvedValueOnce('https://hosting.example/a.png').mockRejectedValueOnce(new Error('HTTP 500'));
    await expect(hostChannelReferenceSlot({ frames: ['/a.png', '/b.png'] }, 'frames', 'image', { confirmed: true })).rejects.toThrow('HTTP 500');
  });
});
describe('image host readiness', () => {
  it.each([
    ['disabled hosting', { ...DEFAULT_IMAGE_HOST_SETTINGS, enabled: false }, false],
    ['enabled without an endpoint', { ...DEFAULT_IMAGE_HOST_SETTINGS, enabled: true }, false],
    ['explicit custom host', { ...DEFAULT_IMAGE_HOST_SETTINGS, enabled: true, uploadUrl: 'https://uploads.example/images' }, true],
    ['invalid response path', { ...DEFAULT_IMAGE_HOST_SETTINGS, enabled: true, uploadUrl: 'https://uploads.example/images', responseUrlPath: '' }, false],
  ])('%s', (_label, settings, ready) => {
    expect(isImageHostConfigured(settings)).toBe(ready);
  });
});
