import { beforeEach, describe, expect, it, vi } from 'vitest';
import { customHttpRequest } from '@/commands/ai';
import { imageUrlToDataUrl } from './imageData';
import { uploadImageToConfiguredHost } from './imageHosting';
import { DEFAULT_IMAGE_HOST_SETTINGS, normalizeImageHostSettings } from '@/features/settings/imageHostSettings';
import { secretToken } from '@/features/secrets/secretStore';

vi.mock('@/commands/ai', () => ({ customHttpRequest: vi.fn() }));
vi.mock('./imageData', () => ({ imageUrlToDataUrl: vi.fn(async () => 'data:image/png;base64,AAAA') }));
const settings = { ...DEFAULT_IMAGE_HOST_SETTINGS, enabled: true, uploadUrl: 'https://uploads.example/custom-upload', fileField: 'picture', responseUrlPath: '$.result.files[0].url' };
beforeEach(() => { vi.clearAllMocks(); vi.mocked(customHttpRequest).mockResolvedValue({ status: 200, text: '{"result":{"files":[{"url":"https://cdn.example/image.png"}]}}' }); });

describe('explicit generic image uploads', () => {
  it('uses exactly the configured endpoint, file field, vault references and JSON path', async () => {
    const token = secretToken({ namespace: 'image-host', id: 'custom/auth' });
    expect(await uploadImageToConfiguredHost('/local/image.png', 2, { ...settings, extraHeaders: { Authorization: token, 'X-Format': token } })).toBe('https://cdn.example/image.png');
    expect(customHttpRequest).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      url: settings.uploadUrl, method: 'POST', headers: { Accept: 'application/json', Authorization: token, 'X-Format': token }, bodyMode: 'multipart',
      multipart: { files: [{ name: 'picture', fileName: 'reference-3.png', dataUrl: 'data:image/png;base64,AAAA' }] },
    }));
  });
  it('does not convert or send local bytes for disabled, retired or incomplete configurations', async () => {
    const retired = normalizeImageHostSettings({ enabled: true, provider: 'pixhost', pixhost: { apiBaseUrl: 'https://api.pixhost.to' } });
    for (const candidate of [DEFAULT_IMAGE_HOST_SETTINGS, retired, { ...settings, uploadUrl: '' }, { ...settings, responseUrlPath: '' }]) {
      await expect(uploadImageToConfiguredHost('/local/image.png', 0, candidate)).rejects.toThrow();
    }
    expect(imageUrlToDataUrl).not.toHaveBeenCalled();
    expect(customHttpRequest).not.toHaveBeenCalled();
  });
  it('keeps existing hosted media without contacting a host', async () => {
    expect(await uploadImageToConfiguredHost('https://old-host.example/existing.png', 0, DEFAULT_IMAGE_HOST_SETTINGS)).toBe('https://old-host.example/existing.png');
    expect(customHttpRequest).not.toHaveBeenCalled();
  });
  it.each(['not json', '{"result":{"files":[{"url":"file:///private/image.png"}]}}', '{"url":"https://fallback.example/not-configured.png"}'])('rejects an invalid configured response %s without guessing a fallback or retrying', async (text) => {
    vi.mocked(customHttpRequest).mockResolvedValue({ status: 200, text });
    await expect(uploadImageToConfiguredHost('/local/image.png', 0, settings)).rejects.toThrow(/JSON|URL/);
    expect(customHttpRequest).toHaveBeenCalledOnce();
  });
  it('never retries an ambiguous transport failure', async () => {
    vi.mocked(customHttpRequest).mockRejectedValue(new Error('connection lost'));
    await expect(uploadImageToConfiguredHost('/local/image.png', 0, settings)).rejects.toThrow('connection lost');
    expect(customHttpRequest).toHaveBeenCalledOnce();
  });
});
