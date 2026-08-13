import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const {
  customHttpRequestMock,
  createGenerationJobMock,
  getGenerationJobRecordMock,
  persistVideoSourceMock,
  prepareNodeImageSourceWithHeadersMock,
  updateGenerationJobMock,
} = vi.hoisted(() => ({
  customHttpRequestMock: vi.fn(),
  createGenerationJobMock: vi.fn(),
  getGenerationJobRecordMock: vi.fn(),
  persistVideoSourceMock: vi.fn(),
  prepareNodeImageSourceWithHeadersMock: vi.fn(),
  updateGenerationJobMock: vi.fn(),
}));

vi.mock('@/commands/ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/commands/ai')>();
  return {
    ...actual,
    customHttpRequest: customHttpRequestMock,
    createGenerationJob: createGenerationJobMock,
    getGenerationJobRecord: getGenerationJobRecordMock,
    updateGenerationJob: updateGenerationJobMock,
  };
});

vi.mock('@/commands/image', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/commands/image')>();
  return {
    ...actual,
    persistVideoSource: persistVideoSourceMock,
    prepareNodeImageSourceWithHeaders: prepareNodeImageSourceWithHeadersMock,
  };
});

import { useCustomProvidersStore, type CustomProviderConfig } from '@/stores/customProvidersStore';
import {
  DEFAULT_GENERATION_NETWORK_SETTINGS,
  useSettingsStore,
} from '@/stores/settingsStore';
import {
  customImageProviderConfigToDraft,
  customImageProviderDraftToConfig,
} from '@/features/canvas/application/customImageProviderConfig';
import {
  buildCustomProviderRequestDebugPreview,
  classifyGenerationError,
  detectInlineImageAspectRatio,
  getCustomProviderJob,
  getCustomProviderJobAsync,
  recoverCustomProviderJob,
  summarizeMaterializedSourceForLog,
  submitCustomProviderJob,
  submitCustomVideoJob,
  verifyAgnesKey,
} from './customProviderGateway';

const storageValues = new Map<string, string>();

function provider(overrides: Partial<CustomProviderConfig> = {}): CustomProviderConfig {
  return {
    id: 'provider-1',
    label: 'Provider',
    baseUrl: 'https://example.com/v1',
    endpointPath: '/images/generations',
    httpMethod: 'POST',
    apiKey: 'secret',
    apiStyle: 'openai-compatible',
    models: ['gpt-image-2'],
    supportsWebSearch: false,
    responseFormat: 'openai-images',
    ...overrides,
  };
}

beforeAll(() => {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => storageValues.get(key) ?? null,
      setItem: (key: string, value: string) => storageValues.set(key, value),
      removeItem: (key: string) => storageValues.delete(key),
      clear: () => storageValues.clear(),
      key: (index: number) => Array.from(storageValues.keys())[index] ?? null,
      get length() { return storageValues.size; },
    } satisfies Storage,
  });
});

afterEach(() => {
  delete (globalThis as typeof globalThis & { isTauri?: boolean }).isTauri;
  useCustomProvidersStore.getState().replaceAll([]);
  useSettingsStore.getState().setGenerationNetworkSettings(DEFAULT_GENERATION_NETWORK_SETTINGS);
  useSettingsStore.getState().setAgnesApiKey('');
  storageValues.clear();
  customHttpRequestMock.mockReset();
  createGenerationJobMock.mockReset();
  createGenerationJobMock.mockResolvedValue(undefined);
  getGenerationJobRecordMock.mockReset();
  persistVideoSourceMock.mockReset();
  prepareNodeImageSourceWithHeadersMock.mockReset();
  updateGenerationJobMock.mockReset();
  updateGenerationJobMock.mockResolvedValue(undefined);
});

function imageEditRequest(providerId = 'provider-1', modelName = 'gpt-image-2') {
  return {
    prompt: 'edit this image',
    model: `custom:${providerId}:${modelName}`,
    size: '1024x1024',
    aspect_ratio: '1:1',
    reference_images: [`data:image/png;base64,${'a'.repeat(400)}`],
  };
}

function response(status: number, payload: unknown) {
  return Promise.resolve({ status, text: JSON.stringify(payload) });
}

async function waitForTerminalJob(jobId: string) {
  await vi.waitFor(() => {
    expect(['queued', 'submitting', 'running', 'recoverable_wait', 'materializing'])
      .not.toContain(getCustomProviderJob(jobId).status);
  });
  return getCustomProviderJob(jobId);
}

describe('custom provider submission safety', () => {
  it.each([
    ['proxy tunnel failed', 'proxy'],
    ['dns resolve failed', 'dns'],
    ['TLS certificate invalid', 'tls'],
    ['request timed out', 'timeout'],
    ['HTTP 429', 'http'],
    ['response JSON parse failed', 'response-parse'],
    ['download failed', 'download'],
  ])('classifies %s diagnostics', (message, category) => {
    expect(classifyGenerationError(new Error(message))).toBe(category);
  });

  it('does not replay an ambiguous video POST', async () => {
    useCustomProvidersStore.getState().replaceAll([provider({
      mediaType: 'video',
      endpointPath: '/videos',
      models: ['video-model'],
      extraParams: { requestBodyMode: 'json' },
    })]);
    customHttpRequestMock.mockRejectedValueOnce(new Error('connection reset while reading response'));

    const job = await waitForTerminalJob(await submitCustomVideoJob({
      prompt: 'animate',
      model: 'custom:provider-1:video-model',
      size: '1280x720',
      aspect_ratio: '16:9',
    }));

    expect(customHttpRequestMock).toHaveBeenCalledTimes(1);
    expect(job.status).toBe('unknown');
    expect(job.error).toContain('为避免重复计费未自动重试');
  });

  it('propagates the captured custom-proxy route into remote image materialization', async () => {
    useSettingsStore.getState().setGenerationNetworkSettings({
      route: 'custom-proxy',
      customProxyUrl: 'http://127.0.0.1:7890',
    });
    useCustomProvidersStore.getState().replaceAll([provider()]);
    customHttpRequestMock.mockImplementationOnce(() => response(200, {
      data: [{ url: 'https://example.com/v1/result.png?signature=private' }],
    }));
    prepareNodeImageSourceWithHeadersMock.mockResolvedValueOnce({
      imagePath: '/local/result.png',
      previewImagePath: '/local/result.preview.png',
      aspectRatio: '1:1',
    });

    const job = await waitForTerminalJob(await submitCustomProviderJob({
      prompt: 'draw',
      model: 'custom:provider-1:gpt-image-2',
      size: '1024x1024',
      aspect_ratio: '1:1',
    }));

    expect(job).toMatchObject({ status: 'succeeded', result: '/local/result.png' });
    expect(customHttpRequestMock).toHaveBeenCalledTimes(1);
    expect(prepareNodeImageSourceWithHeadersMock).toHaveBeenCalledWith(
      'https://example.com/v1/result.png?signature=private',
      expect.objectContaining({ Authorization: 'Bearer secret' }),
      512,
      {
        route: 'custom-proxy',
        customProxyUrl: 'http://127.0.0.1:7890',
        configuredProviderOrigin: 'https://example.com',
      },
    );
  });

  it('propagates the captured direct route into remote video materialization', async () => {
    useSettingsStore.getState().setGenerationNetworkSettings({ route: 'direct', customProxyUrl: '' });
    useCustomProvidersStore.getState().replaceAll([provider({
      mediaType: 'video',
      endpointPath: '/videos',
      models: ['video-model'],
      extraParams: { requestBodyMode: 'json' },
    })]);
    customHttpRequestMock.mockImplementationOnce(() => response(200, {
      video_url: 'https://cdn.example/video.mp4',
    }));
    persistVideoSourceMock.mockResolvedValueOnce('/local/video.mp4');

    const job = await waitForTerminalJob(await submitCustomVideoJob({
      prompt: 'animate',
      model: 'custom:provider-1:video-model',
      size: '1280x720',
      aspect_ratio: '16:9',
    }));

    expect(job).toMatchObject({ status: 'succeeded', result: '/local/video.mp4' });
    expect(customHttpRequestMock).toHaveBeenCalledTimes(1);
    expect(persistVideoSourceMock).toHaveBeenCalledWith(
      'https://cdn.example/video.mp4',
      undefined,
      { route: 'direct', configuredProviderOrigin: 'https://example.com' },
    );
  });

  it('forwards query authentication only to a same-origin video result', async () => {
    useCustomProvidersStore.getState().replaceAll([provider({
      mediaType: 'video',
      endpointPath: '/videos',
      models: ['video-model'],
      extraParams: {
        requestBodyMode: 'json',
        auth: { mode: 'query', name: 'access_token' },
      },
    })]);
    customHttpRequestMock.mockImplementationOnce(() => response(200, {
      video_url: 'https://example.com/v1/video.mp4?download=1',
    }));
    persistVideoSourceMock.mockResolvedValueOnce('/local/video.mp4');

    const sameOriginJob = await waitForTerminalJob(await submitCustomVideoJob({
      prompt: 'animate',
      model: 'custom:provider-1:video-model',
      size: '1280x720',
      aspect_ratio: '16:9',
    }));

    expect(sameOriginJob.status).toBe('succeeded');
    expect(persistVideoSourceMock).toHaveBeenLastCalledWith(
      'https://example.com/v1/video.mp4?download=1&access_token=secret',
      {},
      { route: 'system', configuredProviderOrigin: 'https://example.com' },
    );

    customHttpRequestMock.mockImplementationOnce(() => response(200, {
      video_url: 'https://cdn.example/video.mp4?download=1',
    }));
    persistVideoSourceMock.mockResolvedValueOnce('/local/cdn-video.mp4');
    const crossOriginJob = await waitForTerminalJob(await submitCustomVideoJob({
      prompt: 'animate again',
      model: 'custom:provider-1:video-model',
      size: '1280x720',
      aspect_ratio: '16:9',
    }));

    expect(crossOriginJob.status).toBe('succeeded');
    expect(persistVideoSourceMock).toHaveBeenLastCalledWith(
      'https://cdn.example/video.mp4?download=1',
      undefined,
      { route: 'system', configuredProviderOrigin: 'https://example.com' },
    );
  });

  it.each(['image', 'video'] as const)(
    'blocks a paid %s submission when the desktop job record cannot be created',
    async (mediaType) => {
      (globalThis as typeof globalThis & { isTauri?: boolean }).isTauri = true;
      useCustomProvidersStore.getState().replaceAll([provider({
        mediaType,
        endpointPath: mediaType === 'video' ? '/videos' : '/images/generations',
        models: [mediaType === 'video' ? 'video-model' : 'gpt-image-2'],
        extraParams: { requestBodyMode: 'json' },
      })]);
      createGenerationJobMock.mockRejectedValueOnce(new Error('database is locked'));

      const jobId = mediaType === 'video'
        ? await submitCustomVideoJob({
            prompt: 'animate',
            model: 'custom:provider-1:video-model',
            size: '1280x720',
            aspect_ratio: '16:9',
          })
        : await submitCustomProviderJob({
            prompt: 'draw',
            model: 'custom:provider-1:gpt-image-2',
            size: '1024x1024',
            aspect_ratio: '1:1',
          });
      const job = await waitForTerminalJob(jobId);

      expect(job.status).toBe('failed');
      expect(job.error_category).toBe('storage');
      expect(job.error).toContain('生成请求未发送');
      expect(customHttpRequestMock).not.toHaveBeenCalled();
      expect(updateGenerationJobMock).not.toHaveBeenCalled();
    },
  );

  it('resumes a persisted image task by polling its external task id', async () => {
    (globalThis as typeof globalThis & { isTauri?: boolean }).isTauri = true;
    useCustomProvidersStore.getState().replaceAll([provider({
      extraParams: {
        asyncTask: {
          resultEndpointPath: '/jobs/{taskId}',
          resultMethod: 'GET',
          imagePath: 'output',
          statusPath: 'status',
          successValues: ['succeeded'],
          intervalMs: 500,
          timeoutMs: 5000,
        },
      },
    })]);
    getGenerationJobRecordMock.mockResolvedValueOnce({
      job_id: 'custom-local-restored-image',
      status: 'running',
      result: null,
      error: null,
      media_type: 'image',
      provider_id: 'provider-1',
      model_id: 'gpt-image-2',
      external_task_id: 'task-restored-1',
      network_route: 'system',
    });
    customHttpRequestMock.mockImplementationOnce(() => response(200, {
      status: 'succeeded',
      output: 'a'.repeat(400),
    }));

    const initial = await getCustomProviderJobAsync('custom-local-restored-image');
    expect(initial.status).toBe('running');
    const job = await waitForTerminalJob('custom-local-restored-image');

    expect(job.status).toBe('succeeded');
    expect(customHttpRequestMock).toHaveBeenCalledTimes(1);
    expect(customHttpRequestMock.mock.calls[0][0].url).toContain('/jobs/task-restored-1');
    expect(updateGenerationJobMock).toHaveBeenCalledWith(expect.objectContaining({
      jobId: 'custom-local-restored-image',
      status: 'succeeded',
    }));
  });

  it('recovers an Agnes materialize-only job from the dedicated saved key', async () => {
    (globalThis as typeof globalThis & { isTauri?: boolean }).isTauri = true;
    useSettingsStore.getState().setAgnesApiKey('agnes-secret');
    useSettingsStore.getState().setGenerationNetworkSettings({
      route: 'custom-proxy',
      customProxyUrl: 'http://127.0.0.1:7890',
    });
    getGenerationJobRecordMock.mockResolvedValueOnce({
      job_id: 'agnes-restored-image',
      status: 'recoverable_wait',
      result: null,
      result_url: 'https://apihub.agnes-ai.com/v1/results/image.png',
      error: 'previous materialize failed',
      media_type: 'image',
      provider_id: 'agnes',
      model_id: 'agnes-image-2.1-flash',
      network_route: 'custom-proxy',
    });
    prepareNodeImageSourceWithHeadersMock.mockResolvedValueOnce({
      imagePath: '/local/agnes.png',
      previewImagePath: '/local/agnes.preview.png',
      aspectRatio: '1:1',
    });

    const job = await recoverCustomProviderJob('agnes-restored-image');

    expect(job).toMatchObject({ status: 'succeeded', result: '/local/agnes.png' });
    expect(customHttpRequestMock).not.toHaveBeenCalled();
    expect(prepareNodeImageSourceWithHeadersMock).toHaveBeenCalledWith(
      'https://apihub.agnes-ai.com/v1/results/image.png',
      { Authorization: 'Bearer agnes-secret' },
      512,
      {
        route: 'custom-proxy',
        customProxyUrl: 'http://127.0.0.1:7890',
        configuredProviderOrigin: 'https://apihub.agnes-ai.com',
      },
    );
  });

  it('deduplicates concurrent fetch-only recovery and sends no generation POST', async () => {
    (globalThis as typeof globalThis & { isTauri?: boolean }).isTauri = true;
    useCustomProvidersStore.getState().replaceAll([provider()]);
    getGenerationJobRecordMock.mockResolvedValue({
      job_id: 'custom-local-deduplicated-recovery',
      status: 'recoverable_wait',
      result: null,
      result_url: 'https://example.com/results/existing.png',
      error: 'previous download failed',
      media_type: 'image',
      provider_id: 'provider-1',
      model_id: 'gpt-image-2',
      network_route: 'system',
      resumable: true,
    });
    prepareNodeImageSourceWithHeadersMock.mockResolvedValue({
      imagePath: '/local/deduplicated.png',
      previewImagePath: '/local/deduplicated.preview.png',
      aspectRatio: '1:1',
    });

    const [left, right] = await Promise.all([
      recoverCustomProviderJob('custom-local-deduplicated-recovery'),
      recoverCustomProviderJob('custom-local-deduplicated-recovery'),
    ]);

    expect(left).toMatchObject({ status: 'succeeded', result: '/local/deduplicated.png' });
    expect(right).toEqual(left);
    expect(getGenerationJobRecordMock).toHaveBeenCalledTimes(1);
    expect(prepareNodeImageSourceWithHeadersMock).toHaveBeenCalledTimes(1);
    expect(customHttpRequestMock).not.toHaveBeenCalled();
  });

  it('rejects an unknown outcome without a safe handle and performs no network request', async () => {
    (globalThis as typeof globalThis & { isTauri?: boolean }).isTauri = true;
    getGenerationJobRecordMock.mockResolvedValueOnce({
      job_id: 'custom-local-unknown-without-handle',
      status: 'unknown',
      result: null,
      media_type: 'image',
      provider_id: 'provider-1',
      model_id: 'gpt-image-2',
      network_route: 'system',
      resumable: false,
    });

    await expect(recoverCustomProviderJob('custom-local-unknown-without-handle'))
      .rejects.toThrow('没有可安全恢复');
    expect(customHttpRequestMock).not.toHaveBeenCalled();
    expect(prepareNodeImageSourceWithHeadersMock).not.toHaveBeenCalled();
  });

  it('does not publish recovered success before critical state is persisted', async () => {
    (globalThis as typeof globalThis & { isTauri?: boolean }).isTauri = true;
    useCustomProvidersStore.getState().replaceAll([provider({
      extraParams: {
        asyncTask: {
          resultEndpointPath: '/jobs/{taskId}',
          resultMethod: 'GET',
          imagePath: 'output',
          statusPath: 'status',
          successValues: ['succeeded'],
          intervalMs: 500,
          timeoutMs: 5000,
        },
      },
    })]);
    getGenerationJobRecordMock.mockResolvedValueOnce({
      job_id: 'custom-local-persist-before-success',
      status: 'running',
      result: null,
      error: null,
      media_type: 'image',
      provider_id: 'provider-1',
      model_id: 'gpt-image-2',
      external_task_id: 'task-persist-first',
      network_route: 'system',
    });
    customHttpRequestMock.mockImplementationOnce(() => response(200, {
      status: 'succeeded',
      output: 'a'.repeat(400),
    }));
    let releaseMaterializing!: () => void;
    updateGenerationJobMock
      .mockImplementationOnce(() => new Promise<void>((resolve) => {
        releaseMaterializing = resolve;
      }))
      .mockResolvedValue(undefined);

    await getCustomProviderJobAsync('custom-local-persist-before-success');
    await vi.waitFor(() => {
      expect(updateGenerationJobMock).toHaveBeenCalledWith(expect.objectContaining({
        status: 'materializing',
      }));
    });
    expect(getCustomProviderJob('custom-local-persist-before-success').status).toBe('running');

    releaseMaterializing();
    const job = await waitForTerminalJob('custom-local-persist-before-success');
    expect(job.status).toBe('succeeded');
    expect(updateGenerationJobMock).toHaveBeenLastCalledWith(expect.objectContaining({
      status: 'succeeded',
    }));
  });

  it('converts an interrupted submitting job to unknown without replaying POST', async () => {
    (globalThis as typeof globalThis & { isTauri?: boolean }).isTauri = true;
    getGenerationJobRecordMock.mockResolvedValueOnce({
      job_id: 'custom-local-interrupted-submit',
      status: 'submitting',
      result: null,
      error: null,
      media_type: 'image',
      provider_id: 'provider-1',
      model_id: 'gpt-image-2',
      network_route: 'system',
    });

    await getCustomProviderJobAsync('custom-local-interrupted-submit');
    const job = await waitForTerminalJob('custom-local-interrupted-submit');

    expect(job.status).toBe('unknown');
    expect(customHttpRequestMock).not.toHaveBeenCalled();
    expect(updateGenerationJobMock).toHaveBeenCalledWith(expect.objectContaining({
      status: 'unknown',
      errorCategory: 'submission-unknown',
    }));
  });

  it('keeps the submitted network route for polling when settings change mid-job', async () => {
    useSettingsStore.getState().setGenerationNetworkSettings({
      ...DEFAULT_GENERATION_NETWORK_SETTINGS,
      route: 'system',
    });
    useCustomProvidersStore.getState().replaceAll([provider({
      extraParams: {
        asyncTask: {
          resultEndpointPath: '/jobs/{taskId}',
          resultMethod: 'GET',
          imagePath: 'output',
          statusPath: 'status',
          successValues: ['succeeded'],
          intervalMs: 500,
          timeoutMs: 5000,
        },
      },
    })]);
    customHttpRequestMock
      .mockImplementationOnce(() => {
        useSettingsStore.getState().setGenerationNetworkSettings({
          ...DEFAULT_GENERATION_NETWORK_SETTINGS,
          route: 'direct',
        });
        return response(200, { id: 'task-route-1' });
      })
      .mockImplementationOnce(() => response(200, {
        status: 'succeeded',
        output: 'a'.repeat(400),
      }));

    const job = await waitForTerminalJob(await submitCustomProviderJob({
      prompt: 'draw',
      model: 'custom:provider-1:gpt-image-2',
      size: '1024x1024',
      aspect_ratio: '1:1',
    }));

    expect(job.status).toBe('succeeded');
    expect(customHttpRequestMock).toHaveBeenCalledTimes(2);
    expect(customHttpRequestMock.mock.calls[0][0].networkRoute).toBe('system');
    expect(customHttpRequestMock.mock.calls[1][0].networkRoute).toBe('system');
  });
});

describe('custom provider image request contracts', () => {
  it.each(['1K', '2K', '3K', '4K'])(
    'keeps Agnes Image 2.1 symbolic %s and sends ratio at the top level',
    (tier) => {
      useSettingsStore.getState().setAgnesApiKey('agnes-secret');
      const preview = buildCustomProviderRequestDebugPreview({
        prompt: 'wide establishing shot',
        model: 'agnes:image:agnes-image-2.1-flash',
        size: tier,
        aspect_ratio: '16:9',
        extra_params: { resolutionType: tier },
      });

      expect(preview.body).toEqual(expect.objectContaining({
        model: 'agnes-image-2.1-flash',
        prompt: 'wide establishing shot',
        size: tier,
        ratio: '16:9',
        n: 1,
        return_base64: true,
      }));
    },
  );

  it('keeps Agnes Image 2.1 explicit legacy pixels and documented reference shape', () => {
    useSettingsStore.getState().setAgnesApiKey('agnes-secret');
    const reference = `data:image/png;base64,${'a'.repeat(400)}`;
    const preview = buildCustomProviderRequestDebugPreview({
      prompt: 'preserve identity',
      model: 'agnes:image:agnes-image-2.1-flash',
      size: '2048x1152',
      aspect_ratio: '16:9',
      reference_images: [reference],
    });

    expect(preview.body).toEqual(expect.objectContaining({
      model: 'agnes-image-2.1-flash',
      size: '2048x1152',
      ratio: '16:9',
      extra_body: {
        image: [expect.stringMatching(/^data:image\/png;base64,\[base64 \d+ chars\]$/)],
        response_format: 'b64_json',
      },
    }));
    expect(JSON.stringify(preview)).not.toContain('agnes-secret');
    expect(JSON.stringify(preview)).not.toContain('aaaa');
  });

  it('sends an API key through a configured custom header without Bearer auth', async () => {
    useCustomProvidersStore.getState().replaceAll([provider({
      extraParams: { auth: { mode: 'header', name: 'X-API-Key', prefix: 'Token' } },
    })]);
    customHttpRequestMock.mockImplementationOnce(() => response(200, {
      data: [{ b64_json: 'a'.repeat(400) }],
    }));

    const job = await waitForTerminalJob(await submitCustomProviderJob({
      prompt: 'draw',
      model: 'custom:provider-1:gpt-image-2',
      size: '1024x1024',
      aspect_ratio: '1:1',
    }));

    expect(job.status).toBe('succeeded');
    expect(customHttpRequestMock.mock.calls[0][0].headers).toMatchObject({
      'X-API-Key': 'Token secret',
    });
    expect(customHttpRequestMock.mock.calls[0][0].headers.Authorization).toBeUndefined();
  });

  it('sends an API key through a configured query parameter', async () => {
    useCustomProvidersStore.getState().replaceAll([provider({
      extraParams: { auth: { mode: 'query', name: 'api_key' } },
    })]);
    customHttpRequestMock.mockImplementationOnce(() => response(200, {
      data: [{ b64_json: 'a'.repeat(400) }],
    }));

    const job = await waitForTerminalJob(await submitCustomProviderJob({
      prompt: 'draw',
      model: 'custom:provider-1:gpt-image-2',
      size: '1024x1024',
      aspect_ratio: '1:1',
    }));

    expect(job.status).toBe('succeeded');
    expect(customHttpRequestMock.mock.calls[0][0].url).toContain('api_key=secret');
    expect(customHttpRequestMock.mock.calls[0][0].headers.Authorization).toBeUndefined();
  });

  it('allows a no-auth custom provider to submit without a placeholder API key', async () => {
    useCustomProvidersStore.getState().replaceAll([provider({
      apiKey: '',
      extraParams: { auth: { mode: 'none' } },
    })]);
    customHttpRequestMock.mockImplementationOnce(() => response(200, {
      data: [{ b64_json: 'a'.repeat(400) }],
    }));

    const job = await waitForTerminalJob(await submitCustomProviderJob({
      prompt: 'draw',
      model: 'custom:provider-1:gpt-image-2',
      size: '1024x1024',
      aspect_ratio: '1:1',
    }));

    expect(job.status).toBe('succeeded');
    expect(customHttpRequestMock.mock.calls[0][0].headers.Authorization).toBeUndefined();
  });

  it('blocks a signed-proxy config even when its declarative variant says JSON', async () => {
    useCustomProvidersStore.getState().replaceAll([provider({
      extraParams: {
        transport: 'signed',
        needsProxy: true,
        signedAuth: { required: true },
        imageRequestContract: {
          version: 1,
          textToImage: {
            endpointPath: '/generate',
            bodyMode: 'json',
            bodyTemplate: { model: '{{model}}', prompt: '{{prompt}}' },
          },
        },
      },
    })]);

    const job = await waitForTerminalJob(await submitCustomProviderJob({
      prompt: 'draw',
      model: 'custom:provider-1:gpt-image-2',
      size: '1024x1024',
      aspect_ratio: '1:1',
    }));

    expect(job.status).toBe('failed');
    expect(job.error).toContain('签名鉴权/代理路线');
    expect(customHttpRequestMock).not.toHaveBeenCalled();
  });

  it('rejects an empty compound upstream model before composing a request', () => {
    useCustomProvidersStore.getState().replaceAll([provider()]);
    expect(() => buildCustomProviderRequestDebugPreview({
      prompt: 'draw',
      model: 'custom:provider-1:   ',
      size: '1024x1024',
      aspect_ratio: 'auto',
    })).toThrow('未找到对应的自定义服务商配置');
  });

  it('prevents legacy defaults and node extras from replacing canonical fields', () => {
    useCustomProvidersStore.getState().replaceAll([provider({
      extraParams: {
        defaultRequestParams: {
          model: '',
          prompt: 'wrong default prompt',
          size: '1x1',
        },
      },
    })]);
    const preview = buildCustomProviderRequestDebugPreview({
      prompt: 'real prompt',
      model: 'custom:provider-1:gpt-image-2',
      size: '2048x2048',
      aspect_ratio: 'auto',
      extra_params: {
        model: '',
        prompt: 'wrong node prompt',
        size: '1x1',
        resolutionType: '2048x2048',
      },
    });

    expect(preview.body).toEqual(expect.objectContaining({
      model: 'gpt-image-2',
      prompt: 'real prompt',
      size: '2048x2048',
    }));
  });

  it('uses one constrained geometry result for modern 3:4 4K preview and submission', async () => {
    useCustomProvidersStore.getState().replaceAll([provider({
      supportedResolutions: ['1K', '2K', '4K'],
      extraParams: {
        providerConfigVersion: 'new-v1',
        providerKind: 'openai-images',
        requestComposer: 'modern',
      },
    })]);
    const request = {
      prompt: 'portrait poster',
      model: 'custom:provider-1:gpt-image-2',
      size: '4K',
      aspect_ratio: '3:4',
      extra_params: { resolutionType: '4K' },
    };

    const preview = buildCustomProviderRequestDebugPreview(request);
    const previewBody = preview.body as Record<string, unknown>;
    const size = String(previewBody.size);
    const [width, height] = size.split('x').map(Number);

    expect(width).toBeLessThan(height);
    expect(width * height).toBeLessThanOrEqual(8_294_400);
    expect(size).not.toBe('2880x3840');
    expect(preview.imageOutputDiagnostic).toMatchObject({
      kind: 'image-output-geometry',
      source: 'tier-derived',
      resolvedSize: size,
      limits: { maxPixels: 8_294_400, alignment: 8 },
    });

    customHttpRequestMock.mockImplementationOnce(() => response(200, {
      data: [{ b64_json: 'a'.repeat(400) }],
    }));
    const job = await waitForTerminalJob(await submitCustomProviderJob(request));

    expect(job.status).toBe('succeeded');
    expect(customHttpRequestMock).toHaveBeenCalledTimes(1);
    expect(customHttpRequestMock.mock.calls[0][0].body).toEqual(expect.objectContaining({ size }));
  });

  it('rejects an explicit modern pixel size over the default limit before HTTP', async () => {
    useCustomProvidersStore.getState().replaceAll([provider({
      supportedResolutions: ['2880x3840'],
      extraParams: {
        providerConfigVersion: 'new-v1',
        providerKind: 'openai-images',
        requestComposer: 'modern',
      },
    })]);
    const request = {
      prompt: 'portrait poster',
      model: 'custom:provider-1:gpt-image-2',
      size: '2880x3840',
      aspect_ratio: '3:4',
    };

    expect(() => buildCustomProviderRequestDebugPreview(request)).toThrow(/2880x3840.*8,294,400/);
    const job = await waitForTerminalJob(await submitCustomProviderJob(request));
    expect(job.status).toBe('failed');
    expect(job.error).toContain('imageOutputLimits');
    expect(customHttpRequestMock).not.toHaveBeenCalled();
  });

  it('honors a configured modern pixel-limit override without rewriting an explicit size', () => {
    useCustomProvidersStore.getState().replaceAll([provider({
      supportedResolutions: ['2880x3840'],
      extraParams: {
        providerConfigVersion: 'new-v1',
        providerKind: 'openai-images',
        requestComposer: 'modern',
        imageOutputLimits: { maxPixels: 12_000_000, alignment: 16 },
      },
    })]);

    const preview = buildCustomProviderRequestDebugPreview({
      prompt: 'portrait poster',
      model: 'custom:provider-1:gpt-image-2',
      size: '2880x3840',
      aspect_ratio: '3:4',
    });

    expect(preview.body).toEqual(expect.objectContaining({ size: '2880x3840' }));
    expect(preview.imageOutputDiagnostic).toMatchObject({
      status: 'valid',
      source: 'explicit-pixel-size',
      resolvedSize: '2880x3840',
      limits: { maxPixels: 12_000_000, alignment: 16 },
    });
  });

  it('rejects an oversized declarative ratio mapping before JSON or multipart composition', () => {
    useCustomProvidersStore.getState().replaceAll([provider({
      extraParams: {
        imageOutputLimits: { maxPixels: 8_294_400 },
        imageRequestContract: {
          version: 1,
          textToImage: {
            bodyMode: 'json',
            bodyTemplate: { model: '{{model}}', prompt: '{{prompt}}', size: '{{size}}' },
          },
          ratioMappings: {
            '3:4': { size: '2880x3840' },
          },
        },
      },
    })]);

    expect(() => buildCustomProviderRequestDebugPreview({
      prompt: 'portrait poster',
      model: 'custom:provider-1:gpt-image-2',
      size: '4K',
      aspect_ratio: '3:4',
    })).toThrow(/2880x3840.*8,294,400/);
    expect(customHttpRequestMock).not.toHaveBeenCalled();
  });

  it('keeps a real model binding in legacy multipart even when modelField is blank', () => {
    useCustomProvidersStore.getState().replaceAll([provider({
      endpointPath: '/images/edits',
      extraParams: {
        requestBodyMode: 'multipart',
        requestBodyHints: { modelField: '', referenceImageField: 'image' },
        multipart: { enabled: true, fileField: 'image' },
      },
    })]);
    const preview = buildCustomProviderRequestDebugPreview({
      prompt: 'edit',
      model: 'custom:provider-1:gpt-image-2',
      size: '1024x1024',
      aspect_ratio: '1:1',
      reference_images: [`data:image/png;base64,${'a'.repeat(400)}`],
    });

    expect(preview.multipart).toEqual(expect.objectContaining({
      fields: expect.arrayContaining([
        expect.objectContaining({ name: 'model', value: 'gpt-image-2' }),
      ]),
    }));
  });

  it('restores a configured nested legacy model field after empty overrides', () => {
    useCustomProvidersStore.getState().replaceAll([provider({
      endpointPath: '/images/edits',
      extraParams: {
        requestBodyMode: 'multipart',
        defaultRequestParams: { input: { model_name: '' } },
        requestBodyHints: { modelField: 'input.model_name', referenceImageField: 'image' },
        multipart: { enabled: true, fileField: 'image' },
      },
    })]);
    const preview = buildCustomProviderRequestDebugPreview({
      prompt: 'edit',
      model: 'custom:provider-1:gpt-image-2',
      size: '1024x1024',
      aspect_ratio: '1:1',
      reference_images: [`data:image/png;base64,${'a'.repeat(400)}`],
    });

    expect(preview.multipart).toEqual(expect.objectContaining({
      fields: expect.arrayContaining([
        expect.objectContaining({ name: 'input.model_name', value: 'gpt-image-2' }),
      ]),
    }));
  });

  it('compiles a declarative JSON template with provider-specific ratio fields', () => {
    useCustomProvidersStore.getState().replaceAll([provider({
      extraParams: {
        imageRequestContract: {
          version: 1,
          textToImage: {
            endpointPath: '/custom/generate',
            method: 'POST',
            bodyMode: 'json',
            query: { channel: '{{extra.channel}}' },
            bodyTemplate: {
              model_name: '{{model}}',
              input: { text: '{{prompt}}' },
            },
            responseImagePaths: ['payload.assets[0].src'],
          },
          ratioMappings: {
            '16:9': {
              ratio: 'landscape',
              size: '3840x2160',
              fields: {
                'input.aspectRatio': '{{aspectRatio}}',
                'input.output.size': '{{size}}',
              },
            },
          },
        },
      },
    })]);

    const preview = buildCustomProviderRequestDebugPreview({
      prompt: 'wide landscape',
      model: 'custom:provider-1:gpt-image-2',
      size: '2K',
      aspect_ratio: '16:9',
      extra_params: { channel: 'web' },
    });

    expect(preview.url).toContain('/custom/generate?channel=%5Bredacted%5D');
    expect(preview.body).toEqual({
      model_name: 'gpt-image-2',
      input: {
        text: 'wide landscape',
        aspectRatio: 'landscape',
        output: { size: '3840x2160' },
      },
    });
  });

  it('supports explicit multipart repeat and array file field modes', () => {
    const references = [
      `data:image/png;base64,${'a'.repeat(400)}`,
      `data:image/png;base64,${'b'.repeat(400)}`,
    ];
    useCustomProvidersStore.getState().replaceAll([provider({
      endpointPath: '/legacy',
      extraParams: {
        imageRequestContract: {
          version: 1,
          imageToImage: {
            endpointPath: '/custom/edit',
            bodyMode: 'multipart',
            bodyTemplate: { prompt: '{{prompt}}', model: '{{model}}' },
            imageFields: [
              { name: 'image', mode: 'repeat', encoding: 'base64' },
              { name: 'mask', mode: 'array', encoding: 'data-url' },
            ],
          },
        },
      },
    })]);

    const preview = buildCustomProviderRequestDebugPreview({
      ...imageEditRequest(),
      reference_images: references,
    });
    const multipart = preview.multipart as {
      fields: Array<{ name: string; value: string }>;
      files: Array<{ name: string; base64?: string; dataUrl?: string }>;
    };

    expect(preview.url).toContain('/custom/edit');
    expect(multipart.files.map((file) => file.name)).toEqual([
      'image',
      'image',
      'mask[]',
      'mask[]',
    ]);
    expect(multipart.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'prompt', value: 'edit this image' }),
      expect.objectContaining({ name: 'model', value: 'gpt-image-2' }),
    ]));
  });

  it('keeps a declared generations endpoint for image-to-image instead of forcing images edits', () => {
    useCustomProvidersStore.getState().replaceAll([provider({
      endpointPath: '/legacy',
      extraParams: {
        imageRequestContract: {
          version: 1,
          textToImage: {
            endpointPath: '/images/generations',
            bodyMode: 'json',
            bodyTemplate: { model: '{{model}}', prompt: '{{prompt}}' },
          },
          imageToImage: {
            endpointPath: '/images/generations',
            bodyMode: 'multipart',
            bodyTemplate: { model: '{{model}}', prompt: '{{prompt}}' },
            imageFields: [{ name: 'image', mode: 'repeat', encoding: 'base64' }],
          },
        },
      },
    })]);

    const preview = buildCustomProviderRequestDebugPreview(imageEditRequest());
    const multipart = preview.multipart as {
      fields: Array<{ name: string; value: string }>;
      files: Array<{ name: string }>;
    };

    expect(preview.url).toContain('/images/generations');
    expect(preview.url).not.toContain('/images/edits');
    expect(multipart.files.map((file) => file.name)).toEqual(['image']);
    expect(multipart.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'model', value: 'gpt-image-2' }),
      expect.objectContaining({ name: 'prompt', value: 'edit this image' }),
    ]));
  });

  it('keeps form-urlencoded image arrays as repeated form values', () => {
    useCustomProvidersStore.getState().replaceAll([provider({
      extraParams: {
        imageRequestContract: {
          version: 1,
          imageToImage: {
            endpointPath: '/custom/form-edit',
            bodyMode: 'form-urlencoded',
            bodyTemplate: { model: '{{model}}', prompt: '{{prompt}}' },
            imageFields: [{ name: 'image', mode: 'repeat', encoding: 'url' }],
          },
        },
      },
    })]);

    const preview = buildCustomProviderRequestDebugPreview({
      ...imageEditRequest(),
      reference_images: ['https://img.example.com/a.png', 'https://img.example.com/b.png'],
    });

    expect(preview.body).toEqual({
      model: 'gpt-image-2',
      prompt: 'edit this image',
      image: ['https://img.example.com/a.png', 'https://img.example.com/b.png'],
    });
    expect(preview.bodyMode).toBe('form-urlencoded');
  });

  it('executes legacy nested requestBodyHints after reopening and saving a provider', () => {
    const legacy = provider({
      apiStyle: 'generic-json',
      endpointPath: '/generate',
      responseFormat: 'generic',
      extraParams: {
        requestBodyMode: 'form-urlencoded',
        requestBodyHints: {
          modelField: 'input.model',
          promptField: 'input.prompt',
          ratioField: 'input.aspect_ratio',
          sizeField: 'input.size',
          referenceImageField: 'input.images',
        },
      },
    });
    const reopened = customImageProviderConfigToDraft(legacy);
    const saved = customImageProviderDraftToConfig(reopened, legacy.id).value!;
    useCustomProvidersStore.getState().replaceAll([saved]);

    const preview = buildCustomProviderRequestDebugPreview({
      prompt: 'nested legacy request',
      model: 'custom:provider-1:gpt-image-2',
      size: '1024x576',
      aspect_ratio: '16:9',
      reference_images: [`data:image/png;base64,${'a'.repeat(400)}`],
    });

    expect(preview.bodyMode).toBe('form-urlencoded');
    expect(preview.body).toEqual({
      input: {
        model: 'gpt-image-2',
        prompt: 'nested legacy request',
        aspect_ratio: '16:9',
        size: '1024x576',
        images: ['data:image/png;base64,[base64 400 chars]'],
      },
    });
  });

  it('keeps a migrated legacy multipart file field and nested scalar hints executable', () => {
    const legacy = provider({
      apiStyle: 'generic-json',
      endpointPath: '/images/edits',
      responseFormat: 'generic',
      extraParams: {
        requestBodyMode: 'multipart',
        multipart: { enabled: true, fileField: 'upload[]' },
        requestBodyHints: {
          modelField: 'input.model',
          promptField: 'input.prompt',
          ratioField: 'input.aspect_ratio',
          sizeField: 'input.size',
          referenceImageField: 'upload[]',
        },
      },
    });
    const reopened = customImageProviderConfigToDraft(legacy);
    const saved = customImageProviderDraftToConfig(reopened, legacy.id).value!;
    useCustomProvidersStore.getState().replaceAll([saved]);

    const preview = buildCustomProviderRequestDebugPreview({
      prompt: 'multipart legacy request',
      model: 'custom:provider-1:gpt-image-2',
      size: '1024x576',
      aspect_ratio: '16:9',
      reference_images: [`data:image/png;base64,${'a'.repeat(400)}`],
    });
    const multipart = preview.multipart as {
      fields: Array<{ name: string; value: string }>;
      files: Array<{ name: string }>;
    };

    expect(multipart.files.map((file) => file.name)).toEqual(['upload[]']);
    expect(multipart.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'input.model', value: 'gpt-image-2' }),
      expect.objectContaining({ name: 'input.prompt', value: 'multipart legacy request' }),
      expect.objectContaining({ name: 'input.aspect_ratio', value: '16:9' }),
      expect.objectContaining({ name: 'input.size', value: '1024x576' }),
    ]));
  });

  it('does not resurrect legacy hints for a hand-authored versioned contract', () => {
    useCustomProvidersStore.getState().replaceAll([provider({
      endpointPath: '/generate',
      extraParams: {
        requestBodyHints: {
          modelField: 'input.model',
          promptField: 'input.prompt',
        },
        imageRequestContract: {
          version: 1,
          textToImage: {
            endpointPath: '/generate',
            bodyMode: 'json',
          },
        },
      },
    })]);

    const preview = buildCustomProviderRequestDebugPreview({
      prompt: 'new contract request',
      model: 'custom:provider-1:gpt-image-2',
      size: '1024x1024',
      aspect_ratio: '1:1',
    });

    expect(preview.body).toMatchObject({
      model: 'gpt-image-2',
      prompt: 'new contract request',
    });
    expect(preview.body).not.toHaveProperty('input');
  });

  it('rejects prototype-mutating legacy request-body hint paths before request composition', () => {
    useCustomProvidersStore.getState().replaceAll([provider({
      apiStyle: 'generic-json',
      extraParams: {
        imageRequestContractLegacyFallback: true,
        requestBodyHints: { modelField: '__proto__.polluted' },
        imageRequestContract: {
          version: 1,
          textToImage: { bodyMode: 'json' },
        },
      },
    })]);

    expect(() => buildCustomProviderRequestDebugPreview({
      prompt: 'safe request',
      model: 'custom:provider-1:gpt-image-2',
      size: '1024x1024',
      aspect_ratio: '1:1',
    })).toThrow(/不安全片段/);
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('rejects an invalid declarative contract before sending HTTP', async () => {
    useCustomProvidersStore.getState().replaceAll([provider({
      extraParams: {
        imageRequestContract: {
          version: 1,
          textToImage: {
            method: 'DELETE',
          },
        },
      },
    })]);

    const job = await waitForTerminalJob(await submitCustomProviderJob({
      prompt: 'draw',
      model: 'custom:provider-1:gpt-image-2',
      size: '1024x1024',
      aspect_ratio: '1:1',
    }));

    expect(job.status).toBe('failed');
    expect(job.error).toContain('textToImage.method');
    expect(customHttpRequestMock).not.toHaveBeenCalled();
  });

  it('extracts a generated image through declarative response paths', async () => {
    useCustomProvidersStore.getState().replaceAll([provider({
      extraParams: {
        imageRequestContract: {
          version: 1,
          textToImage: {
            bodyMode: 'json',
            bodyTemplate: { prompt: '{{prompt}}', model: '{{model}}' },
            responseImagePaths: ['payload.assets[0].src'],
          },
        },
      },
    })]);
    customHttpRequestMock.mockImplementationOnce(() => response(200, {
      payload: { assets: [{ src: 'a'.repeat(400) }] },
    }));

    const job = await waitForTerminalJob(await submitCustomProviderJob({
      prompt: 'draw',
      model: 'custom:provider-1:gpt-image-2',
      size: '1024x1024',
      aspect_ratio: '1:1',
    }));

    expect(job.status).toBe('succeeded');
    expect(customHttpRequestMock).toHaveBeenCalledTimes(1);
  });

  it('preserves a reversed inline result and reports the requested-ratio mismatch', async () => {
    class FakeImage {
      naturalWidth = 2160;
      naturalHeight = 3840;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) {
        queueMicrotask(() => this.onload?.());
      }
    }

    vi.stubGlobal('Image', FakeImage);
    try {
      useCustomProvidersStore.getState().replaceAll([provider({
        extraParams: {
          imageRequestContract: {
            version: 1,
            textToImage: {
              bodyMode: 'json',
              bodyTemplate: { prompt: '{{prompt}}', model: '{{model}}' },
              responseImagePaths: ['result.image'],
            },
          },
        },
      })]);
      customHttpRequestMock.mockImplementationOnce(() => response(200, {
        result: { image: `data:image/png;base64,${'a'.repeat(400)}` },
      }));

      const job = await waitForTerminalJob(await submitCustomProviderJob({
        prompt: 'wide landscape',
        model: 'custom:provider-1:gpt-image-2',
        size: '1920x1080',
        aspect_ratio: '16:9',
      }));

      expect(job.status).toBe('succeeded');
      expect(job.result).toMatch(/^data:image\/png;base64,/);
      expect(job.warning).toContain('上游返回比例方向与请求相反');
      expect(customHttpRequestMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('polls an async contract and tries multiple declared response paths', async () => {
    useCustomProvidersStore.getState().replaceAll([provider({
      extraParams: {
        imageRequestContract: {
          version: 1,
          textToImage: {
            endpointPath: '/submit',
            bodyMode: 'json',
            bodyTemplate: { prompt: '{{prompt}}', model: '{{model}}' },
            responseImagePaths: ['result.primary', 'result.fallback'],
            asyncTask: {
              taskIdPath: 'task.id',
              resultEndpointPath: '/jobs/{taskId}',
              resultMethod: 'GET',
              statusPath: 'status',
              successValues: ['succeeded'],
              failedValues: ['failed'],
              errorPath: 'error.message',
              intervalMs: 500,
              timeoutMs: 5000,
            },
          },
        },
      },
    })]);
    customHttpRequestMock
      .mockImplementationOnce(() => response(200, { task: { id: 'task-1' } }))
      .mockImplementationOnce(() => response(200, {
        status: 'succeeded',
        result: { fallback: 'a'.repeat(400) },
      }));

    const job = await waitForTerminalJob(await submitCustomProviderJob({
      prompt: 'draw',
      model: 'custom:provider-1:gpt-image-2',
      size: '1024x1024',
      aspect_ratio: '1:1',
    }));

    expect(job.status).toBe('succeeded');
    expect(customHttpRequestMock).toHaveBeenCalledTimes(2);
    expect(customHttpRequestMock.mock.calls[1][0].url).toContain('/jobs/task-1');
  });

  it('uses the declared POST body while polling and replaces nested task id placeholders', async () => {
    useCustomProvidersStore.getState().replaceAll([provider({
      extraParams: {
        imageRequestContract: {
          version: 1,
          textToImage: {
            endpointPath: '/submit',
            bodyMode: 'json',
            bodyTemplate: { prompt: '{{prompt}}', model: '{{model}}' },
            responseImagePaths: ['result.image'],
            asyncTask: {
              taskIdPath: 'task.id',
              resultEndpointPath: '/jobs/{taskId}',
              resultMethod: 'POST',
              requestBody: {
                job: '{taskId}',
                nested: { ids: ['{taskId}'] },
              },
              statusPath: 'status',
              successValues: ['succeeded'],
              intervalMs: 500,
              timeoutMs: 5000,
            },
          },
        },
      },
    })]);
    customHttpRequestMock
      .mockImplementationOnce(() => response(200, { task: { id: 'task-1' } }))
      .mockImplementationOnce(() => response(200, {
        status: 'succeeded',
        result: { image: 'a'.repeat(400) },
      }));

    const job = await waitForTerminalJob(await submitCustomProviderJob({
      prompt: 'draw',
      model: 'custom:provider-1:gpt-image-2',
      size: '1024x1024',
      aspect_ratio: '1:1',
    }));

    expect(job.status).toBe('succeeded');
    expect(customHttpRequestMock).toHaveBeenCalledTimes(2);
    expect(customHttpRequestMock.mock.calls[1][0]).toMatchObject({
      method: 'POST',
      body: {
        job: 'task-1',
        nested: { ids: ['task-1'] },
      },
    });
  });

  it('uses the declared async error path without leaking secrets or base64', async () => {
    useCustomProvidersStore.getState().replaceAll([provider({
      extraParams: {
        imageRequestContract: {
          version: 1,
          textToImage: {
            bodyTemplate: { prompt: '{{prompt}}', model: '{{model}}' },
            asyncTask: {
              taskIdPath: 'id',
              resultEndpointPath: '/jobs/{taskId}',
              statusPath: 'status',
              failedValues: ['failed'],
              errorPath: 'error',
              intervalMs: 500,
              timeoutMs: 5000,
            },
          },
        },
      },
    })]);
    const secretBase64 = 'a'.repeat(240);
    customHttpRequestMock
      .mockImplementationOnce(() => response(200, { id: 'task-2' }))
      .mockImplementationOnce(() => response(200, {
        status: 'failed',
        error: `Authorization: Bearer top-secret data:image/png;base64,${secretBase64}`,
      }));

    const job = await waitForTerminalJob(await submitCustomProviderJob({
      prompt: 'draw',
      model: 'custom:provider-1:gpt-image-2',
      size: '1024x1024',
      aspect_ratio: '1:1',
    }));

    expect(job.status).toBe('failed');
    expect(job.error).toContain('[redacted]');
    expect(job.error).toContain('[data-url omitted]');
    expect(job.error).not.toContain('top-secret');
    expect(job.error).not.toContain(secretBase64);
  });
});

describe('Agnes key verification', () => {
  it('uses the non-generation model-list endpoint and selected route', async () => {
    customHttpRequestMock.mockImplementationOnce(() => response(200, {
      data: [{ id: 'agnes-2.5-flash' }, { id: 'agnes-image-2.1-flash' }],
    }));

    const result = await verifyAgnesKey('  agnes-secret  ', {
      route: 'custom-proxy',
      customProxyUrl: 'http://127.0.0.1:7890',
    });

    expect(result).toMatchObject({ ok: true, status: 200, modelCount: 2 });
    expect(customHttpRequestMock).toHaveBeenCalledTimes(1);
    expect(customHttpRequestMock.mock.calls[0][0]).toMatchObject({
      method: 'GET',
      url: 'https://apihub.agnes-ai.com/v1/models',
      networkRoute: 'custom-proxy',
      customProxyUrl: 'http://127.0.0.1:7890',
      headers: { Authorization: 'Bearer agnes-secret' },
    });
  });

  it.each([
    [401, 'authentication'],
    [403, 'authorization'],
    [429, 'rate-limit'],
  ] as const)('classifies Agnes HTTP %s verification failures', async (status, category) => {
    customHttpRequestMock.mockImplementationOnce(() => response(status, { error: 'rejected' }));
    const result = await verifyAgnesKey('agnes-secret');
    expect(result).toMatchObject({ ok: false, status, category });
  });

  it('rejects an unrecognized successful response shape', async () => {
    customHttpRequestMock.mockImplementationOnce(() => response(200, { ok: true }));
    expect(await verifyAgnesKey('agnes-secret')).toMatchObject({
      ok: false,
      status: 200,
      category: 'response-shape',
    });
  });
});

describe('custom provider image edit compatibility negotiation', () => {
  it('preserves legacy multipart negotiation after opening and saving the old config', async () => {
    const legacy = provider({
      endpointPath: '/images/edits',
      extraParams: {
        requestBodyMode: 'multipart',
        requestBodyHints: { referenceImageField: 'image' },
        multipart: { enabled: true, fileField: 'image' },
      },
    });
    const reopened = customImageProviderConfigToDraft(legacy);
    const saved = customImageProviderDraftToConfig(reopened, legacy.id).value!;
    useCustomProvidersStore.getState().replaceAll([saved]);
    customHttpRequestMock
      .mockImplementationOnce(() => response(400, { error: { message: 'missing image file field' } }))
      .mockImplementationOnce(() => response(200, { data: [{ b64_json: 'a'.repeat(400) }] }));

    const job = await waitForTerminalJob(await submitCustomProviderJob(imageEditRequest()));

    expect(job.status).toBe('succeeded');
    expect(customHttpRequestMock).toHaveBeenCalledTimes(2);
    expect(customHttpRequestMock.mock.calls.map(([request]) => request.multipart.files[0].name)).toEqual([
      'image',
      'image[]',
    ]);
  });

  it('keeps legacy multipart negotiation available when a migrated contract has no wire-shape template', async () => {
    useCustomProvidersStore.getState().replaceAll([provider({
      endpointPath: '/images/edits',
      extraParams: {
        // This is the versioned mirror produced by the legacy migration. It
        // declares transport metadata, but not an explicit body/file shape.
        imageRequestContract: {
          version: 1,
          imageToImage: {
            endpointPath: '/images/edits',
            method: 'POST',
            bodyMode: 'multipart',
            responseImagePaths: ['data[0].b64_json'],
          },
        },
        requestBodyMode: 'multipart',
        multipart: { enabled: true, fileField: 'image' },
      },
    })]);
    customHttpRequestMock
      .mockImplementationOnce(() => response(400, { error: { message: 'missing image file field' } }))
      .mockImplementationOnce(() => response(200, { data: [{ b64_json: 'a'.repeat(400) }] }));

    const job = await waitForTerminalJob(await submitCustomProviderJob(imageEditRequest()));

    expect(job.status).toBe('succeeded');
    expect(customHttpRequestMock).toHaveBeenCalledTimes(2);
    expect(customHttpRequestMock.mock.calls.map(([request]) => request.multipart.files[0].name)).toEqual([
      'image',
      'image[]',
    ]);
  });

  it('does not disable negotiation for an empty versioned contract', async () => {
    useCustomProvidersStore.getState().replaceAll([provider({
      endpointPath: '/images/edits',
      extraParams: {
        imageRequestContract: { version: 1 },
        requestBodyMode: 'multipart',
        multipart: { enabled: true, fileField: 'image' },
      },
    })]);
    customHttpRequestMock
      .mockImplementationOnce(() => response(400, { error: { message: 'missing image file field' } }))
      .mockImplementationOnce(() => response(200, { data: [{ b64_json: 'a'.repeat(400) }] }));

    expect((await waitForTerminalJob(await submitCustomProviderJob(imageEditRequest()))).status).toBe('succeeded');
    expect(customHttpRequestMock).toHaveBeenCalledTimes(2);
  });

  it('retries the same configured profile once for an empty-model rejection without learning an alternate', async () => {
    useCustomProvidersStore.getState().replaceAll([provider({
      endpointPath: '/images/edits',
      extraParams: {
        requestBodyMode: 'multipart',
        multipart: { enabled: true, fileField: 'image' },
      },
    })]);
    customHttpRequestMock
      .mockImplementationOnce(() => response(400, { error: { message: 'Model name not specified, model name cannot be empty' } }))
      .mockImplementationOnce(() => response(200, { data: [{ b64_json: 'a'.repeat(400) }] }));

    const job = await waitForTerminalJob(await submitCustomProviderJob(imageEditRequest()));

    expect(job.status).toBe('succeeded');
    expect(customHttpRequestMock).toHaveBeenCalledTimes(2);
    expect(customHttpRequestMock.mock.calls.map(([request]) => request.multipart.files[0].name)).toEqual([
      'image',
      'image',
    ]);
    expect(storageValues.get('custom-provider-image-edit-compatibility:v1')).toBeUndefined();
  });

  it('falls back to the OpenAI array profile after a recognized validation rejection and reuses it', async () => {
    useCustomProvidersStore.getState().replaceAll([provider({
      endpointPath: '/images/edits',
      extraParams: {
        requestBodyMode: 'multipart',
        multipart: { enabled: true, fileField: 'image' },
      },
    })]);
    customHttpRequestMock
      .mockImplementationOnce(() => response(400, { error: { message: 'missing image file field' } }))
      .mockImplementationOnce(() => response(200, { data: [{ b64_json: 'a'.repeat(400) }] }));

    expect((await waitForTerminalJob(await submitCustomProviderJob(imageEditRequest()))).status).toBe('succeeded');
    expect(customHttpRequestMock.mock.calls.map(([request]) => request.multipart.files[0].name)).toEqual([
      'image',
      'image[]',
    ]);

    const learned = storageValues.get('custom-provider-image-edit-compatibility:v1');
    expect(learned).toContain('openai-array');
    expect(learned).not.toContain('secret');
    expect(learned).not.toContain('edit this image');
    expect(learned).not.toContain('aaaa');

    customHttpRequestMock.mockReset();
    customHttpRequestMock.mockImplementationOnce(() => response(200, { data: [{ b64_json: 'a'.repeat(400) }] }));
    expect((await waitForTerminalJob(await submitCustomProviderJob(imageEditRequest()))).status).toBe('succeeded');
    expect(customHttpRequestMock).toHaveBeenCalledTimes(1);
    expect(customHttpRequestMock.mock.calls[0][0].multipart.files[0].name).toBe('image[]');
  });

  it('uses a single-file minimal profile when the configured profile already uses image[]', async () => {
    useCustomProvidersStore.getState().replaceAll([provider({
      endpointPath: '/images/edits',
      extraParams: {
        requestBodyMode: 'multipart',
        defaultRequestParams: { quality: 'auto', output_format: 'png' },
        multipart: { enabled: true, fileField: 'image[]' },
        requestBodyHints: {
          modelField: 'input.model_name',
          promptField: 'input.prompt',
        },
      },
    })]);
    customHttpRequestMock
      .mockImplementationOnce(() => response(400, { error: { message: 'unsupported parameter output_format' } }))
      .mockImplementationOnce(() => response(200, { data: [{ b64_json: 'a'.repeat(400) }] }));

    expect((await waitForTerminalJob(await submitCustomProviderJob(imageEditRequest()))).status).toBe('succeeded');
    expect(customHttpRequestMock).toHaveBeenCalledTimes(2);
    const fallbackMultipart = customHttpRequestMock.mock.calls[1][0].multipart;
    expect(fallbackMultipart.files).toHaveLength(1);
    expect(fallbackMultipart.files[0].name).toBe('image');
    expect(fallbackMultipart.fields.map((field: { name: string }) => field.name).sort()).toEqual([
      'model',
      'n',
      'prompt',
      'size',
    ]);
  });

  it.each([
    ['network failure', () => Promise.reject(new Error('connection timed out')), 'unknown'],
    ['HTTP 408', () => response(408, { error: 'timeout' }), 'unknown'],
    ['HTTP 429', () => response(429, { error: 'rate limited' }), 'failed'],
    ['HTTP 500', () => response(500, { error: 'upstream error' }), 'failed'],
    ['unrecognized HTTP 400', () => response(400, { error: 'generation rejected' }), 'failed'],
    ['response content-type HTTP 400', () => response(400, {
      error: 'upstream response content-type text/html after processing',
    }), 'failed'],
    ['no generated image HTTP 400', () => response(400, {
      error: 'no image was generated by the upstream service',
    }), 'failed'],
  ] as const)('never negotiates after %s', async (_label, implementation, expectedStatus) => {
    useCustomProvidersStore.getState().replaceAll([provider({
      endpointPath: '/images/edits',
      extraParams: {
        requestBodyMode: 'multipart',
        multipart: { enabled: true, fileField: 'image' },
      },
    })]);
    customHttpRequestMock.mockImplementationOnce(implementation);

    const job = await waitForTerminalJob(await submitCustomProviderJob(imageEditRequest()));

    expect(job.status).toBe(expectedStatus);
    expect(customHttpRequestMock).toHaveBeenCalledTimes(1);
  });

  it('negotiates after an explicit request multipart content-type validation rejection', async () => {
    useCustomProvidersStore.getState().replaceAll([provider({
      endpointPath: '/images/edits',
      extraParams: {
        requestBodyMode: 'multipart',
        multipart: { enabled: true, fileField: 'image' },
      },
    })]);
    customHttpRequestMock
      .mockImplementationOnce(() => response(400, {
        error: 'request Content-Type must be multipart/form-data',
      }))
      .mockImplementationOnce(() => response(200, { data: [{ b64_json: 'a'.repeat(400) }] }));

    const job = await waitForTerminalJob(await submitCustomProviderJob(imageEditRequest()));

    expect(job.status).toBe('succeeded');
    expect(customHttpRequestMock).toHaveBeenCalledTimes(2);
  });

  it('does not learn an alternate profile from an HTTP 200 application-level failure', async () => {
    useCustomProvidersStore.getState().replaceAll([provider({
      endpointPath: '/images/edits',
      extraParams: {
        requestBodyMode: 'multipart',
        multipart: { enabled: true, fileField: 'image' },
      },
    })]);
    customHttpRequestMock
      .mockImplementationOnce(() => response(400, { error: 'missing image file field' }))
      .mockImplementationOnce(() => response(200, {
        code: 400,
        message: 'invalid request field',
      }));

    const job = await waitForTerminalJob(await submitCustomProviderJob(imageEditRequest()));

    expect(job.status).toBe('failed');
    expect(customHttpRequestMock).toHaveBeenCalledTimes(2);
    expect(storageValues.get('custom-provider-image-edit-compatibility:v1')).toBeUndefined();
  });

  it('caps the empty-model path at one same-profile retry and one alternate attempt', async () => {
    useCustomProvidersStore.getState().replaceAll([provider({
      endpointPath: '/images/edits',
      extraParams: {
        requestBodyMode: 'multipart',
        multipart: { enabled: true, fileField: 'image' },
      },
    })]);
    customHttpRequestMock.mockImplementation(() => response(400, {
      error: { message: 'Model name not specified, model name cannot be empty' },
    }));

    const job = await waitForTerminalJob(await submitCustomProviderJob(imageEditRequest()));

    expect(job.status).toBe('failed');
    expect(customHttpRequestMock).toHaveBeenCalledTimes(3);
    expect(customHttpRequestMock.mock.calls.map(([request]) => request.multipart.files[0].name)).toEqual([
      'image',
      'image',
      'image[]',
    ]);
    expect(job.error).toContain('configured');
    expect(job.error).toContain('openai-array');
  });

  it.each([
    {
      label: 'provider base URL',
      mutate: (cfg: CustomProviderConfig) => ({ ...cfg, baseUrl: 'https://other.example.com/v1' }),
      request: () => imageEditRequest(),
      expectedFileField: 'image',
    },
    {
      label: 'edit endpoint',
      mutate: (cfg: CustomProviderConfig) => ({ ...cfg, endpointPath: '/v2/images/edits' }),
      request: () => imageEditRequest(),
      expectedFileField: 'image',
    },
    {
      label: 'model family',
      mutate: (cfg: CustomProviderConfig) => cfg,
      request: () => imageEditRequest('provider-1', 'gpt-image-3'),
      expectedFileField: 'image',
    },
    {
      label: 'multipart configuration',
      mutate: (cfg: CustomProviderConfig) => ({
        ...cfg,
        extraParams: {
          ...cfg.extraParams,
          multipart: { enabled: true, fileField: 'custom-image' },
        },
      }),
      request: () => imageEditRequest(),
      expectedFileField: 'custom-image',
    },
    {
      label: 'default request parameter value',
      mutate: (cfg: CustomProviderConfig) => ({
        ...cfg,
        extraParams: {
          ...cfg.extraParams,
          defaultRequestParams: { quality: 'hd' },
        },
      }),
      request: () => imageEditRequest(),
      expectedFileField: 'image',
    },
    {
      label: 'provider route query',
      mutate: (cfg: CustomProviderConfig) => ({
        ...cfg,
        queryParams: { channel: 'secondary' },
      }),
      request: () => imageEditRequest(),
      expectedFileField: 'image',
    },
  ])('invalidates learned selection when $label changes', async ({ mutate, request, expectedFileField }) => {
    const initialProvider = provider({
      endpointPath: '/images/edits',
      queryParams: { channel: 'primary' },
      extraParams: {
        requestBodyMode: 'multipart',
        defaultRequestParams: { quality: 'auto' },
        multipart: { enabled: true, fileField: 'image' },
      },
    });
    useCustomProvidersStore.getState().replaceAll([initialProvider]);
    customHttpRequestMock
      .mockImplementationOnce(() => response(400, { error: { message: 'missing image file field' } }))
      .mockImplementationOnce(() => response(200, { data: [{ b64_json: 'a'.repeat(400) }] }));
    await waitForTerminalJob(await submitCustomProviderJob(imageEditRequest()));

    useCustomProvidersStore.getState().replaceAll([mutate(initialProvider)]);
    customHttpRequestMock.mockReset();
    customHttpRequestMock.mockImplementationOnce(() => response(200, { data: [{ b64_json: 'a'.repeat(400) }] }));
    await waitForTerminalJob(await submitCustomProviderJob(request()));

    expect(customHttpRequestMock.mock.calls[0][0].multipart.files[0].name).toBe(expectedFileField);
  });
});

describe('custom provider diagnostic source redaction', () => {
  it('reads dimensions from inline image results when the browser decoder is available', async () => {
    class FakeImage {
      naturalWidth = 2160;
      naturalHeight = 3840;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) {
        queueMicrotask(() => this.onload?.());
      }
    }
    vi.stubGlobal('Image', FakeImage);

    await expect(detectInlineImageAspectRatio('data:image/png;base64,AAAA')).resolves.toBe('9:16');

    vi.unstubAllGlobals();
  });

  it('never includes data-url or long base64 payloads in materialization logs', () => {
    const dataPayload = 'sensitive-image-payload';
    const dataUrl = `data:image/png;base64,${dataPayload}`;
    const longBase64 = 'secret'.repeat(80);

    expect(summarizeMaterializedSourceForLog(dataUrl)).not.toContain(dataPayload);
    expect(summarizeMaterializedSourceForLog(dataUrl)).toContain('data-url omitted');
    expect(summarizeMaterializedSourceForLog(longBase64)).not.toContain(longBase64);
    expect(summarizeMaterializedSourceForLog(longBase64)).toContain('base64 omitted');
  });

  it('summarizes remote and local sources without leaking query secrets or paths', () => {
    expect(summarizeMaterializedSourceForLog('https://cdn.example.com/result.png?token=secret')).toBe('[remote-url omitted]');
    expect(summarizeMaterializedSourceForLog('/Users/alice/private/result.png')).toBe('[local-file omitted]');
  });
});
