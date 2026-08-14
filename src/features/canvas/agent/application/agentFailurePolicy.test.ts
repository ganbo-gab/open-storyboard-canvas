import { describe, expect, it } from 'vitest';
import { classifyCanvasAgentFailure } from './agentFailurePolicy';

describe('classifyCanvasAgentFailure', () => {
  it('distinguishes WebKit localStorage exhaustion from an upstream model quota', () => {
    expect(classifyCanvasAgentFailure(
      new DOMException('The quota has been exceeded.', 'QuotaExceededError'),
    )).toEqual({
      kind: 'local-storage',
      rawMessage: 'The quota has been exceeded.',
      canSelfDiagnose: false,
    });
  });

  it.each([
    'The quota has been exceeded.',
    'You exceeded your current quota, please check your plan and billing details.',
    'insufficient_quota',
    'RESOURCE_EXHAUSTED: quota exhausted for quota metric',
    '当前账号配额不足',
  ])('prevents the unavailable text model from diagnosing its own quota failure: %s', (message) => {
    expect(classifyCanvasAgentFailure(new Error(message))).toMatchObject({
      kind: 'provider-quota',
      rawMessage: message,
      canSelfDiagnose: false,
    });
  });

  it.each([
    'HTTP 429 Too Many Requests',
    'rate limit exceeded',
    '上游正在限流',
  ])('keeps transient rate limits distinct while suppressing same-model diagnosis: %s', (message) => {
    expect(classifyCanvasAgentFailure(new Error(message))).toMatchObject({
      kind: 'provider-rate-limit',
      rawMessage: message,
      canSelfDiagnose: false,
    });
  });

  it('keeps ordinary tool and network failures eligible for bounded diagnosis', () => {
    expect(classifyCanvasAgentFailure(new Error('job not found'))).toEqual({
      kind: 'generic',
      rawMessage: 'job not found',
      canSelfDiagnose: true,
    });
  });
});
