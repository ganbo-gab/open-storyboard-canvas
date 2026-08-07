import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (path: string) => `asset://localhost${path}`,
  invoke: vi.fn(),
}));

vi.mock('@/commands/image', () => ({
  loadAudioSourceDataUrl: vi.fn(async (source: string) => source),
  persistVideoSource: vi.fn(async (source: string) => source),
}));

import { invoke } from '@tauri-apps/api/core';

import { useSettingsStore } from '@/stores/settingsStore';
import {
  clearDreaminaGatewayCacheForTests,
  getDreaminaJob,
  humanizeDreaminaFailReason,
  submitDreaminaJob,
  submitDreaminaVideoJob,
} from './dreaminaGateway';

const mockedInvoke = vi.mocked(invoke);

function acceptedResult(media: 'image' | 'video') {
  const field = media === 'image' ? 'image_url' : 'video_url';
  const extension = media === 'image' ? 'png' : 'mp4';
  return {
    ok: true,
    submitId: 'be6ad4e0-ecbd-4d70-8ace-5d0995c39832',
    genStatus: 'success',
    failReason: null,
    complianceRequired: false,
    stdout: JSON.stringify({
      submit_id: 'be6ad4e0-ecbd-4d70-8ace-5d0995c39832',
      gen_status: 'success',
      [field]: `https://cdn.example.test/result.${extension}`,
    }),
    stderr: '',
    error: null,
  };
}

describe('Dreamina gateway', () => {
  beforeEach(() => {
    mockedInvoke.mockReset();
    clearDreaminaGatewayCacheForTests();
    useSettingsStore.setState({ dreaminaDefaultSessionId: 42 });
  });

  it('submits a current image model once with the selected session', async () => {
    mockedInvoke.mockResolvedValueOnce(acceptedResult('image'));

    const jobId = await submitDreaminaJob({
      prompt: 'cinematic portrait',
      model: 'dreamina:5.0Pro',
      size: '4k',
      aspect_ratio: '3:4',
      extra_params: { resolutionType: '4k' },
    });

    expect(getDreaminaJob(jobId)).toMatchObject({
      status: 'succeeded',
      result: 'https://cdn.example.test/result.png',
    });
    expect(mockedInvoke).toHaveBeenCalledTimes(1);
    expect(mockedInvoke).toHaveBeenCalledWith('dreamina_text2image', expect.objectContaining({
      modelVersion: '5.0Pro',
      resolutionType: '4k',
      sessionId: 42,
    }));
  });

  it('blocks removed image combinations before staging or invoking the CLI', async () => {
    const jobId = await submitDreaminaJob({
      prompt: 'edit',
      model: 'dreamina:3.1',
      size: '2k',
      aspect_ratio: '16:9',
      reference_images: ['/tmp/reference.png'],
      extra_params: { resolutionType: '2k' },
    });

    expect(getDreaminaJob(jobId)).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('Unsupported Dreamina model'),
    });
    expect(mockedInvoke).not.toHaveBeenCalled();
  });

  it('never replays an ambiguous paid submit after EOF', async () => {
    mockedInvoke.mockResolvedValueOnce({
      ok: false,
      submitId: null,
      genStatus: null,
      failReason: 'get upload token: Post image_generate: EOF',
      complianceRequired: false,
      stdout: '',
      stderr: 'EOF',
      error: 'get upload token: Post image_generate: EOF',
    });

    const jobId = await submitDreaminaJob({
      prompt: 'frame',
      model: 'dreamina:5.0',
      size: '2k',
      aspect_ratio: '16:9',
      extra_params: { resolutionType: '2k' },
    });

    expect(mockedInvoke).toHaveBeenCalledTimes(1);
    expect(getDreaminaJob(jobId).error).toContain('没有自动重试');
  });

  it('surfaces the AIGC compliance action instead of a generic failure', async () => {
    mockedInvoke.mockResolvedValueOnce({
      ok: false,
      submitId: 'be6ad4e0-ecbd-4d70-8ace-5d0995c39832',
      genStatus: 'fail',
      failReason: 'AigcComplianceConfirmationRequired',
      complianceRequired: true,
      stdout: '',
      stderr: '',
      error: 'AigcComplianceConfirmationRequired',
    });

    const jobId = await submitDreaminaJob({
      prompt: 'frame',
      model: 'dreamina:5.0',
      size: '2k',
      aspect_ratio: '16:9',
      extra_params: { resolutionType: '2k' },
    });

    expect(getDreaminaJob(jobId).error).toContain('即梦网页版');
  });

  it('redacts local paths and OAuth material from generic visible failures', () => {
    const message = humanizeDreaminaFailReason(
      'upload /Users/alice/.dreamina/session.json failed: device_code=secret-code access_token:"secret-token"',
    );

    expect(message).toContain('[local path]');
    expect(message).toContain('device_code=[redacted]');
    expect(message).toContain('access_token=[redacted]');
    expect(message).not.toContain('/Users/alice');
    expect(message).not.toContain('secret-code');
    expect(message).not.toContain('secret-token');
  });

  it('supports Seedance 2.5 audio-only without truncating media limits', async () => {
    mockedInvoke
      .mockResolvedValueOnce('/tmp/reference.mp3')
      .mockResolvedValueOnce(acceptedResult('video'));

    const jobId = await submitDreaminaVideoJob({
      prompt: 'cut to the rhythm',
      model: 'dreamina:all-reference-video:seedance2.5',
      size: '720p',
      aspectRatio: '16:9',
      seconds: 30,
      referenceAudios: ['data:audio/mpeg;base64,AAAA'],
    });

    expect(getDreaminaJob(jobId).status).toBe('succeeded');
    expect(mockedInvoke).toHaveBeenLastCalledWith(
      'dreamina_multimodal2video',
      expect.objectContaining({
        audioPaths: ['/tmp/reference.mp3'],
        imagePaths: [],
        videoPaths: [],
        modelVersion: 'seedance2.5',
        sessionId: 42,
      }),
    );
  });

  it('requires explicit N-1 segments, then forwards them with resolution', async () => {
    const base = {
      prompt: 'unused shorthand',
      model: 'dreamina:multi-frame-video',
      size: '1080p',
      aspectRatio: 'auto',
      seconds: 6,
      referenceImages: ['/tmp/a.png', '/tmp/b.png', '/tmp/c.png'],
    };
    const invalidJobId = await submitDreaminaVideoJob(base);
    expect(getDreaminaJob(invalidJobId).error).toContain('exactly 2 transition segments');
    expect(mockedInvoke).not.toHaveBeenCalled();

    mockedInvoke.mockResolvedValueOnce(acceptedResult('video'));
    const validJobId = await submitDreaminaVideoJob({
      ...base,
      extraParams: {
        dreaminaTransitionSegments: [
          { prompt: 'walk from A to B', duration: 3 },
          { prompt: 'turn from B to C', duration: 3 },
        ],
      },
    });

    expect(getDreaminaJob(validJobId).status).toBe('succeeded');
    expect(mockedInvoke).toHaveBeenCalledWith(
      'dreamina_multiframe2video',
      expect.objectContaining({
        transitionPrompts: ['walk from A to B', 'turn from B to C'],
        transitionDurations: ['3', '3'],
        videoResolution: '1080p',
        sessionId: 42,
      }),
    );
  });
});
