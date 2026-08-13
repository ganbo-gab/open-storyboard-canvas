import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CANVAS_NODE_TYPES, type CanvasNode } from '../domain/canvasNodes';
import { useCanvasStore } from '@/stores/canvasStore';
import { recoverPersistedGenerationResult } from './generationRecovery';

const { recoverCustomProviderJobMock } = vi.hoisted(() => ({
  recoverCustomProviderJobMock: vi.fn(),
}));

vi.mock('../infrastructure/customProviderGateway', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../infrastructure/customProviderGateway')>();
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
