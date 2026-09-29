import { describe, expect, it, vi } from 'vitest';
import type { CustomProviderConfig } from '@/stores/customProvidersStore';
import { buildVideoModelCatalog } from '@/features/canvas/application/videoModelCatalog';
import type { GenerateRequest } from '@/commands/ai';
import {
  checkComfyUIConnection,
  ComfyUIExecutionError,
  createComfyUIWorkflowTemplate,
  getComfyUITemplateCheckpoint,
  getComfyUIVideoCapabilities,
  inspectComfyUIHistory,
  listComfyUICheckpoints,
  parseComfyUIConfig,
  pollComfyUIWorkflow,
  prepareComfyUIWorkflow,
  submitComfyUIWorkflow,
  suggestComfyUIBindings,
  suggestComfyUIOutputNodes,
  validateComfyUIRequest,
  withComfyUITemplateCheckpoint,
  type ComfyUITransport,
} from './comfyuiGateway';

const workflow = {
  '3': { class_type: 'KSampler', inputs: { seed: 1, positive: ['6', 0] } },
  '5': { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512 } },
  '6': { class_type: 'CLIPTextEncode', inputs: { text: 'original prompt' } },
  '9': { class_type: 'SaveImage', inputs: { images: ['3', 0] } },
  '10': { class_type: 'LoadImage', inputs: { image: 'old.png' } },
};

function provider(overrides: Partial<CustomProviderConfig> = {}): CustomProviderConfig {
  return {
    id: 'comfy-1',
    label: 'Local ComfyUI',
    mediaType: 'image',
    baseUrl: 'http://127.0.0.1:8188',
    apiKey: '',
    apiStyle: 'comfyui',
    models: ['workflow'],
    supportsWebSearch: false,
    extraParams: {
      auth: { mode: 'none' },
      comfyui: { workflow, outputNodeIds: ['9'] },
    },
    ...overrides,
  };
}

const request: GenerateRequest = {
  prompt: 'a castle at dawn',
  model: 'custom:comfy-1:workflow',
  size: '1024x768',
  aspect_ratio: '4:3',
  reference_images: ['data:image/png;base64,AAAA'],
  extra_params: { seed: 42 },
};

function transport(): ComfyUITransport & { json: ReturnType<typeof vi.fn>; multipart: ReturnType<typeof vi.fn> } {
  return {
    json: vi.fn(),
    multipart: vi.fn(),
    url: (path, query) => `http://127.0.0.1:8188${path}?${new URLSearchParams(query).toString()}`,
  };
}

describe('ComfyUI workflow gateway', () => {
  it('builds core text and reference image templates with editable checkpoint names', () => {
    for (const id of ['text-to-image', 'image-to-image'] as const) {
      const template = createComfyUIWorkflowTemplate(id, 'model.safetensors');
      const config = parseComfyUIConfig(provider({ extraParams: { comfyui: template } }));
      expect(() => validateComfyUIRequest(config, { ...request, reference_images: id === 'image-to-image' ? request.reference_images : [] })).not.toThrow();
      expect(getComfyUITemplateCheckpoint(template.workflow)).toBe('model.safetensors');
      expect(withComfyUITemplateCheckpoint(template.workflow, 'new.safetensors')['1'].inputs).toMatchObject({ ckpt_name: 'new.safetensors' });
      expect(getComfyUITemplateCheckpoint(template.workflow)).toBe('model.safetensors');
      expect(template.outputNodeIds).toEqual(['8']);
    }
  });

  it('lists checkpoints from the direct endpoint or object info fallback', async () => {
    const direct = transport();
    direct.json.mockResolvedValueOnce(['a.safetensors', 'b.safetensors']);
    await expect(listComfyUICheckpoints(direct)).resolves.toEqual(['a.safetensors', 'b.safetensors']);
    expect(direct.json).toHaveBeenCalledTimes(1);

    const fallback = transport();
    fallback.json.mockRejectedValueOnce(new Error('unsupported')).mockResolvedValueOnce({
      CheckpointLoaderSimple: { input: { required: { ckpt_name: [['legacy.ckpt']] } } },
    });
    await expect(listComfyUICheckpoints(fallback)).resolves.toEqual(['legacy.ckpt']);
    expect(fallback.json.mock.calls).toEqual([
      ['/models/checkpoints', 'GET'],
      ['/object_info/CheckpointLoaderSimple', 'GET'],
    ]);
  });

  it('requires API format and suggests common bindings and output nodes', () => {
    expect(() => parseComfyUIConfig(provider({ extraParams: {
      comfyui: { workflow: { nodes: [], links: [] } },
    } }))).toThrow('API 格式');
    expect(suggestComfyUIBindings(workflow)).toMatchObject({
      prompt: { nodeId: '6', input: 'text' },
      seed: { nodeId: '3', input: 'seed' },
      width: { nodeId: '5', input: 'width' },
      height: { nodeId: '5', input: 'height' },
      images: [{ nodeId: '10', input: 'image' }],
    });
    expect(suggestComfyUIOutputNodes(workflow)).toEqual(['9']);
  });

  it('patches prompt, seed, dimensions and uploaded image without mutating the saved graph', () => {
    const config = parseComfyUIConfig(provider());
    const patched = prepareComfyUIWorkflow(config, request, ['uploaded.png']);
    expect(patched['6'].inputs).toMatchObject({ text: 'a castle at dawn' });
    expect(patched['3'].inputs).toMatchObject({ seed: 42 });
    expect(patched['5'].inputs).toMatchObject({ width: 1024, height: 768 });
    expect(patched['10'].inputs).toMatchObject({ image: 'uploaded.png' });
    expect(workflow['10'].inputs.image).toBe('old.png');
  });

  it('requires an explicit positive prompt binding when a workflow has positive and negative text nodes', () => {
    const dualPromptWorkflow = {
      ...workflow,
      '7': { class_type: 'CLIPTextEncode', inputs: { text: 'negative prompt' } },
    };
    const base = provider({ extraParams: { comfyui: { workflow: dualPromptWorkflow, outputNodeIds: ['9'] } } });
    const unmapped = parseComfyUIConfig(base);
    expect(() => validateComfyUIRequest(unmapped, { ...request, reference_images: [] }))
      .toThrow('请选择 ComfyUI 提示词节点');

    const mapped = parseComfyUIConfig(provider({ extraParams: {
      comfyui: {
        workflow: dualPromptWorkflow,
        outputNodeIds: ['9'],
        bindings: { prompt: { nodeId: '6', input: 'text' }, images: [] },
      },
    } }));
    expect(() => validateComfyUIRequest(mapped, { ...request, reference_images: [] })).not.toThrow();
  });

  it('rejects missing reference mapping before upload or generation', async () => {
    const config = parseComfyUIConfig(provider());
    const twoImages = { ...request, reference_images: [...request.reference_images!, 'data:image/png;base64,BBBB'] };
    expect(() => validateComfyUIRequest(config, twoImages)).toThrow('只有 1 个参考图输入');
    const client = transport();
    await expect(submitComfyUIWorkflow(config, twoImages, client)).rejects.toThrow('只有 1 个参考图输入');
    expect(client.multipart).not.toHaveBeenCalled();
    expect(client.json).not.toHaveBeenCalled();
  });

  it('uploads references then submits the patched workflow exactly once', async () => {
    const client = transport();
    client.multipart.mockResolvedValue({ name: 'uploaded.png', subfolder: '' });
    client.json.mockResolvedValue({ prompt_id: 'prompt-123' });
    const result = await submitComfyUIWorkflow(parseComfyUIConfig(provider()), request, client);

    expect(result).toEqual({ prompt_id: 'prompt-123' });
    expect(client.multipart).toHaveBeenCalledWith('/upload/image', expect.objectContaining({
      files: [expect.objectContaining({ name: 'image', fileName: 'canvas-reference-1.png' })],
    }));
    expect(client.json).toHaveBeenCalledTimes(1);
    expect(client.json).toHaveBeenCalledWith('/prompt', 'POST', expect.objectContaining({
      prompt: expect.objectContaining({
        '6': expect.objectContaining({ inputs: { text: 'a castle at dawn' } }),
        '10': expect.objectContaining({ inputs: { image: 'uploaded.png' } }),
      }),
    }));
  });

  it('parses selected image/video outputs and terminal execution failures', () => {
    const config = parseComfyUIConfig(provider());
    expect(inspectComfyUIHistory({}, 'prompt-123', config, 'image').state).toBe('pending');
    expect(inspectComfyUIHistory({
      'prompt-123': { outputs: { '9': { images: [{ filename: 'final.png', subfolder: '', type: 'output' }] } } },
    }, 'prompt-123', config, 'image')).toMatchObject({
      state: 'ready', file: { filename: 'final.png' },
    });
    expect(inspectComfyUIHistory({
      'prompt-123': { outputs: { '9': { gifs: [{ filename: 'clip.mp4', subfolder: '', type: 'output' }] } } },
    }, 'prompt-123', config, 'video')).toMatchObject({
      state: 'ready', file: { filename: 'clip.mp4' },
    });
    expect(inspectComfyUIHistory({
      'prompt-123': { outputs: { '9': { animations: [
        { filename: 'preview.mp4', subfolder: '', type: 'temp' },
        { filename: 'final.mp4', subfolder: '', type: 'output' },
      ] } } },
    }, 'prompt-123', config, 'video')).toMatchObject({
      state: 'ready', file: { filename: 'final.mp4', type: 'output' },
    });
    expect(inspectComfyUIHistory({
      'prompt-123': { status: { status_str: 'error', messages: [['execution_error', { exception_message: 'missing checkpoint' }]] } },
    }, 'prompt-123', config, 'image')).toEqual({ state: 'failed', error: 'missing checkpoint' });
  });

  it('polls by prompt id and returns a safe /view URL without resubmitting', async () => {
    const config = { ...parseComfyUIConfig(provider()), pollIntervalMs: 1 };
    const client = transport();
    client.json
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        'prompt-123': { outputs: { '9': { images: [{ filename: 'final.png', subfolder: 'results', type: 'output' }] } } },
      });
    const url = await pollComfyUIWorkflow(config, 'prompt-123', 'image', client);
    expect(url).toContain('/view?filename=final.png&subfolder=results&type=output');
    expect(client.json).toHaveBeenCalledTimes(2);
    expect(client.json).toHaveBeenCalledWith('/history/prompt-123', 'GET');
    expect(client.multipart).not.toHaveBeenCalled();
  });

  it('distinguishes terminal failure from a task that can be polled again', async () => {
    const client = transport();
    client.json.mockResolvedValue({ 'prompt-123': { status: { status_str: 'error' } } });
    await expect(pollComfyUIWorkflow(parseComfyUIConfig(provider()), 'prompt-123', 'image', client))
      .rejects.toBeInstanceOf(ComfyUIExecutionError);
  });

  it('checks connectivity with read-only endpoints', async () => {
    const client = transport();
    client.json.mockRejectedValueOnce(new Error('not found')).mockResolvedValueOnce({ queue_running: [] });
    await checkComfyUIConnection(client);
    expect(client.json.mock.calls).toEqual([
      ['/system_stats', 'GET'],
      ['/queue', 'GET'],
    ]);
    expect(client.multipart).not.toHaveBeenCalled();
  });
});

const h3Workflow = {
  '1': { class_type: 'MiniMaxH3ImageToVideo', inputs: { prompt: '', width: 1344, height: 768, length: 124 } },
  '2': { class_type: 'RandomNoise', inputs: { noise_seed: 7 } },
  '9': { class_type: 'SaveVideo', inputs: { video: ['8', 0], format: 'auto', codec: 'auto', filename_prefix: 'video/H3' } },
};
function h3Provider(): CustomProviderConfig {
  return provider({ mediaType: 'video', extraParams: { auth: { mode: 'none' }, comfyui: { workflow: h3Workflow } } });
}

describe('ComfyUI video workflow contracts', () => {
  it('infers H3 prompt, canvas, frame count and noise seed from the real local node classes', () => {
    expect(suggestComfyUIBindings(h3Workflow)).toMatchObject({
      prompt: { nodeId: '1', input: 'prompt' }, width: { nodeId: '1', input: 'width' },
      height: { nodeId: '1', input: 'height' }, duration: { nodeId: '1', input: 'length' },
      seed: { nodeId: '2', input: 'noise_seed' }, images: [],
    });
    expect(suggestComfyUIBindings({ ...h3Workflow, '2': { class_type: 'KSamplerAdvanced', inputs: { noise_seed: 17 } } }).seed)
      .toEqual({ nodeId: '2', input: 'noise_seed' });
  });

  it.each([[5, 124], [8, 192], [15, 362]])('maps %s seconds to %s H3 frames and uses a video canvas', (seconds, frames) => {
    const patched = prepareComfyUIWorkflow(parseComfyUIConfig(h3Provider()), {
      ...request, size: '768P', aspect_ratio: '9:16', reference_images: [], extra_params: { seconds, seed: 42 },
    });
    expect(patched['1'].inputs).toMatchObject({ prompt: request.prompt, length: frames, width: 768, height: 1344 });
    expect(patched['2'].inputs).toEqual({ noise_seed: 42 });
    expect(h3Workflow['1'].inputs.length).toBe(124);
  });

  it.each(['2048x2048', '1333x768', '2K'])('rejects invalid H3 size %s before submitting', async (size) => {
    const client = transport();
    await expect(submitComfyUIWorkflow(parseComfyUIConfig(h3Provider()), { ...request, size, reference_images: [] }, client)).rejects.toThrow();
    expect(client.json).not.toHaveBeenCalled();
    expect(client.multipart).not.toHaveBeenCalled();
  });

  it('writes explicit generic video duration, resolution and ratio bindings', () => {
    const config = parseComfyUIConfig(provider({ mediaType: 'video', extraParams: { comfyui: {
      workflow: { '1': { class_type: 'CustomVideo', inputs: { prompt: '', duration: 6, resolution: '720p', ratio: '16:9' } } },
      bindings: { prompt: { nodeId: '1', input: 'prompt' }, duration: { nodeId: '1', input: 'duration' },
        resolution: { nodeId: '1', input: 'resolution' }, aspectRatio: { nodeId: '1', input: 'ratio' }, images: [] },
    } } }));
    const patched = prepareComfyUIWorkflow(config, { ...request, size: '1080p', aspect_ratio: '9:16', reference_images: [], extra_params: { seconds: 12 } });
    expect(patched['1'].inputs).toEqual({ prompt: request.prompt, duration: 12, resolution: '1080p', ratio: '9:16' });
  });

  it('rejects missing required reference images before uploading or submitting', async () => {
    const config = parseComfyUIConfig(provider({ extraParams: { comfyui: createComfyUIWorkflowTemplate('image-to-image', 'model.safetensors') } }));
    const client = transport();
    await expect(submitComfyUIWorkflow(config, { ...request, reference_images: [] }, client)).rejects.toThrow('至少需要 1 张');
    expect(client.json).not.toHaveBeenCalled();
    expect(client.multipart).not.toHaveBeenCalled();
    expect(() => validateComfyUIRequest(parseComfyUIConfig(provider()), { ...request, reference_images: [] })).not.toThrow();
  });

  it('exposes only actual image bindings and keeps unbound video parameters in the workflow', () => {
    const fixed = provider({ mediaType: 'video', extraParams: { comfyui: { workflow },
      supportedDurations: ['4', '8', '12'], videoInputSchema: { images: { enabled: true, max: 9 }, video: { enabled: true } } } });
    const capabilities = getComfyUIVideoCapabilities(parseComfyUIConfig(fixed));
    expect(capabilities.supportedDurations).toEqual(['workflow']);
    expect(capabilities.inputSchema).toMatchObject({ images: { min: 0, max: 1, roles: ['reference'] }, video: { enabled: false }, audio: { enabled: false } });
    const entries = buildVideoModelCatalog([fixed, h3Provider()]);
    expect(entries[0].supportedDurations).toEqual(['workflow']);
    expect(entries[0].inputSchema.images.max).toBe(1);
    expect(entries[1].supportedDurations).toEqual(['5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15']);
    expect(entries[1].inputSchema.images.enabled).toBe(false);
    expect(entries[1].supportedResolutions).toEqual(['768P']);
  });

  it('accepts the real SaveVideo history images array containing an mp4', () => {
    expect(inspectComfyUIHistory({ task: { status: { completed: true }, outputs: { '9': { images: [
      { filename: 'H3_00001_.mp4', subfolder: 'video', type: 'output' },
    ] } } } }, 'task', parseComfyUIConfig(h3Provider()), 'video')).toMatchObject({ state: 'ready', file: { filename: 'H3_00001_.mp4', subfolder: 'video' } });
  });

  it('rejects video/audio uploads before network activity instead of silently ignoring them', async () => {
    const client = transport();
    await expect(submitComfyUIWorkflow(parseComfyUIConfig(h3Provider()), { ...request, size: '768P', reference_images: [], reference_videos: ['https://example.com/clip.mp4'] }, client)).rejects.toThrow('视频和音频');
    expect(client.json).not.toHaveBeenCalled();
  });

  it('does not accept traversal or input files as generated video results', () => {
    for (const file of [
      { filename: '../clip.mp4', subfolder: '', type: 'output' },
      { filename: 'clip.mp4', subfolder: '../private', type: 'output' },
      { filename: 'clip.mp4', subfolder: '', type: 'input' },
    ]) {
      expect(inspectComfyUIHistory({ task: { status: { completed: true }, outputs: { '9': { images: [file] } } } }, 'task', parseComfyUIConfig(h3Provider()), 'video').state).toBe('failed');
    }
  });
});
