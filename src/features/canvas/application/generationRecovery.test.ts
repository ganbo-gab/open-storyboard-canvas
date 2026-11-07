import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CANVAS_NODE_TYPES, type CanvasNode } from '../domain/canvasNodes';
import { useCanvasStore } from '@/stores/canvasStore';
import { recoverPersistedGenerationResult } from './generationRecovery';

const { recoverCustomProviderJobMock } = vi.hoisted(() => ({
  recoverCustomProviderJobMock: vi.fn(),
}));

vi.mock('../infrastructure/providerGateway', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../infrastructure/providerGateway')>();
  return { ...actual, recoverCustomProviderJob: recoverCustomProviderJobMock };
});

function resultNode(id: string, jobId = 'job-1'): CanvasNode {
  return {
    id,
    type: CANVAS_NODE_TYPES.exportImage,
    position: { x: 0, y: 0 },
    data: {
      imageUrl: null,
      previewImageUrl: null,
      aspectRatio: '1:1',
      generationJobId: jobId,
      generationJobState: 'recoverable_wait',
      generationError: 'download failed',
      isGenerating: false,
    },
  } as CanvasNode;
}

describe('recoverPersistedGenerationResult', () => {
  beforeEach(() => {
    recoverCustomProviderJobMock.mockReset();
    useCanvasStore.setState({ nodes: [resultNode('result-1')], edges: [] });
  });

  it('publishes each recovered native output once with its own media kind and batch index', async () => {
    recoverCustomProviderJobMock.mockResolvedValue({ job_id: 'job-1', status: 'succeeded', media_type: 'video', result: '/local/movie.mp4', results: [
      { kind: 'video', source: '/local/movie.mp4' }, { kind: 'image', source: '/local/tail.png' }, { kind: 'audio', source: '/local/music.wav' },
    ] });
    const first = await recoverPersistedGenerationResult({ jobId: 'job-1' });
    expect(first.nodeIds).toHaveLength(3);
    const nodes = useCanvasStore.getState().nodes;
    expect(nodes.map((node) => node.type)).toEqual([CANVAS_NODE_TYPES.video, CANVAS_NODE_TYPES.exportImage, CANVAS_NODE_TYPES.audio]);
    expect(nodes.map((node) => node.data.batchIndex)).toEqual([0, 1, 2]);
    expect(nodes[0].data).toMatchObject({ videoUrl: '/local/movie.mp4' });
    expect(nodes[1].data).toMatchObject({ imageUrl: '/local/tail.png', generationLastJobId: 'job-1' });
    expect(nodes[2].data).toMatchObject({ audioUrl: '/local/music.wav', generationLastJobId: 'job-1' });
    await recoverPersistedGenerationResult({ jobId: 'job-1' });
    expect(useCanvasStore.getState().nodes).toHaveLength(3);
  });
  it('matches shared native-count placeholders to distinct outputs instead of copying the first', async () => {
    const nodes = [resultNode('one'), resultNode('two')];
    nodes.forEach((node, index) => { node.data.batchIndex = index; node.data.batchId = 'native'; });
    useCanvasStore.setState({ nodes, edges: [] });
    recoverCustomProviderJobMock.mockResolvedValue({ job_id: 'job-1', status: 'succeeded', media_type: 'image', result: '/local/one.png', results: [
      { kind: 'image', source: '/local/one.png' }, { kind: 'image', source: '/local/two.png' },
    ] });
    await recoverPersistedGenerationResult({ jobId: 'job-1' });
    expect(useCanvasStore.getState().nodes.map((node) => node.data.imageUrl)).toEqual(['/local/one.png', '/local/two.png']);
  });
  it('keeps a generation source editable when it retains the same legacy job handle as its result', async () => {
    const source = { id: 'source', type: CANVAS_NODE_TYPES.imageEdit, position: { x: 0, y: 0 }, data: { prompt: 'Keep my prompt', generationJobId: 'job-1' } } as CanvasNode;
    useCanvasStore.setState({ nodes: [source, resultNode('result-1')], edges: [] });
    recoverCustomProviderJobMock.mockResolvedValue({ job_id: 'job-1', status: 'succeeded', media_type: 'image', result: '/local/output.png' });
    expect((await recoverPersistedGenerationResult({ jobId: 'job-1' })).nodeIds).toEqual(['result-1']);
    expect(useCanvasStore.getState().nodes[0]).toEqual(source);
    expect(useCanvasStore.getState().nodes[1].data).toMatchObject({ imageUrl: '/local/output.png' });
  });
  it('does not perform recovery when the canvas node association is missing', async () => {
    await expect(recoverPersistedGenerationResult({ jobId: 'unrelated' }))
      .rejects.toThrow('当前画布没有');
    expect(recoverCustomProviderJobMock).not.toHaveBeenCalled();
  });

  it('projects a locally persisted image before reporting success', async () => {
    recoverCustomProviderJobMock.mockResolvedValue({
      job_id: 'job-1',
      status: 'succeeded',
      media_type: 'image',
      result: '/local/result.png',
      updated_at: 1234,
    });

    const result = await recoverPersistedGenerationResult({ jobId: 'job-1' });
    const node = useCanvasStore.getState().nodes[0];

    expect(result).toMatchObject({ status: 'succeeded', nodeIds: ['result-1'] });
    expect(node.data).toMatchObject({
      imageUrl: '/local/result.png',
      previewImageUrl: '/local/result.png',
      generationJobState: 'succeeded',
      generationLastJobId: 'job-1',
      generationJobId: null,
      generationError: null,
      isGenerating: false,
    });
  });

  it('does not report success when the durable result has no local media', async () => {
    recoverCustomProviderJobMock.mockResolvedValue({
      job_id: 'job-1',
      status: 'succeeded',
      media_type: 'image',
      result: null,
    });
    await expect(recoverPersistedGenerationResult({ jobId: 'job-1' }))
      .rejects.toThrow('结果尚未成功保存到本机');
  });
});
