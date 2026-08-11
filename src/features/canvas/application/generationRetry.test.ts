import { describe, expect, it, vi } from 'vitest';

import { CANVAS_NODE_TYPES, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import {
  buildRetryGenerationFetchPatch,
  canRetryGenerationFetch,
} from './generationRetry';

function failedResultNode(data: Record<string, unknown>): CanvasNode {
  return {
    id: 'result-1',
    type: CANVAS_NODE_TYPES.exportImage,
    position: { x: 0, y: 0 },
    data: {
      imageUrl: null,
      aspectRatio: '1:1',
      generationError: 'generation paused',
      isGenerating: false,
      generationJobId: 'local-job-1',
      ...data,
    },
  } as unknown as CanvasNode;
}

describe('generation safe recovery', () => {
  it.each(['unknown', 'recoverable_wait'] as const)(
    'does not offer %s recovery without an upstream handle or result URL',
    (generationJobState) => {
      expect(canRetryGenerationFetch(failedResultNode({
        generationJobState,
        generationSafeRecoveryAvailable: false,
      }))).toBe(false);
    },
  );

  it.each(['unknown', 'recoverable_wait'] as const)(
    'offers %s recovery only when the coordinator confirms it is safe',
    (generationJobState) => {
      expect(canRetryGenerationFetch(failedResultNode({
        generationJobState,
        generationSafeRecoveryAvailable: true,
      }))).toBe(true);
    },
  );

  it('allows rematerializing a saved result URL without a job id', () => {
    expect(canRetryGenerationFetch(failedResultNode({
      generationJobId: null,
      generationJobState: 'unknown',
      generationRetryResultUrl: 'https://cdn.example/result.png',
    }))).toBe(true);
  });

  it('marks a safe recovery request without changing the persisted job id', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_234);
    const patch = buildRetryGenerationFetchPatch(failedResultNode({
      generationJobState: 'recoverable_wait',
      generationSafeRecoveryAvailable: true,
    }));
    expect(patch).toMatchObject({
      isGenerating: true,
      generationRetryRequestedAt: 1_234,
      generationError: null,
    });
    expect(patch).not.toHaveProperty('generationJobId');
    vi.restoreAllMocks();
  });
});
