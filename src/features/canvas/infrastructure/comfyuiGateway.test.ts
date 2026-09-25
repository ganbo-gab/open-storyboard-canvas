import { describe, expect, it, vi } from 'vitest';
import type { CustomProviderConfig } from '@/stores/customProvidersStore';
import type { GenerateRequest } from '@/commands/ai';
import {
  checkComfyUIConnection,
  ComfyUIExecutionError,
  inspectComfyUIHistory,
  parseComfyUIConfig,
  pollComfyUIWorkflow,
  prepareComfyUIWorkflow,
  submitComfyUIWorkflow,
  suggestComfyUIBindings,
  suggestComfyUIOutputNodes,
  validateComfyUIRequest,
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
