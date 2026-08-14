import { beforeEach, describe, expect, it, vi } from 'vitest';

const generationJobs = vi.hoisted(() => new Map<string, Record<string, any>>());

vi.mock('@/commands/ai', () => ({
  createGenerationJob: vi.fn(async (request: Record<string, any>) => {
    const now = Date.now();
    const job = {
      job_id: request.jobId,
      status: request.status ?? 'queued',
      result: null,
      error: request.error ?? null,
      media_type: request.mediaType,
      provider_id: request.providerId,
      model_id: request.modelId ?? null,
      phase: request.phase ?? 'submit',
      external_task_id: request.externalTaskId ?? null,
      poll_descriptor: request.pollDescriptor ?? null,
      result_url: request.resultUrl ?? null,
      error_category: request.errorCategory ?? null,
      resumable: request.resumable ?? true,
      consecutive_network_errors: 0,
      created_at: now,
      updated_at: now,
    };
    generationJobs.set(job.job_id, job);
    return job;
  }),
  getGenerationJobRecord: vi.fn(async (jobId: string) => {
    const job = generationJobs.get(jobId);
    if (!job) throw new Error('job not found');
    return job;
  }),
  updateGenerationJob: vi.fn(async (request: Record<string, any>) => {
    const current = generationJobs.get(request.jobId);
    if (!current) throw new Error('job not found');
    const updated = {
      ...current,
      ...(request.status ? { status: request.status } : {}),
      ...(request.phase ? { phase: request.phase } : {}),
      ...(request.externalTaskId ? { external_task_id: request.externalTaskId } : {}),
      ...(request.pollDescriptor ? { poll_descriptor: request.pollDescriptor } : {}),
      ...(request.result ? { result: request.result } : {}),
      ...(request.resultUrl ? { result_url: request.resultUrl } : {}),
      ...(request.error !== undefined ? { error: request.error } : {}),
      ...(request.errorCategory !== undefined ? { error_category: request.errorCategory } : {}),
      ...(request.resumable !== undefined ? { resumable: request.resumable } : {}),
      ...(request.lastPollAt !== undefined ? { last_poll_at: request.lastPollAt } : {}),
      ...(request.consecutiveNetworkErrors !== undefined
        ? { consecutive_network_errors: request.consecutiveNetworkErrors }
        : {}),
      updated_at: Date.now(),
    };
    generationJobs.set(request.jobId, updated);
    return updated;
  }),
}));

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (path: string) => `asset://localhost${path}`,
  invoke: vi.fn(),
  isTauri: () => true,
}));

vi.mock('@/commands/image', () => ({
  loadAudioSourceDataUrl: vi.fn(async (source: string) => source),
  persistVideoSource: vi.fn(async (source: string) => source),
}));

import { invoke } from '@tauri-apps/api/core';
import { createGenerationJob, updateGenerationJob } from '@/commands/ai';

import { useSettingsStore } from '@/stores/settingsStore';
import {
  clearDreaminaGatewayCacheForTests,
  getDreaminaJob,
  humanizeDreaminaFailReason,
  retryDreaminaJob,
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
    generationJobs.clear();
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

    await expect(getDreaminaJob(jobId)).resolves.toMatchObject({
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

    await expect(getDreaminaJob(jobId)).resolves.toMatchObject({
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
    await expect(getDreaminaJob(jobId)).resolves.toMatchObject({ error: expect.stringContaining('没有自动重试') });
  });

  it('persists submit_id and keeps a temporarily missing task fetch-recoverable', async () => {
    const submitId = '0bc20659-4044-456d-9836-49efcff55fee';
    mockedInvoke.mockImplementation(async (command) => {
      if (command === 'dreamina_text2image') return {
        ok: true, submitId, genStatus: 'querying', failReason: null, complianceRequired: false,
        stdout: JSON.stringify({ submit_id: submitId, gen_status: 'querying' }), stderr: '', error: null,
      };
      if (command === 'dreamina_query_result') return {
        ok: false, submitId, genStatus: null, failReason: 'job not found', complianceRequired: false,
        stdout: '', stderr: 'job not found', error: 'job not found',
      };
      if (command === 'dreamina_list_task') return {
        ok: true, submitId: null, genStatus: null, failReason: null, complianceRequired: false,
        stdout: '[]', stderr: '', error: null,
      };
      throw new Error(`unexpected command ${command}`);
    });

    const jobId = await submitDreaminaJob({
      prompt: 'wide portrait', model: 'dreamina:5.0Pro', size: '2k', aspect_ratio: '21:9',
      extra_params: { resolutionType: '2k' },
    });
    const status = await getDreaminaJob(jobId);
    expect(status).toMatchObject({
      status: 'recoverable_wait', external_task_id: submitId, resumable: true,
      error_category: 'upstream-lookup-missing',
    });
    expect(mockedInvoke).toHaveBeenCalledWith('dreamina_query_result', expect.objectContaining({ submitId }));
    expect(mockedInvoke).toHaveBeenCalledWith('dreamina_list_task', { submitId });
  });

  it('does not downgrade a result found during fetch-only recovery', async () => {
    const submitId = 'a37a217e-8fc3-402e-a9d8-acde371190eb';
    mockedInvoke
      .mockResolvedValueOnce({
        ok: true, submitId, genStatus: 'querying', failReason: null, complianceRequired: false,
        stdout: JSON.stringify({ submit_id: submitId, gen_status: 'querying' }), stderr: '', error: null,
      })
      .mockResolvedValueOnce({ ...acceptedResult('image'), submitId });

    const jobId = await submitDreaminaJob({
      prompt: 'recover portrait', model: 'dreamina:5.0Pro', size: '2k', aspect_ratio: '16:9',
      extra_params: { resolutionType: '2k' },
    });

    await expect(retryDreaminaJob(jobId)).resolves.toBe(true);
    expect(generationJobs.get(jobId)).toMatchObject({
      status: 'succeeded',
      result: 'https://cdn.example.test/result.png',
    });
  });

  it('creates the durable local row before a paid submit and sends nothing if storage is unavailable', async () => {
    vi.mocked(createGenerationJob).mockRejectedValueOnce(new Error('database unavailable'));

    const jobId = await submitDreaminaJob({
      prompt: 'safe portrait', model: 'dreamina:5.0Pro', size: '2k', aspect_ratio: '16:9',
      extra_params: { resolutionType: '2k' },
    });

    expect(jobId).toMatch(/^dreamina-image-local-/);
    expect(mockedInvoke).not.toHaveBeenCalled();
    await expect(getDreaminaJob(jobId)).resolves.toMatchObject({
      status: 'failed',
      error: expect.stringContaining('未向即梦提交请求'),
    });
  });

  it('never exposes success until an accepted submit_id is durably persisted', async () => {
    vi.mocked(updateGenerationJob)
      .mockRejectedValueOnce(new Error('database busy'))
      .mockRejectedValueOnce(new Error('database still busy'));
    mockedInvoke.mockResolvedValueOnce(acceptedResult('image'));

    const jobId = await submitDreaminaJob({
      prompt: 'durable portrait', model: 'dreamina:5.0Pro', size: '2k', aspect_ratio: '16:9',
      extra_params: { resolutionType: '2k' },
    });

    expect(generationJobs.get(jobId)).toMatchObject({ status: 'submitting', external_task_id: null });
    await expect(getDreaminaJob(jobId)).resolves.toMatchObject({
      status: 'recoverable_wait',
      external_task_id: 'be6ad4e0-ecbd-4d70-8ace-5d0995c39832',
      result: null,
      error_category: 'local-persistence',
    });
    expect(mockedInvoke).toHaveBeenCalledTimes(1);
    expect(generationJobs.get(jobId)).toMatchObject({ status: 'submitting', external_task_id: null });

    await expect(getDreaminaJob(jobId)).resolves.toMatchObject({
      status: 'succeeded',
      external_task_id: 'be6ad4e0-ecbd-4d70-8ace-5d0995c39832',
      result: 'https://cdn.example.test/result.png',
    });
    expect(mockedInvoke).toHaveBeenCalledTimes(1);
    expect(generationJobs.get(jobId)).toMatchObject({
      status: 'succeeded',
      external_task_id: 'be6ad4e0-ecbd-4d70-8ace-5d0995c39832',
    });
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

    await expect(getDreaminaJob(jobId)).resolves.toMatchObject({ error: expect.stringContaining('即梦网页版') });
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

    await expect(getDreaminaJob(jobId)).resolves.toMatchObject({ status: 'succeeded' });
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
    await expect(getDreaminaJob(invalidJobId)).resolves.toMatchObject({ error: expect.stringContaining('exactly 2 transition segments') });
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

    await expect(getDreaminaJob(validJobId)).resolves.toMatchObject({ status: 'succeeded' });
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
