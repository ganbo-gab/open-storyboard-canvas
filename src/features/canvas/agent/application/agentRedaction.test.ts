import { describe, expect, it } from 'vitest';
import { redactSensitiveValue, scanForSensitiveOutput } from './agentRedaction';

describe('agent redaction field boundary', () => {
  it('keeps numeric token counters visible but still hides credential-shaped token fields', () => {
    const value = {
      estimatedTokens: 1200,
      usage: { totalTokens: 42 },
      accessToken: 'secret-access',
      refreshTokens: 'secret-refresh',
      apiKey: 7,
    };
    expect(redactSensitiveValue(value)).toEqual({
      estimatedTokens: 1200,
      usage: { totalTokens: 42 },
      accessToken: '[configured]',
      refreshTokens: '[configured]',
      apiKey: '[configured]',
    });
    expect(scanForSensitiveOutput(value)).toEqual([
      '$.accessToken: secret-key',
      '$.refreshTokens: secret-key',
      '$.apiKey: secret-key',
    ]);
  });
});
