import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/features/channels/runtime/channelChat', () => ({ submitCustomChatCompletion: vi.fn() }));
vi.mock('@/features/canvas/application/chatModelCatalog', () => ({ buildChatModelCatalog: () => [{ id: 'configured-text', usable: true }] }));
vi.mock('@/features/channels/application/channelCatalog', () => ({ getChannelCatalogProviders: () => [] }));
import { submitCustomChatCompletion } from '@/features/channels/runtime/channelChat';
import { DEFAULT_IMAGE_HOST_SETTINGS } from './imageHostSettings';
import { applyImageHostSuggestion, imageHostAssistantDocument, suggestImageHostConfiguration, validateImageHostSuggestion } from './imageHostConfigurationAssistant';

const suggestion = { uploadUrl: 'https://uploads.example/upload', fileField: 'image', responseUrlPath: 'data.url', headerNames: ['Authorization'], explanation: '使用文档中的上传接口。' };
beforeEach(() => vi.clearAllMocks());

describe('image-host configuration assistant', () => {
  it('redacts pasted credentials, existing arbitrary header values and opaque references before one model request', async () => {
    const current = { ...DEFAULT_IMAGE_HOST_SETTINGS, extraHeaders: { 'X-Custom': 'EXISTING_PRIVATE_VALUE' } };
    vi.mocked(submitCustomChatCompletion).mockResolvedValue({ text: JSON.stringify(suggestion), raw: {} });
    const docs = 'POST https://uploads.example/upload?token=URL_PRIVATE -H "X-Key: OTHER_PRIVATE" Bearer BEARER_PRIVATE\nEXISTING_PRIVATE_VALUE __SC_SECRET_encoded__\nfile field image; response data.url';
    expect(await suggestImageHostConfiguration('configured-text', docs, current)).toEqual(suggestion);
    const sent = JSON.stringify(vi.mocked(submitCustomChatCompletion).mock.calls[0][1]);
    expect(sent).not.toMatch(/URL_PRIVATE|OTHER_PRIVATE|BEARER_PRIVATE|EXISTING_PRIVATE_VALUE|__SC_SECRET_/);
    expect(sent).toContain('data.url'); expect(submitCustomChatCompletion).toHaveBeenCalledOnce();
  });
  it('never retries invalid model output or automatically applies it', async () => {
    vi.mocked(submitCustomChatCompletion).mockResolvedValue({ text: '{"enabled":true,"extraHeaders":{"Authorization":"secret"}}', raw: {} });
    await expect(suggestImageHostConfiguration('configured-text', 'Public upload documentation', DEFAULT_IMAGE_HOST_SETTINGS)).rejects.toThrow();
    expect(submitCustomChatCompletion).toHaveBeenCalledOnce();
  });
  it('requires a configured model and bounded nonempty documentation before a call', async () => {
    await expect(suggestImageHostConfiguration('invented', 'docs', DEFAULT_IMAGE_HOST_SETTINGS)).rejects.toThrow(/文本模型/);
    await expect(suggestImageHostConfiguration('configured-text', '', DEFAULT_IMAGE_HOST_SETTINGS)).rejects.toThrow(/文档/);
    expect(() => imageHostAssistantDocument('a'.repeat(200001), DEFAULT_IMAGE_HOST_SETTINGS)).toThrow(/200KB/);
    expect(submitCustomChatCompletion).not.toHaveBeenCalled();
  });
  it('applies a disabled draft while preserving every existing header value and case', () => {
    const current = { ...DEFAULT_IMAGE_HOST_SETTINGS, enabled: true, extraHeaders: { authorization: 'UNCHANGED_PRIVATE', 'X-Other': 'KEEP_PRIVATE' } };
    expect(applyImageHostSuggestion(current, { ...suggestion, headerNames: ['Authorization', 'X-New'] })).toEqual({ ...current,
      enabled: false, uploadUrl: suggestion.uploadUrl, fileField: 'image', responseUrlPath: 'data.url',
      extraHeaders: { authorization: 'UNCHANGED_PRIVATE', 'X-Other': 'KEEP_PRIVATE', 'X-New': '' } });
    expect(current.enabled).toBe(true);
  });
  it.each([{ extraHeaders: { key: 'forbidden' } }, { enabled: true }, { uploadUrl: 'https://host.example/upload?token=private' },
    { uploadUrl: 'https://user:secret@host.example/upload' }, { headerNames: ['Content-Type'] }, { headerNames: ['Auth', 'auth'] },
    { responseUrlPath: 'data..url' }])('rejects unsafe or unsupported fields (%j)', (patch) => {
    expect(() => validateImageHostSuggestion({ ...suggestion, ...patch })).toThrow();
  });
});
