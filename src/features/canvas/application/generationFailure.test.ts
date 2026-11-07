import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CANVAS_NODE_TYPES, type CanvasNode } from '../domain/canvasNodes';
import { CanvasGenerationFacade } from './canvasGenerationFacade';
import { classifyGenerationFailure } from './generationErrorReport';

describe('structured generation failures', () => {
  it.each(['input_moderation', 'output_moderation'] as const)('retains explicit provider %s and refuses a paid retry', (category) => {
    expect(classifyGenerationFailure({ failure_reason: category, retryable: true,
      message: 'Temporary server failure' })).toEqual({ category, retryable: false, moderation: true });
    expect(classifyGenerationFailure(JSON.stringify({ data: { failure_reason: category } })))
      .toEqual({ category, retryable: false, moderation: true });
  });

  it('prioritizes structured direction over conflicting display prose and reads Error causes', () => {
    expect(classifyGenerationFailure({ failure_reason: 'output_moderation', message: 'input_moderation' }))
      .toEqual({ category: 'output_moderation', retryable: false, moderation: true });
    const failure = new Error('Request rejected');
    Object.defineProperty(failure, 'cause', { value: { reason: 'input_moderation' } });
    expect(classifyGenerationFailure(failure))
      .toEqual({ category: 'input_moderation', retryable: false, moderation: true });
  });

  it('never guesses a direction or enables retry for unspecified moderation', () => {
    for (const evidence of [
      { code: 'content_policy_violation', retryable: true },
      { category: 'moderation', message: '输入或输出未通过内容审核', retryable: true },
      { message: 'safety_filter blocked the result', retryable: true },
    ]) {
      expect(classifyGenerationFailure(evidence)).toEqual({ category: 'error', retryable: false, moderation: true });
    }
  });

  it('requires explicit retry evidence for other errors and never classifies prompt or credential values', () => {
    expect(classifyGenerationFailure({ category: 'upstream', retryable: true, message: 'HTTP 503' }))
      .toEqual({ category: 'error', retryable: true, moderation: false });
    expect(classifyGenerationFailure('HTTP 503')).toEqual({ category: 'error', retryable: false, moderation: false });
    expect(classifyGenerationFailure(JSON.stringify({ prompt: 'output_moderation', apiKey: 'input_moderation',
      extraParams: { failure_reason: 'input_moderation' }, message: 'Connection failed' })))
      .toEqual({ category: 'error', retryable: false, moderation: false });
  });

  it('accepts old plain failure strings and safely terminates circular/malformed evidence', () => {
    expect(classifyGenerationFailure('provider rejected output_moderation')).toMatchObject({ category: 'output_moderation' });
    expect(classifyGenerationFailure('输入违规')).toMatchObject({ category: 'input_moderation' });
    const error: Record<string, unknown> = { message: 'Network unavailable' };
    error.cause = error;
    expect(classifyGenerationFailure(error)).toEqual({ category: 'error', retryable: false, moderation: false });
    expect(classifyGenerationFailure('{not-json')).toEqual({ category: 'error', retryable: false, moderation: false });
  });

  it('projects persisted provider reasons through the real source/result status without changing the original task', () => {
    const persisted = z.object({ generationError: z.string(), generationErrorDetails: z.string() }).parse(JSON.parse(JSON.stringify({
      generationError: 'Provider rejected the result', generationErrorDetails: JSON.stringify({ failure_reason: 'output_moderation' }),
    })));
    const source: CanvasNode = { id: 'source', type: CANVAS_NODE_TYPES.imageEdit,
      position: { x: 0, y: 0 }, data: { prompt: 'Original prompt' } };
    const result: CanvasNode = { id: 'result', type: CANVAS_NODE_TYPES.exportImage,
      position: { x: 600, y: 0 }, data: { ...persisted, imageUrl: null, aspectRatio: '1:1',
        generationJobId: 'original-task', generationJobState: 'failed' } };
    const status = new CanvasGenerationFacade().getStatus([source, result],
      [{ id: 'provenance', source: 'source', target: 'result' }], { nodeId: 'source' });
    expect(status).toMatchObject({ status: 'failed', jobId: 'original-task', resultNodeIds: ['result'],
      failure: { category: 'output_moderation', retryable: false, moderation: true } });
    expect(result.data.generationJobId).toBe('original-task');
  });

  it('keeps unknown and active tasks non-retryable even if provider metadata permits a retry', () => {
    for (const generationJobState of ['unknown', 'recoverable_wait', 'running'] as const) {
      const result: CanvasNode = { id: 'result', type: CANVAS_NODE_TYPES.exportImage,
        position: { x: 0, y: 0 }, data: { imageUrl: null, aspectRatio: '1:1', generationJobState,
          generationJobId: 'paid-task', generationError: 'Network unavailable',
          generationFailure: { category: 'error', retryable: true, moderation: false } } };
      expect(new CanvasGenerationFacade().getStatus([result], [], { nodeId: 'result' }))
        .toMatchObject({ status: generationJobState, jobId: 'paid-task', failure: { retryable: false } });
    }
  });

  it('does not expose a stale failure on a succeeded result', () => {
    const result: CanvasNode = { id: 'result', type: CANVAS_NODE_TYPES.exportImage,
      position: { x: 0, y: 0 }, data: { imageUrl: '/durable/recovered.png', aspectRatio: '1:1', generationJobState: 'succeeded',
        generationFailure: { category: 'input_moderation', retryable: false, moderation: true } } };
    expect(new CanvasGenerationFacade().getStatus([result], [], { nodeId: 'result' }))
      .toMatchObject({ status: 'succeeded', failure: null });
  });
});
