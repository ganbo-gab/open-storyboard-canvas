export type CanvasAgentFailureKind = 'local-storage' | 'provider-quota' | 'provider-rate-limit' | 'generic';

export interface CanvasAgentFailurePolicy {
  kind: CanvasAgentFailureKind;
  rawMessage: string;
  canSelfDiagnose: boolean;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Decides whether another turn on the currently selected Agent model can
 * reasonably diagnose a failed run. Provider quota failures cannot: retrying
 * the same text model only creates another identical failure and may start
 * concurrent turns when the action is clicked repeatedly.
 */
export function classifyCanvasAgentFailure(error: unknown): CanvasAgentFailurePolicy {
  const rawMessage = errorMessage(error);
  const normalized = rawMessage.toLowerCase();
  const errorName = error && typeof error === 'object' && 'name' in error
    ? String((error as { name?: unknown }).name ?? '')
    : '';
  if (
    errorName === 'QuotaExceededError'
    || /(?:localstorage|local storage|web storage).{0,80}(?:quota|full|exceed)/i.test(normalized)
  ) {
    return {
      kind: 'local-storage',
      rawMessage,
      canSelfDiagnose: false,
    };
  }
  const providerQuota = /(?:quota[_ -]?exceeded|insufficient[_ -]?quota|resource[_ -]?exhausted|quota.{0,40}(?:exceed|exhaust|deplet)|(?:exceed|exhaust|deplet).{0,40}quota|配额)/i
    .test(normalized);

  if (providerQuota) {
    return {
      kind: 'provider-quota',
      rawMessage,
      canSelfDiagnose: false,
    };
  }

  const providerRateLimit = /(?:\b429\b|rate[_ -]?limit|too many requests|限流)/i.test(normalized);
  if (providerRateLimit) {
    return {
      kind: 'provider-rate-limit',
      rawMessage,
      canSelfDiagnose: false,
    };
  }

  return {
    kind: 'generic',
    rawMessage,
    canSelfDiagnose: true,
  };
}
