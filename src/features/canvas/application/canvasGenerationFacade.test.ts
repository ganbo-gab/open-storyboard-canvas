import { describe, expect, it, vi } from 'vitest';

import { CANVAS_NODE_TYPES, type CanvasNode } from '../domain/canvasNodes';
import type { CanvasEventBus } from './ports';
import { CanvasGenerationFacade } from './canvasGenerationFacade';

function facade(): CanvasGenerationFacade {
  return new CanvasGenerationFacade({
    publish: vi.fn(),
    subscribe: vi.fn(() => () => undefined),
  } as unknown as CanvasEventBus);
}

describe('CanvasGenerationFacade job states', () => {
  it('preserves an unknown paid submission instead of flattening it to failed', () => {
    const node = {
      id: 'image-1',
      type: CANVAS_NODE_TYPES.imageEdit,
      position: { x: 0, y: 0 },
      data: {
        prompt: 'private prompt',
        generationJobId: 'job-unknown-1',
        generationJobState: 'unknown',
        generationError: '提交结果未知，不会自动重试',
        isGenerating: false,
      },
    } as unknown as CanvasNode;

    expect(facade().getStatus([node], [], { jobId: 'job-unknown-1' })).toMatchObject({
      nodeId: 'image-1',
      jobId: 'job-unknown-1',
      status: 'unknown',
    });
  });

  it('reports materialization and recoverable waits as active job states', () => {
    for (const status of ['materializing', 'recoverable_wait'] as const) {
      const node = {
        id: `image-${status}`,
        type: CANVAS_NODE_TYPES.imageEdit,
        position: { x: 0, y: 0 },
        data: {
          generationJobId: `job-${status}`,
          generationJobState: status,
          isGenerating: true,
        },
      } as unknown as CanvasNode;
      expect(facade().getStatus([node], [], { nodeId: node.id })?.status).toBe(status);
    }
  });

  it('locates a completed result by its retained last job id', () => {
    const resultNode = {
      id: 'result-1',
      type: CANVAS_NODE_TYPES.exportImage,
      position: { x: 0, y: 0 },
      data: {
        imageUrl: '/generated/result.png',
        aspectRatio: '1:1',
        generationJobState: 'succeeded',
        generationLastJobId: 'job-completed-1',
      },
    } as unknown as CanvasNode;

    expect(facade().locateResultNodeId(
      [resultNode],
      [],
      { jobId: 'job-completed-1' },
    )).toBe('result-1');
  });

  it('tracks only the newest result cohort for a reusable generation input', () => {
    const source = {
      id: 'source-1',
      type: CANVAS_NODE_TYPES.imageEdit,
      position: { x: 0, y: 0 },
      data: {},
    } as unknown as CanvasNode;
    const staleRunning = {
      id: 'old-result',
      type: CANVAS_NODE_TYPES.exportImage,
      position: { x: 0, y: 0 },
      data: {
        isGenerating: true,
        generationJobState: 'running',
        generationStartedAt: 100,
      },
    } as unknown as CanvasNode;
    const latestSucceeded = {
      id: 'new-result',
      type: CANVAS_NODE_TYPES.exportImage,
      position: { x: 0, y: 0 },
      data: {
        imageUrl: '/generated/new.png',
        generationJobState: 'succeeded',
        generationStartedAt: 200,
      },
    } as unknown as CanvasNode;
    const edges = [
      { id: 'old-edge', source: source.id, target: staleRunning.id },
      { id: 'new-edge', source: source.id, target: latestSucceeded.id },
    ] as any;

    expect(facade().getStatus(
      [source, staleRunning, latestSucceeded],
      edges,
      { nodeId: source.id },
    )).toMatchObject({
      status: 'succeeded',
      resultNodeId: latestSucceeded.id,
      resultNodeIds: [latestSucceeded.id],
    });
  });

  it('keeps every result in the newest multi-image batch together', () => {
    const source = {
      id: 'source-batch',
      type: CANVAS_NODE_TYPES.imageEdit,
      position: { x: 0, y: 0 },
      data: {},
    } as unknown as CanvasNode;
    const nodes = [
      source,
      ...['old', 'new-a', 'new-b'].map((id, index) => ({
        id,
        type: CANVAS_NODE_TYPES.exportImage,
        position: { x: 0, y: 0 },
        data: index === 0
          ? { generationJobState: 'running', batchId: 'old-batch', generationStartedAt: 100 }
          : { imageUrl: `/${id}.png`, generationJobState: 'succeeded', batchId: 'new-batch', generationStartedAt: 200 },
      } as unknown as CanvasNode)),
    ];
    const edges = nodes.slice(1).map((node) => ({ id: `edge-${node.id}`, source: source.id, target: node.id })) as any;

    expect(facade().getStatus(nodes, edges, { nodeId: source.id })).toMatchObject({
      status: 'succeeded',
      resultNodeIds: ['new-a', 'new-b'],
    });
  });
});
