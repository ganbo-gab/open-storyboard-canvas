import { describe, expect, it } from 'vitest';
import { createComfyUIWorkflowTemplate } from '@/features/canvas/infrastructure/comfyuiGateway';
import { detectComfyUIBindings } from './bindings';
import { preflightComfyUIWorkflow } from './preflight';
import { parseComfyUIProgress } from './progress';
import { cloneWorkflow } from './workflow';

describe('ComfyUI workflow inspection', () => {
  it.each(['text-to-image', 'image-to-image'] as const)('lists bindings from existing %s template', (id) => {
    const { workflow } = createComfyUIWorkflowTemplate(id, 'model.safetensors');
    const detected = detectComfyUIBindings(workflow);
    expect(detected.prompt.status).toBe('ambiguous');
    expect(detected.prompt.candidates.map(({ nodeId, input }) => `${nodeId}.${input}`)).toEqual(['2.text', '3.text']);
    expect(detected.seed.binding).toEqual({ nodeId: '6', input: 'seed' });
    expect(detected.output.binding).toEqual({ nodeId: '8', input: '$output' });
    expect(detected.image1.status).toBe(id === 'image-to-image' ? 'auto' : 'missing');
    expect(detected.width.status).toBe(id === 'text-to-image' ? 'auto' : 'missing');
  });

  it.each(['OSC', 'ARCREEL'])('resolves explicit %s markers while retaining candidate options', (prefix) => {
    const workflow = {
      a: { class_type: 'CLIPTextEncode', inputs: { text: '' }, _meta: { title: `${prefix}:prompt` } },
      b: { class_type: 'CLIPTextEncode', inputs: { text: '' } },
      c: { class_type: 'LoadImage', inputs: { image: '' }, _meta: { title: `${prefix}:image2` } },
      d: { class_type: 'LoadImage', inputs: { image: '' } },
      e: { class_type: 'CustomSave', inputs: {}, _meta: { title: `${prefix}:output` } },
    };
    const result = detectComfyUIBindings(workflow);
    expect(result.prompt.status).toBe('auto');
    expect(result.prompt.binding).toEqual({ nodeId: 'a', input: 'text' });
    expect(result.prompt.candidates).toHaveLength(2);
    expect(result.image1.status).toBe('ambiguous');
    expect(result.image2.binding).toEqual({ nodeId: 'c', input: 'image' });
    expect(result.output.binding?.nodeId).toBe('e');
    workflow.b = { ...workflow.b, _meta: { title: `${prefix}:prompt` } } as typeof workflow.b;
    expect(detectComfyUIBindings(workflow).prompt.status).toBe('ambiguous');
  });

  it('detects local H3 geometry, duration and noise seed classes used by the legacy fixture', () => {
    const result = detectComfyUIBindings({
      '1': { class_type: 'MiniMaxH3ImageToVideo', inputs: { prompt: '', width: 1344, height: 768, length: 124 } },
      '2': { class_type: 'RandomNoise', inputs: { noise_seed: 7 } },
      '9': { class_type: 'SaveVideo', inputs: { video: ['8', 0] } },
    });
    expect(result.duration.binding).toEqual({ nodeId: '1', input: 'length' });
    expect(result.seed.binding).toEqual({ nodeId: '2', input: 'noise_seed' });
    expect(result.output.binding?.nodeId).toBe('9');
  });

  it('rejects canvas exports and detaches the imported graph', () => {
    expect(() => cloneWorkflow({ nodes: [], links: [] })).toThrow('API');
    const source = { a: { class_type: 'CLIPTextEncode', inputs: { text: 'original' } } };
    const clone = cloneWorkflow(source);
    (clone.a.inputs as Record<string, unknown>).text = 'changed';
    expect(source.a.inputs.text).toBe('original');
    expect(() => cloneWorkflow(JSON.parse('{"__proto__":{"class_type":"X","inputs":{}}}'))).toThrow();
  });

  it('reports missing custom nodes and checkpoint files, but not arbitrary enums or links', () => {
    const result = preflightComfyUIWorkflow({
      CheckpointLoaderSimple: { input: { required: { ckpt_name: [['installed.safetensors']], precision: [['fp16', 'fp32']] } } },
      LoraLoader: { input: { optional: { lora_name: [['installed-lora.safetensors']] } } },
    }, {
      a: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'missing.ckpt', precision: 'auto' } },
      b: { class_type: 'MyCustomNode', inputs: {} },
      c: { class_type: 'LoraLoader', inputs: { lora_name: ['a', 0] } },
    });
    expect(result.ok).toBe(false);
    expect(result.missingNodeClasses).toEqual([{ nodeId: 'b', classType: 'MyCustomNode' }]);
    expect(result.missingModelFiles).toEqual([{ nodeId: 'a', classType: 'CheckpointLoaderSimple', input: 'ckpt_name', filename: 'missing.ckpt', available: ['installed.safetensors'] }]);
    expect(preflightComfyUIWorkflow({ XLoader: { input: { required: { model_name: [['model']] } } } }, { a: { class_type: 'XLoader', inputs: { model_name: 'model' } } }).ok).toBe(true);
  });
});

describe('ComfyUI websocket messages', () => {
  it('parses status, current node, sampling steps, completion and original execution errors', () => {
    expect(parseComfyUIProgress(JSON.stringify({ type: 'status', data: { status: { exec_info: { queue_remaining: 2 } } } }))).toMatchObject({ queueRemaining: 2 });
    expect(parseComfyUIProgress({ type: 'executing', data: { prompt_id: 'p', node: '3' } })).toMatchObject({ promptId: 'p', currentNode: '3' });
    expect(parseComfyUIProgress({ type: 'progress', data: { value: 2, max: 8, node: '3' } })).toMatchObject({ progress: 0.25, step: 2, totalSteps: 8 });
    expect(parseComfyUIProgress({ type: 'executed', data: { node: '9' } })).toMatchObject({ type: 'executed', currentNode: '9' });
    expect(parseComfyUIProgress({ type: 'executing', data: { node: null } })).toMatchObject({ completed: true, currentNode: null });
    expect(parseComfyUIProgress({ type: 'execution_error', data: { node: '3', exception_message: 'CUDA out of memory' } })).toMatchObject({ error: 'CUDA out of memory', currentNode: '3' });
  });

  it('ignores binary, invalid JSON and unknown events without manufacturing progress', () => {
    for (const value of [new Uint8Array([1, 2]), '{', { type: 'other', data: {} }]) expect(parseComfyUIProgress(value)).toBeNull();
    expect(parseComfyUIProgress({ type: 'progress', data: { value: 1, max: 0 } })?.progress).toBeUndefined();
  });
});
