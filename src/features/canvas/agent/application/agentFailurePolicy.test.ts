import { describe, expect, it } from 'vitest';
import { classifyCanvasAgentFailure, redactAgentRunError } from './agentFailurePolicy';

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
    'You exceeded your current quota, please check your plan and billing details.',
    'insufficient_quota',
    'organization_spend_limit_exceeded',
    '余额不足',
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
    'RESOURCE_EXHAUSTED: quota exhausted for quota metric',
    'Quota exceeded for requests per minute',
    '每分钟 token 配额已达上限',
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

  it.each([
    'The quota has been exceeded.',
    '当前账号配额不足',
    'Invalid stage_command arguments: quota exceeded in quoted note',
    '本项目 Agent 预算不足：剩余 0 credits。',
    '本回合已达到 96 次工具调用上限，已安全停止。',
  ])('does not infer provider billing from an ambiguous or local failure: %s', message => {
    expect(classifyCanvasAgentFailure(new Error(message)).kind).toBe('generic');
  });

  it('preserves a WebKit-shaped storage exception through redaction and structured session feedback', () => {
    // DOMException need not share Error's prototype in a WebView realm.
    const original = { name: 'QuotaExceededError', message: 'The quota has been exceeded.', state: { private: 'MUST_NOT_COPY' } };
    const safe = redactAgentRunError(original);
    expect(safe.name).toBe('QuotaExceededError');
    expect(safe).not.toHaveProperty('state');
    expect(classifyCanvasAgentFailure(safe).kind).toBe('local-storage');
    expect(classifyCanvasAgentFailure(safe.failure)).toEqual({ kind: 'local-storage', rawMessage: original.message, canSelfDiagnose: false });
    expect(JSON.stringify(safe)).not.toContain('MUST_NOT_COPY');
  });

  it('uses explicit HTTP status and masks error evidence without copying raw provider objects', () => {
    const source = Object.assign(new Error('Unauthorized credential api_key=secret-value'), { status: 402, providerData: { authorization: 'SECRET' } });
    const safe = redactAgentRunError(source);
    expect(classifyCanvasAgentFailure(safe).kind).toBe('provider-quota');
    expect(safe.message).not.toContain('secret-value');
    expect(safe).not.toHaveProperty('providerData');
    expect(classifyCanvasAgentFailure(Object.assign(new Error('temporarily busy'), { status: 429 })).kind).toBe('provider-rate-limit');
  });
});
