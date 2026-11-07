import { z } from 'zod';
import { redactSensitiveValue } from './agentRedaction';

export type CanvasAgentFailureKind = 'local-storage' | 'provider-quota' | 'provider-rate-limit' | 'generic';

export interface CanvasAgentFailurePolicy {
  kind: CanvasAgentFailureKind;
  rawMessage: string;
  canSelfDiagnose: boolean;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  const parsed = z.object({ message: z.string() }).safeParse(error);
  if (parsed.success) return parsed.data.message;
  return String(error);
}

const failureMetadataSchema = z.object({
  name: z.string().optional(), status: z.number().finite().optional(), code: z.union([z.string(), z.number()]).optional(),
  category: z.string().optional(), upstreamMessage: z.string().optional(),
});
const failurePolicySchema = z.object({
  kind: z.enum(['local-storage', 'provider-quota', 'provider-rate-limit', 'generic']),
  rawMessage: z.string(), canSelfDiagnose: z.boolean(),
});

/** Keep the diagnosis through controller redaction without carrying SDK state, causes or raw bodies. */
export function redactAgentRunError(error: unknown): Error & { failure: CanvasAgentFailurePolicy } {
  const failure = classifyCanvasAgentFailure(error);
  const metadata = failureMetadataSchema.safeParse(error);
  const safe = new Error(redactSensitiveValue(failure.rawMessage));
  safe.name = metadata.success ? metadata.data.name ?? 'Error' : 'Error';
  return Object.assign(safe, { failure: { ...failure, rawMessage: safe.message } });
}

/**
 * Decides whether another turn on the currently selected Agent model can
 * reasonably diagnose a failed run. Provider quota failures cannot: retrying
 * the same text model only creates another identical failure and may start
 * concurrent turns when the action is clicked repeatedly.
 */
export function classifyCanvasAgentFailure(error: unknown): CanvasAgentFailurePolicy {
  const previous = failurePolicySchema.safeParse(error);
  if (previous.success) return previous.data;
  const wrapped = z.object({ failure: failurePolicySchema }).safeParse(error);
  if (wrapped.success) return wrapped.data.failure;
  const rawMessage = errorMessage(error);
  const normalized = rawMessage.toLowerCase();
  const parsed = failureMetadataSchema.safeParse(error);
  const metadata = parsed.success ? parsed.data : {};
  if (
    metadata.name === 'QuotaExceededError'
    || /(?:localstorage|local storage|web storage).{0,80}(?:quota|full|exceed)/i.test(normalized)
  ) {
    return {
      kind: 'local-storage',
      rawMessage,
      canSelfDiagnose: false,
    };
  }
  // A local tool/budget/turn limit can quote words such as "quota" in its
  // validation details. It is not evidence of the provider account's balance.
  const localFailure = /^(?:Invalid [\w.-]+ arguments:|本项目 Agent 预算不足|本回合已达到)/i.test(rawMessage)
    || ['AgentTurnLimitError', 'MaxTurnsExceededError', 'ZodError'].includes(metadata.name ?? '');
  if (localFailure) return { kind: 'generic', rawMessage, canSelfDiagnose: true };

  const evidence = [metadata.code, metadata.upstreamMessage, rawMessage].filter(Boolean).join('\n');
  // "Quota" and RESOURCE_EXHAUSTED are also used for per-minute tokens,
  // concurrency and capacity. Only explicit billing evidence selects this path.
  const providerQuota = metadata.status === 402 || metadata.category === 'balance'
    || /(?:insufficient[_ -]?(?:quota|balance|credit)|(?:organization|project)[_ -]?spend[_ -]?limit|billing[_ -]?(?:hard[_ -]?)?limit|(?:account[_ -]?)?(?:credit|balance)s?[_ -]?(?:exhausted|depleted)|(?:余额|可用余额|账户余额)(?:不足|耗尽)|(?:账单|充值额度|消费额度).{0,20}(?:不足|耗尽|上限)|(?:quota|配额).{0,80}(?:plan and billing|billing details|billing limit))/i.test(evidence);

  if (providerQuota) {
    return {
      kind: 'provider-quota',
      rawMessage,
      canSelfDiagnose: false,
    };
  }

  const providerRateLimit = metadata.status === 429
    || /(?:\b429\b|rate[_ -]?limit|too many requests|resource[_ -]?exhausted|requests? per (?:minute|second|day)|tokens? per (?:minute|second|day)|concurrent[_ -]?(?:requests|limit)|限流|并发.{0,12}(?:限制|上限)|每(?:分钟|秒|天).{0,20}(?:配额|限制|上限))/i.test(evidence);
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
