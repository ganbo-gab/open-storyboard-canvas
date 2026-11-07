import { beforeEach, expect, it, vi } from 'vitest';
import { useChannelStore } from '@/features/channels/store/channelStore';
import { miniMaxVideoProfile } from '@/features/channels/presets/videoModels';
import type * as ProviderGateway from '../../infrastructure/providerGateway';
import type { GenerateVideoPayload } from '../ports';

const mocks = vi.hoisted(() => ({ submit: vi.fn(), upload: vi.fn() }));
vi.mock('../../infrastructure/providerGateway', async (importOriginal) => ({
  ...await importOriginal<typeof ProviderGateway>(), submitCustomVideoJob: mocks.submit,
}));
vi.mock('../imageHosting', () => ({ uploadImageToConfiguredHost: mocks.upload }));
import { tauriAiGateway, buildGenerateVideoDebugPreview } from '../../infrastructure/tauriAiGateway';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.submit.mockResolvedValue('video-job');
  mocks.upload.mockResolvedValue('https://host.test/uploaded.png');
  useChannelStore.setState({ channels: [{ origin: 'native', profile: miniMaxVideoProfile, migrationIssues: [], createdAt: 1, updatedAt: 1 }] });
});
it('stops the retired video hosting route before upload or submission, including debug preview', async () => {
  const payload: GenerateVideoPayload = { model: 'custom:retired:video', prompt: 'Keep local reference local', size: '720P', referenceImages: ['/local/reference.png'],
    extraParams: { videoInputSchema: { images: { enabled: true, min: 0, max: 1, roles: ['reference'], requireImageHost: true } } } };
  await expect(tauriAiGateway.submitGenerateVideoJob(payload)).rejects.toMatchObject({ code: 'reference.needsPublicUrl', slotKind: 'image' });
  await expect(buildGenerateVideoDebugPreview(payload)).rejects.toMatchObject({ code: 'reference.needsPublicUrl' });
  expect(mocks.upload).not.toHaveBeenCalled();
  expect(mocks.submit).not.toHaveBeenCalled();
});
it('preserves existing public images on the retired video route without re-uploading', async () => {
  await tauriAiGateway.submitGenerateVideoJob({ model: 'custom:retired:video', prompt: 'Use existing media', size: '720P', referenceImages: ['https://old-host.example/existing.png'],
    extraParams: { videoInputSchema: { images: { enabled: true, min: 0, max: 1, roles: ['reference'], requireImageHost: true } } } });
  expect(mocks.upload).not.toHaveBeenCalled();
  expect(mocks.submit).toHaveBeenCalledWith(expect.objectContaining({ reference_images: ['https://old-host.example/existing.png'] }));
});
it('maps duration, resolution and ratio chips to typed selected-mode parameter keys in send and preview', async () => {
  const payload: GenerateVideoPayload = { model: 'custom:minimax-video:MiniMax-H3', prompt: 'A crane', channelModeId: 'text-to-video',
    seconds: 8, size: '2K', aspectRatio: '9:16', extraParams: { duration: 5, resolution: '768P', ratio: '16:9' } };
  const preview = await buildGenerateVideoDebugPreview(payload);
  await tauriAiGateway.submitGenerateVideoJob(payload);
  const request = mocks.submit.mock.calls[0][0];
  expect(request.extra_params).toMatchObject({ duration: 8, resolution: '2K', ratio: '9:16' });
  expect(request.extra_params).not.toHaveProperty('seconds');
  expect(preview.providerRequest?.body).toMatchObject({ duration: 8, resolution: '2K', ratio: '9:16' });
});
it('chooses an allowed object enum for correlated Hailuo duration and resolution chips', async () => {
  await tauriAiGateway.submitGenerateVideoJob({ model: 'custom:minimax-video:MiniMax-Hailuo-02', prompt: 'A crane', channelModeId: 'text-to-video',
    seconds: 10, size: '768P', aspectRatio: 'auto' });
  expect(mocks.submit.mock.calls[0][0].extra_params.output).toEqual({ duration: 10, resolution: '768P' });
});
it('does not submit an undeclared Hailuo output combination', async () => {
  await expect(tauriAiGateway.submitGenerateVideoJob({ model: 'custom:minimax-video:MiniMax-Hailuo-02', prompt: 'A crane', channelModeId: 'text-to-video',
    seconds: 10, size: '1080P' })).rejects.toThrow(/时长与分辨率|output/);
  expect(mocks.submit).not.toHaveBeenCalled();
});
it('preserves a selected object enum when unrelated legacy scalar fields do not describe an allowed output', async () => {
  await tauriAiGateway.submitGenerateVideoJob({ model: 'custom:minimax-video:MiniMax-Hailuo-02', prompt: 'A crane', channelModeId: 'text-to-video',
    seconds: 4, size: '1280x720', extraParams: { output: { duration: 6, resolution: '1080P' } } });
  expect(mocks.submit.mock.calls[0][0].extra_params.output).toEqual({ duration: 6, resolution: '1080P' });
});
it('uses the declared object default for a fresh Hailuo selection with hidden legacy scalar fallback fields', async () => {
  await tauriAiGateway.submitGenerateVideoJob({ model: 'custom:minimax-video:MiniMax-Hailuo-02', prompt: 'A crane', channelModeId: 'text-to-video',
    seconds: 4, size: '1280x720', aspectRatio: '16:9' });
  expect(mocks.submit.mock.calls[0][0]).toMatchObject({ size: '', aspect_ratio: '', extra_params: { output: { duration: 6, resolution: '768P' } } });
});
it('preserves native references without automatically uploading them to an image host', async () => {
  await tauriAiGateway.submitGenerateVideoJob({ model: 'custom:minimax-video:MiniMax-H3', prompt: 'A crane', channelModeId: 'first-frame',
    size: '768P', seconds: 5, aspectRatio: 'adaptive', referenceImages: ['/private.png'],
    extraParams: { videoInputSchema: { images: { enabled: true, min: 1, max: 1, requireImageHost: true } } } });
  expect(mocks.upload).not.toHaveBeenCalled();
  expect(mocks.submit.mock.calls[0][0].reference_images).toEqual(['/private.png']);
});
